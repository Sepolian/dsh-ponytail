import type { Agent } from '@deepseek-ai/dsh-agent'
import type { PonytailMode } from './upstream.js'

/** Live overrides belong to agent identities; defaults are read from native storage. */
export class ModeStore {
  readonly overrides = new Map<Agent['id'], PonytailMode>()

  constructor(private readonly defaultMode: () => PonytailMode) {}

  modeFor(agent?: Agent): PonytailMode {
    return (agent && this.overrides.get(agent.id)) ?? this.defaultMode()
  }
}
