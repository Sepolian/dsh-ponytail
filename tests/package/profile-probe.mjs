import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assembleContextFor } from '@deepseek-ai/dsh-agent'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'ponytail-package-probe'
export const inject = ['agents', 'commands', 'systemPrompt', 'skills', 'llm', 'webServer', 'connection']

/** Replace only model IO; the installed Web profile owns every other service. */
class LocalAdapter extends LlmAdapter {
  requests = []
  resolveModel(provider, id) { return Promise.resolve({ provider, id, name: id }) }
  async * stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function apply(ctx) {
  const adapter = new LocalAdapter()
  ctx.llm.registerAdapter(['package-probe'], adapter)
  const ready = ctx.get('appReady')
  const exit = ctx.get('appExit')
  assert(ready && exit, 'Official launcher readiness/exit services must be mounted')
  ctx.effect(() => ready.onReady(() => {
    void verify(ctx, adapter).then(() => exit(0), error => {
      console.error('PONYTAIL_PACKAGE_SMOKE_FAILED', error)
      exit(1)
    })
  }), 'package probe readiness')
}

async function verify(ctx, adapter) {
  const entry = [...ctx.get('loader').entries()].find(item => item.options.id === 'ponytail')
  assert(entry?.fiber, 'Profile Loader did not import the installed adapter')
  await entry.fiber.await()
  assert.equal(entry.fiber.state, 2, 'Installed Ponytail plugin must be ACTIVE')
  const packageDir = dirname(fileURLToPath(import.meta.resolve('dsh-ponytail/package.json')))
  assert(packageDir.includes('/profiles/web/node_modules/dsh-ponytail'), packageDir)
  const require = createRequire(import.meta.url)
  const { getPonytailInstructions } = require(join(packageDir, 'vendor/ponytail/hooks/ponytail-instructions.js'))
  const handles = []
  try {
    for (const id of ['package-a', 'package-b']) {
      handles.push(await ctx.agents.create({
        sessionId: SessionId(id), agentOptions: { provider: 'package-probe', model: 'local' },
        meta: { cwd: dirname(process.env.PONYTAIL_PACKAGE_PROBE_REPORT) },
      }))
    }
    const [a, b] = handles.map(handle => handle.agent)
    const prompt = async agent => (await ctx.systemPrompt.assemble(assembleContextFor(agent)))
      .sections.find(section => section.name === 'ponytail')?.text ?? ''
    const command = async (agent, line) => {
      const execution = await ctx.commands.execute(agent, line, [], new AbortController().signal)
      assert.equal(execution?.result.kind, 'success', line)
      return execution.result.text
    }
    assert.equal(await prompt(a), getPonytailInstructions('full'))
    assert.equal(await prompt(b), getPonytailInstructions('full'))
    await Promise.all([command(a, '/ponytail ultra'), command(b, '/ponytail lite')])
    assert.equal(await prompt(a), getPonytailInstructions('ultra'))
    assert.equal(await prompt(b), getPonytailInstructions('lite'))
    assert.match(await command(a, '/ponytail'), /Session override: ultra/)
    assert.match(await command(b, '/ponytail'), /Session override: lite/)
    await command(a, '/ponytail off')
    assert.equal(await prompt(a), '')
    assert.equal(await prompt(b), getPonytailInstructions('lite'))
    const catalog = (await ctx.skills.list()).filter(skill => skill.provider === 'ponytail')
    assert(catalog.length > 1, 'Installed upstream skill catalog is missing')
    for (const skill of catalog) {
      const loaded = await ctx.skills.get(skill.name)
      assert(loaded.content.length > 0)
      assert(loaded.resourceBase.path.startsWith(join(packageDir, 'vendor/ponytail/skills/')))
      if (skill.name === 'ponytail') assert.deepEqual(skill.invocation, { modelInvocable: false, userInvocable: true })
    }
    assert.equal(await command(b, '/ponytail-help'), 'Queued ponytail-help.')
    await Promise.all(handles.map(handle => handle.agent.whenIdle()))
    assert.equal(adapter.requests.length, 1, `Installed one-shot command must reach the local model adapter: ${JSON.stringify(b.session.snapshotEvents().filter(event => ['step/end', 'turn/end'].includes(event.type)))}`)
    const requestPrompt = adapter.requests[0].messages.filter(message => message.role === 'system')
      .flatMap(message => message.content.filter(block => block.type === 'text').map(block => block.text)).join('\n\n')
    assert(requestPrompt.includes(getPonytailInstructions('lite')), 'Installed model request must contain the exact upstream lite instructions')
    for (const handle of handles) {
      await handle.dispose()
      assert.equal(ctx.agents.get(handle.agent.id), undefined)
    }
    const webUrl = `http://${ctx.webServer.host}:${ctx.webServer.port}/`
    const exchange = await fetch(ctx.connection.authenticatedUrl(webUrl), {
      redirect: 'manual', signal: AbortSignal.timeout(5000),
    })
    assert.equal(exchange.status, 303, 'Native launch token must exchange for a browser cookie')
    const cookie = exchange.headers.getSetCookie().map(value => value.split(';')[0]).join('; ')
    assert(cookie, 'Native browser authentication cookie is missing')
    const response = await fetch(webUrl, { headers: { cookie }, signal: AbortSignal.timeout(5000) })
    assert.equal(response.status, 200, 'Official Web UI must serve its installed frontend')
    assert.match(await response.text(), /<html/i)
    const report = {
      profile: 'web', packageDir, active: true, sessions: 2,
      skills: catalog.map(skill => skill.name).sort(),
      modelRequests: adapter.requests.length, networkModelRequests: 0, httpStatus: response.status,
      checks: ['full-default', 'ultra-lite-isolation', 'native-commands', 'off', 'skills', 'one-shot-model', 'disposal', 'authenticated-web-http'],
    }
    await writeFile(process.env.PONYTAIL_PACKAGE_PROBE_REPORT, JSON.stringify(report, null, 2) + '\n')
    console.log('PONYTAIL_PACKAGE_SMOKE_OK', JSON.stringify(report))
  } finally {
    for (const handle of handles) await handle.dispose()
  }
}
