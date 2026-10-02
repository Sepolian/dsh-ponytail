import assert from 'node:assert/strict'
import test from 'node:test'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { createRuntime, requestPrompt, textOf } from './helpers/runtime.mjs'
import { renderInstructions } from '../dist/upstream.js'

const executeFile = promisify(execFile)

async function setup(t, options) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ponytail-runtime-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const runtime = await createRuntime(directory, options)
  t.after(() => runtime.close())
  return { ...runtime, directory }
}

function status(mode, override = mode, defaultMode = 'full') {
  return `Current effective mode: ${mode}\nSession override: ${override}\nPersistent default: ${defaultMode}`
}

test('two real live sessions isolate native commands, exact prompts, off and default reset', async t => {
  const runtime = await setup(t)
  const { agent: a } = await runtime.create('session-a')
  const { agent: b } = await runtime.create('session-b')
  assert.equal(await runtime.prompt(a), renderInstructions('full'))
  assert.equal((await runtime.command(a, '/ponytail')).text, status('full', 'none'))
  assert.equal((await runtime.command(a, '/ponytail status')).text, status('full', 'none'))

  const results = await Promise.all([
    runtime.command(a, '/ponytail ultra'), runtime.command(b, '/ponytail lite'),
  ])
  assert.deepEqual(results.map(result => result.text), [status('ultra'), status('lite')])
  const [requestA, requestB] = await Promise.all([runtime.send(a, 'request-a'), runtime.send(b, 'request-b')])
  assert.equal(requestPrompt(requestA), renderInstructions('ultra'))
  assert.equal(requestPrompt(requestB), renderInstructions('lite'))
  assert.equal(runtime.ctx.agents.list().length, 2)

  const requestCount = runtime.adapter.requests.length
  assert.equal((await runtime.command(a, '/ponytail off')).text, status('off'))
  await a.whenIdle()
  assert.equal(runtime.adapter.requests.length, requestCount, 'mode commands must not start model calls')
  assert.equal(await runtime.prompt(a), '')
  assert.equal(await runtime.prompt(b), renderInstructions('lite'))
  assert.equal(requestPrompt(await runtime.send(a, 'off-request')), '')
  assert.equal((await runtime.command(a, '/ponytail default')).text, status('full', 'none'))

  assert.equal((await runtime.command(a, '/ponytail default off')).text, status('off', 'none', 'off'))
  assert.equal(await runtime.prompt(a), '')
  assert.equal(await runtime.prompt(b), renderInstructions('lite'))
  const { agent: c } = await runtime.create('session-c')
  assert.equal((await runtime.command(c, '/ponytail')).text, status('off', 'none', 'off'))
  assert.equal((await runtime.command(a, '/ponytail default full')).text, status('full', 'none', 'full'))
  assert.equal(await runtime.prompt(c), renderInstructions('full'))

  for (const command of ['/ponytail imaginary', '/ponytail default imaginary', '/ponytail ultra extra']) {
    const result = await runtime.command(a, command)
    assert.equal(result.kind, 'error')
    assert.match(result.text, /^Usage:/)
    assert.equal(await runtime.prompt(a), renderInstructions('full'))
  }
  const lifecycle = a.session.snapshotEvents().filter(event => event.type.startsWith('command/'))
  assert.equal(lifecycle.length % 2, 0)
  for (let i = 0; i < lifecycle.length; i += 2) {
    assert.equal(lifecycle[i].type, 'command/run')
    assert.equal(lifecycle[i + 1].type, 'command/done')
    assert.equal(lifecycle[i].data.commandId, lifecycle[i + 1].data.commandId)
  }
})

test('persistent default survives a separate process and session override does not', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ponytail-restart-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const script = fileURLToPath(new URL('./helpers/restart.mjs', import.meta.url))
  for (const action of ['write', 'read']) {
    const { stdout } = await executeFile(process.execPath, [script, directory, action], { timeout: 20000 })
    assert.match(stdout, new RegExp(`RESTART_${action.toUpperCase()}_OK`))
  }
  const document = JSON.parse(await readFile(join(directory, 'ponytail.json'), 'utf8'))
  assert.equal(document.global, 'lite')
  assert.deepEqual(document.tables, {})
})

