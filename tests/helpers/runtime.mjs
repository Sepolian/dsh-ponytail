import assert from 'node:assert/strict'
import { Context } from '@deepseek-ai/cordis'
import Agents, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import Llm, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import Skills from '@deepseek-ai/dsh-skill'
import Storage from '@deepseek-ai/dsh-storage'
import * as JsonStorage from '@deepseek-ai/dsh-storage-json'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import * as Ponytail from '../../dist/index.js'

/** Only the remote model is replaced; every host service and Agent is production DSH. */
export class CaptureAdapter extends LlmAdapter {
  requests = []

  resolveModel(provider, model) { return Promise.resolve({ provider, id: model, name: model }) }

  async * stream(options) {
    this.requests.push(options)
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'done' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

export function textOf(message) {
  return message.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

export function requestPrompt(request) {
  return request.messages.filter(message => message.role === 'system').map(textOf).join('\n\n')
}

export async function createRuntime(storageRoot, { commands = true } = {}) {
  const ctx = new Context()
  const adapter = new CaptureAdapter()
  try {
    await ctx.plugin(Llm)
    await ctx.plugin(Sessions)
    await ctx.plugin(Projections)
    await ctx.plugin(SystemPrompt, { includeHarnessIdentity: false, includeRuntimeContext: false })
    await ctx.plugin(Tools)
    await ctx.plugin(Agents)
    await ctx.plugin(Skills)
    await ctx.plugin(Storage)
    await ctx.plugin(JsonStorage, { root: storageRoot })
    await ctx.plugin(StorageDomain, { backend: 'json' })
    if (commands) await ctx.plugin(Commands)
    ctx.llm.registerAdapter(['capture'], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    const ponytail = ctx.plugin(Ponytail)
    await ponytail
    return {
      ctx, adapter, ponytail,
      async create(id, options = {}) {
        return ctx.agents.create({
          sessionId: SessionId(id), agentOptions: { provider: 'capture', model: 'capture' }, ...options,
        })
      },
      async command(agent, line, signal = new AbortController().signal) {
        const execution = await ctx.commands.execute(agent, line, [], signal)
        assert(execution, `Command not registered: ${line}`)
        return execution.result
      },
      async prompt(agent) { return renderPrompt(await ctx.systemPrompt.assemble(assembleContextFor(agent))) },
      async send(agent, text) {
        const before = adapter.requests.length
        agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
        await agent.whenIdle()
        const requests = adapter.requests.slice(before).filter(request => request.messages.some(message => textOf(message) === text))
        assert.equal(requests.length, 1, `Expected one real loop request for ${text}`)
        return requests[0]
      },
      async close() { await ctx.fiber.dispose() },
    }
  } catch (error) {
    await ctx.fiber.dispose()
    throw error
  }
}
