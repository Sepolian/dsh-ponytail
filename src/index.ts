import type { Context } from '@deepseek-ai/cordis'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { renderSkillContent } from '@deepseek-ai/dsh-skill'
import { defineDomain } from '@deepseek-ai/dsh-storage-domain'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { join } from 'node:path'
import { z } from 'zod'
import { ModeStore } from './modes.js'
import { registerSkills } from './skills.js'
import { MODES, UPSTREAM_ROOT, isDeactivationCommand, renderInstructions, verifyVendoredAssets } from './upstream.js'
import type { PonytailMode } from './upstream.js'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'ponytail-mode': { kind: 'ponytail-mode' }
  }
}

export const name = 'ponytail'
export const inject = ['agents', 'systemPrompt', 'skills', 'storageDomain']

const modeSchema = z.enum(MODES)
const defaultSpec = defineDomain({
  name: 'ponytail', version: 1, tables: {},
  global: { schema: modeSchema, initial: 'full' as PonytailMode },
})
const usage = 'Usage: /ponytail [lite|full|ultra|off|default [lite|full|ultra|off]]'

function notice(agent: Agent, mode: PonytailMode): void {
  agent.inject(createUserMessage({
    content: [{ type: 'text', text: mode === 'off' ? 'PONYTAIL MODE OFF' : `PONYTAIL MODE ACTIVE — level: ${mode}` }],
    source: { kind: 'ponytail-mode' },
  }))
}

function deactivates(message: UserMessage): boolean {
  return message.source.kind === 'user' && isDeactivationCommand(
    message.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
  )
}

function assertActive(ctx: Context, agent: Agent, signal: AbortSignal): void {
  signal.throwIfAborted()
  if (ctx.agents.get(agent.id) !== agent) throw new Error('Ponytail command agent is no longer live')
}

function status(store: ModeStore, domain: Domain<typeof defaultSpec>, agent: Agent): CommandResult {
  return {
    kind: 'success',
    text: `Current effective mode: ${store.modeFor(agent)}\nSession override: ${store.overrides.get(agent.id) ?? 'none'}\nPersistent default: ${domain.global.get()}`,
  }
}

async function queueSkill(ctx: Context, invocation: CommandInvocation, skillName: string): Promise<CommandResult> {
  assertActive(ctx, invocation.agent, invocation.signal)
  const skill = await ctx.skills.get(skillName, {
    cwd: invocation.agent.session.header.cwd, signal: invocation.signal, scope: invocation.agent,
  })
  assertActive(ctx, invocation.agent, invocation.signal)
  if (!skill || !skill.invocation.userInvocable) return { kind: 'error', text: `Skill is unavailable: ${skillName}` }
  const notes = invocation.rawInput.trim()
  invocation.agent.followup(createUserMessage({
    content: [{ type: 'text', text: renderSkillContent(skill) + (notes ? `\n\n${notes}` : '') }],
    source: { kind: 'skill-invocation', name: skillName, form: 'instructions' },
  }))
  return { kind: 'success', text: `Queued ${skillName}.` }
}

/** Mount upstream instructions, native skills/commands, and process-local session state. */
export async function apply(ctx: Context): Promise<void> {
  verifyVendoredAssets()
  let domain!: Domain<typeof defaultSpec>
  await ctx.effect(async () => {
    const opened = await ctx.storageDomain.open(defaultSpec)
    domain = opened
    return () => opened.close()
  }, 'ponytail persistent default')
  const store = new ModeStore(() => domain.global.get())
  ctx.effect(() => () => { store.overrides.clear() }, 'ponytail runtime modes')

  ctx.on('agent/created', ({ agent }) => {
    const { parentSession, origin } = agent.session.header
    if (origin !== 'subagent' || parentSession === undefined) return
    const parent = ctx.agents.get(parentSession)
    if (parent && ctx.agents.isOwnedBy(agent.id, parent)) {
      store.overrides.set(agent.id, store.modeFor(parent))
    }
  })
  ctx.on('agent/disposed', ({ agent }) => { store.overrides.delete(agent.id) })
  // Inbox claim precedes prompt assembly; pre-step runs after the prompt was assembled.
  ctx.on('agent/inbox/claimed', ({ agent, message }) => {
    if (deactivates(message)) store.overrides.set(agent.id, 'off')
  })
  ctx.systemPrompt.section({
    name, order: 40, interpolate: false,
    text: ({ agent }) => agent ? renderInstructions(store.modeFor(agent)) : '',
  })

  const skills = await registerSkills(ctx, join(UPSTREAM_ROOT, 'skills'))
  ctx.inject(['commands'], (commandCtx) => {
    const lifetime = new AbortController()
    commandCtx.effect(() => () => { lifetime.abort(new Error('Ponytail commands were disposed')) })
    const commandSignal = (signal: AbortSignal): AbortSignal => AbortSignal.any([signal, lifetime.signal])
    commandCtx.commands.register({
      name, description: 'Show or change Ponytail session mode and persistent default',
      input: { hint: '[lite|full|ultra|off|default [mode]]' },
      async handler({ agent, rawInput, signal }): Promise<CommandResult> {
        signal = commandSignal(signal)
        assertActive(commandCtx, agent, signal)
        const args = rawInput.trim().toLowerCase().split(/\s+/).filter(Boolean)
        if (args.length === 0 || (args.length === 1 && args[0] === 'status')) return status(store, domain, agent)
        const previous = store.modeFor(agent)
        if (args[0] === 'default' && args.length === 1) {
          store.overrides.delete(agent.id)
        } else if (args[0] === 'default' && args.length === 2) {
          const parsed = modeSchema.safeParse(args[1])
          if (!parsed.success) return { kind: 'error', text: usage }
          try {
            await domain.global.set(parsed.data)
          } catch (error) {
            return { kind: 'error', text: `Could not save Ponytail default: ${String(error)}` }
          }
          assertActive(commandCtx, agent, signal)
        } else if (args.length === 1) {
          const parsed = modeSchema.safeParse(args[0])
          if (!parsed.success) return { kind: 'error', text: usage }
          store.overrides.set(agent.id, parsed.data)
        } else {
          return { kind: 'error', text: usage }
        }
        const current = store.modeFor(agent)
        if (current !== previous) notice(agent, current)
        return status(store, domain, agent)
      },
    })
    for (const skill of skills) {
      if (skill.name === name || !skill.invocation.userInvocable) continue
      commandCtx.commands.register({
        name: skill.name, description: skill.description, input: { hint: '[notes]' },
        handler: invocation => queueSkill(commandCtx, { ...invocation, signal: commandSignal(invocation.signal) }, skill.name),
      })
    }
  })

  ctx.on('agent/pre-step', async (payload, next): Promise<PreStepDecision> => {
    const deactivated = payload.messages.some(deactivates)
    const decision = await next()
    if (!deactivated || decision.kind !== 'enter') return decision
    return {
      ...decision,
      messages: [...decision.messages, createUserMessage({
        content: [{ type: 'text', text: 'PONYTAIL MODE OFF' }], source: { kind: 'ponytail-mode' },
      })],
    }
  })
}