test('disposing and recreating the same real identity clears runtime overrides', async t => {
  const runtime = await setup(t)
  let disposed = 0
  runtime.ctx.on('agent/disposed', () => { disposed++ })
  for (let i = 0; i < 20; i++) {
    const handle = await runtime.create('reused-session-id')
    assert.equal((await runtime.command(handle.agent, '/ponytail')).text, status('full', 'none'))
    await runtime.command(handle.agent, '/ponytail ultra')
    assert.equal(await runtime.prompt(handle.agent), renderInstructions('ultra'))
    await handle.dispose()
    assert.equal(runtime.ctx.agents.get(handle.agent.id), undefined)
    assert.equal(runtime.ctx.agents.list().length, 0)
  }
  assert.equal(disposed, 20)
  const { agent } = await runtime.create('reused-session-id')
  assert.equal((await runtime.command(agent, '/ponytail')).text, status('full', 'none'))
})

test('standalone upstream deactivation changes the next real request only for its receiving session', async t => {
  const runtime = await setup(t)
  const { agent: a } = await runtime.create('deactivation-a')
  const { agent: b } = await runtime.create('deactivation-b')
  await runtime.command(b, '/ponytail lite')
  for (const text of ['Stop ponytail.', ' Normal mode!? ']) {
    await runtime.command(a, '/ponytail full')
    const request = await runtime.send(a, text)
    assert.equal(requestPrompt(request), '')
    assert(request.messages.some(message => textOf(message) === 'PONYTAIL MODE OFF'))
    assert.equal((await runtime.command(a, '/ponytail')).text, status('off'))
    assert.equal(await runtime.prompt(b), renderInstructions('lite'))
  }
  for (const text of ['add a normal mode toggle', 'Please explain "stop ponytail"', 'stop ponytail\nand implement this']) {
    await runtime.command(a, '/ponytail full')
    assert.equal(requestPrompt(await runtime.send(a, text)), renderInstructions('full'))
  }
  a.inject(createUserMessage({
    content: [{ type: 'text', text: 'normal mode' }],
    source: { kind: 'skill-invocation', name: 'ponytail-help', form: 'instructions' },
  }))
  const injected = await runtime.send(a, 'explain the injected text')
  assert(injected.messages.some(message => textOf(message) === 'normal mode'))
  assert.equal(requestPrompt(injected), renderInstructions('full'))
  assert.equal((await runtime.command(a, '/ponytail')).text, status('full'))
})

test('native skill commands respect the receiving agent scope and user invocation policy', async t => {
  const runtime = await setup(t)
  const { agent: a } = await runtime.create('scoped-skill-a')
  const { agent: b } = await runtime.create('scoped-skill-b')
  const registration = invocation => ({
    name: 'test-scoped-skill', inject: ['skills'],
    apply(ctx) {
      ctx.skills.register({
        name: 'ponytail-review', description: 'Only for this session', source: 'runtime',
        content: 'SCOPED_SKILL_BODY', invocation,
      })
    },
  })
  const scoped = a.ctx.plugin(registration({ modelInvocable: true, userInvocable: true }))
  await scoped
  const before = runtime.adapter.requests.length
  assert.equal((await runtime.command(a, '/ponytail-review scoped notes')).kind, 'success')
  await a.whenIdle()
  const request = runtime.adapter.requests.at(-1)
  assert.equal(runtime.adapter.requests.length, before + 1)
  assert(request.messages.some(message => textOf(message).includes('SCOPED_SKILL_BODY')))
  assert(request.messages.some(message => textOf(message).includes('scoped notes')))
  assert(!(await runtime.ctx.skills.get('ponytail-review', { scope: b })).content.includes('SCOPED_SKILL_BODY'))
  await scoped.dispose()

  await a.ctx.plugin(registration({ modelInvocable: false, userInvocable: false }))
  const count = runtime.adapter.requests.length
  assert.deepEqual(await runtime.command(a, '/ponytail-review'), {
    kind: 'error', text: 'Skill is unavailable: ponytail-review',
  })
  await a.whenIdle()
  assert.equal(runtime.adapter.requests.length, count)
})

