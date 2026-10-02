import assert from 'node:assert/strict'
import test from 'node:test'
import Commands from '@deepseek-ai/dsh-commands'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRuntime } from './helpers/runtime.mjs'
import * as Ponytail from '../dist/index.js'

async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-ponytail-lifecycle-'))
  const runtime = await createRuntime(directory)
  t.after(async () => {
    await runtime.close()
    await rm(directory, { recursive: true, force: true })
  })
  return { ...runtime, directory }
}

function delayedSkill(ctx, t) {
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  t.after(() => release.resolve())
  const skill = {
    name: 'ponytail-review', description: 'Delayed native skill provider', source: 'custom',
    provider: 'lifecycle-delay', invocation: { modelInvocable: true, userInvocable: true },
  }
  ctx.skills.registerProvider(() => ({
    name: skill.provider,
    async list() { return [{ ...skill, rank: 1, locator: null }] },
    async get() {
      started.resolve()
      // Deliberately ignore caller cancellation to verify the adapter's late continuation guard.
      await release.promise
      return { ...skill, content: 'Review the current diff.' }
    },
  }))
  return { started: started.promise, release: () => release.resolve() }
}

function countFollowups(agent) {
  let count = 0
  const original = agent.followup
  agent.followup = function (message) {
    count++
    return original.call(this, message)
  }
  return () => count
}

function captured(promise) {
  return promise.then(result => ({ result }), error => ({ error }))
}

test('a delayed native skill cannot queue model work after Ponytail unload', async t => {
  const runtime = await setup(t)
  const { agent } = await runtime.create('plugin-unload')
  const followups = countFollowups(agent)
  const slow = delayedSkill(runtime.ctx, t)
  const pending = captured(runtime.command(agent, '/ponytail-review'))
  await slow.started
  await runtime.ponytail.dispose()
  slow.release()
  const outcome = await pending
  assert(outcome.error instanceof Error)
  assert.match(outcome.error.message, /disposed|abort/i)
  await agent.whenIdle()
  assert.equal(followups(), 0)
  assert.equal(runtime.adapter.requests.length, 0)
  assert.equal(agent.inbox.nextTurn.length, 0)
})

test('a delayed native skill cannot deliver to a disposed agent or its same-id replacement', async t => {
  const runtime = await setup(t)
  const handle = await runtime.create('agent-replacement')
  const followups = countFollowups(handle.agent)
  const slow = delayedSkill(runtime.ctx, t)
  const pending = captured(runtime.command(handle.agent, '/ponytail-review'))
  await slow.started
  await handle.dispose()
  const replacement = await runtime.create('agent-replacement')
  assert.notEqual(replacement.agent, handle.agent)
  slow.release()
  const outcome = await pending
  assert(outcome.error instanceof Error)
  assert.match(outcome.error.message, /no longer live|disposed|unavailable/i)
  await replacement.agent.whenIdle()
  assert.equal(followups(), 0)
  assert.equal(runtime.adapter.requests.length, 0)
  assert.equal(replacement.agent.inbox.nextTurn.length, 0)
  assert.match((await runtime.command(replacement.agent, '/ponytail')).text, /Session override: none/)
})

test('removing the native command service cancels a previously captured skill handler', async t => {
  const runtime = await setup(t)
  const { agent } = await runtime.create('command-service-unload')
  const followups = countFollowups(agent)
  const slow = delayedSkill(runtime.ctx, t)
  const pending = captured(runtime.command(agent, '/ponytail-review'))
  await slow.started
  const [commandFiber] = runtime.ctx.registry.get(Commands).fibers
  await commandFiber.dispose()
  slow.release()
  const outcome = await pending
  assert(outcome.error instanceof Error)
  assert.match(outcome.error.message, /disposed|abort/i)
  await agent.whenIdle()
  assert.equal(followups(), 0)
  assert.equal(runtime.adapter.requests.length, 0)
  assert.equal(agent.inbox.nextTurn.length, 0)
})

test('unloading during native JSON domain opening releases the unit and permits remount', async t => {
  const runtime = await setup(t)
  await runtime.ponytail.dispose()
  const backend = runtime.ctx.storage.backend.get('json')
  const originalOpen = backend.kv.open
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  let unload
  backend.kv.open = async function (descriptor) {
    const unit = await originalOpen.call(this, descriptor)
    started.resolve()
    await release.promise
    return unit
  }
  try {
    const pending = runtime.ctx.plugin(Ponytail)
    const loading = captured(Promise.resolve(pending))
    await started.promise
    unload = pending.dispose()
    release.resolve()
    await unload
    await loading
    assert.equal(runtime.ctx.storageDomain.get('ponytail'), undefined)
    assert.deepEqual(await runtime.ctx.skills.list(), [])
    backend.kv.open = originalOpen
    const remounted = runtime.ctx.plugin(Ponytail)
    await remounted
    assert(runtime.ctx.storageDomain.get('ponytail'))
    const { agent } = await runtime.create('after-open-race')
    assert.match((await runtime.command(agent, '/ponytail')).text, /Current effective mode: full/)
  } finally {
    release.resolve()
    backend.kv.open = originalOpen
    await unload
  }
})

test('an accepted native default write drains during unload without a late mode injection', async t => {
  const runtime = await setup(t)
  await runtime.ponytail.dispose()
  const backend = runtime.ctx.storage.backend.get('json')
  const originalOpen = backend.kv.open
  const started = Promise.withResolvers()
  const release = Promise.withResolvers()
  let unload
  backend.kv.open = async function (descriptor) {
    const unit = await originalOpen.call(this, descriptor)
    const originalSet = unit.setGlobal
    unit.setGlobal = async function (value) {
      started.resolve()
      await release.promise
      return originalSet.call(this, value)
    }
    return unit
  }
  try {
    const remounted = runtime.ctx.plugin(Ponytail)
    await remounted
    backend.kv.open = originalOpen
    const { agent } = await runtime.create('accepted-write-unload')
    let injections = 0
    const originalInject = agent.inject
    agent.inject = function (message) {
      injections++
      return originalInject.call(this, message)
    }
    const pending = captured(runtime.command(agent, '/ponytail default lite'))
    await started.promise
    unload = remounted.dispose()
    await new Promise(resolve => setImmediate(resolve))
    release.resolve()
    const outcome = await pending
    assert(outcome.error instanceof Error)
    assert.match(outcome.error.message, /disposed|abort/i)
    await unload
    assert.equal(injections, 0)
    assert.equal(runtime.adapter.requests.length, 0)
    assert.equal(runtime.ctx.storageDomain.get('ponytail'), undefined)
    const saved = JSON.parse(await readFile(join(runtime.directory, 'ponytail.json'), 'utf8'))
    assert.equal(saved.global, 'lite', 'an already accepted durable write may complete during shutdown')
  } finally {
    release.resolve()
    backend.kv.open = originalOpen
    await unload
  }
})