test('owned native spawn and fork children snapshot mode and retain Ponytail with a child persona', async t => {
  const runtime = await setup(t)
  const [{ default: Subagents }, spawn, fork] = await Promise.all([
    import('@deepseek-ai/dsh-subagent'),
    import('@deepseek-ai/dsh-subagent-spawn-in-process'),
    import('@deepseek-ai/dsh-subagent-fork-in-process'),
  ])
  await runtime.ctx.plugin(Subagents)
  await runtime.ctx.plugin(spawn, { providerName: 'spawn' })
  await runtime.ctx.plugin(fork, { providerName: 'fork' })
  const { agent: parent } = await runtime.create('parent')
  await runtime.send(parent, 'completed-parent-turn')
  await runtime.command(parent, '/ponytail ultra')
  for (const provider of ['spawn', 'fork']) {
    const before = runtime.adapter.requests.length
    const run = await runtime.ctx.subagents.start(provider, {
      parent, prompt: [{ type: 'text', text: `child-${provider}` }], persona: 'Child persona.',
      signal: new AbortController().signal,
    })
    try {
      const child = runtime.ctx.agents.get(run.id)
      assert(child)
      assert(runtime.ctx.agents.isOwnedBy(child.id, parent))
      assert.equal(child.session.header.parentSession, parent.id)
      assert.equal((await runtime.command(child, '/ponytail')).text, status('ultra'))
      assert.equal((await run.result).stopReason, 'completed')
      const requests = runtime.adapter.requests.slice(before)
      assert.equal(requests.length, 1)
      assert.equal(requestPrompt(requests[0]), `Child persona.\n\n${renderInstructions('ultra')}`)
      await runtime.command(parent, '/ponytail lite')
      assert.equal(await runtime.prompt(child), `Child persona.\n\n${renderInstructions('ultra')}`)
      assert.equal(await runtime.prompt(parent), renderInstructions('lite'))
    } finally {
      await run.dispose()
      assert.equal(runtime.ctx.agents.get(run.id), undefined)
      await runtime.command(parent, '/ponytail ultra')
    }
  }
  const { agent: independent } = await runtime.create('historical-lineage-only', {
    meta: { origin: 'subagent', parentSession: parent.id },
  })
  assert.equal((await runtime.command(independent, '/ponytail')).text, status('full', 'none'))
  await runtime.command(parent, '/ponytail off')
  const offRun = await runtime.ctx.subagents.start('spawn', {
    parent, prompt: [{ type: 'text', text: 'off-child' }], signal: new AbortController().signal,
  })
  try {
    const child = runtime.ctx.agents.get(offRun.id)
    assert.equal((await offRun.result).stopReason, 'completed')
    assert.equal(await runtime.prompt(child), '')
    await runtime.command(parent, '/ponytail full')
    assert.equal(await runtime.prompt(child), '')
  } finally {
    await offRun.dispose()
  }
})

test('runtime works without command service and unloading removes every contribution', async t => {
  const runtime = await setup(t, { commands: false })
  const { agent } = await runtime.create('no-command-service')
  assert.equal(requestPrompt(await runtime.send(agent, 'without-commands')), renderInstructions('full'))
  assert((await runtime.ctx.skills.list()).length > 0)
  await runtime.ponytail.dispose()
  assert.equal(await runtime.prompt(agent), '')
  assert.deepEqual(await runtime.ctx.skills.list(), [])
  assert.equal(runtime.ctx.storageDomain.get('ponytail'), undefined)
})

test('native storage rejects a corrupt saved default with a concrete error', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ponytail-corrupt-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'ponytail.json'), JSON.stringify({
    unit: { name: 'ponytail', version: 1 }, global: 'invalid-mode', tables: {},
  }))
  await assert.rejects(createRuntime(directory), /global does not match its schema/)
})

test('a failed native durable write preserves the old default and later writes recover', async t => {
  const runtime = await setup(t)
  const { agent: a } = await runtime.create('write-failure-a')
  const { agent: b } = await runtime.create('write-failure-b')
  await runtime.command(a, '/ponytail ultra')
  const backup = `${runtime.directory}-backup`
  await rename(runtime.directory, backup)
  try {
    await writeFile(runtime.directory, 'This file prevents storage directory writes.')
    const result = await runtime.command(a, '/ponytail default lite')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /Could not save Ponytail default:/)
    assert.equal((await runtime.command(a, '/ponytail')).text, status('ultra'))
    assert.equal((await runtime.command(b, '/ponytail')).text, status('full', 'none'))
    assert.equal(await runtime.prompt(a), renderInstructions('ultra'))
    assert.equal(await runtime.prompt(b), renderInstructions('full'))
  } finally {
    await rm(runtime.directory, { force: true })
    await rename(backup, runtime.directory)
  }
  assert.equal((await runtime.command(b, '/ponytail default lite')).kind, 'success')
  assert.equal((await runtime.command(b, '/ponytail')).text, status('lite', 'none', 'lite'))
  assert.equal((await runtime.command(a, '/ponytail')).text, status('ultra', 'ultra', 'lite'))
})
