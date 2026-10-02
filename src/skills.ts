import type { Context } from '@deepseek-ai/cordis'
import type { SkillCandidate, SkillProvider, SkillSummary } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

function invocationPolicy<T extends SkillSummary>(skill: T): T {
  return skill.name === 'ponytail'
    ? { ...skill, invocation: { ...skill.invocation, modelInvocable: false } }
    : skill
}

/** Register native filesystem skills and return the bundled inventory for commands. */
export async function registerSkills(ctx: Context, skillsPath: string): Promise<readonly SkillCandidate[]> {
  const root = resolve(skillsPath)
  const entries = await readdir(root, { withFileTypes: true })
  const expected = entries.flatMap(entry => entry.isDirectory()
    ? [join(root, entry.name, 'SKILL.md')]
    : entry.isFile() && entry.name.endsWith('.md') ? [join(root, entry.name)] : [])
  if (expected.length === 0) throw new Error(`Ponytail skill directory is empty: ${root}`)

  let native!: FileSystemSkillProvider
  let provider!: SkillProvider
  const unregister = ctx.skills.registerProvider(control => {
    // ponytail: packaged assets are immutable; enable native watching if editable bundles become supported.
    native = new FileSystemSkillProvider(ctx, control, {
      providerName: 'ponytail', includeDefaultRoots: false, bundledSkillDir: root, watch: false,
    })
    provider = {
      name: native.name,
      async list(options) {
        options.signal?.throwIfAborted()
        const observation = await native.list(options)
        options.signal?.throwIfAborted()
        const candidates = Array.isArray(observation) ? observation : observation.candidates
        const discovered = new Set(candidates.map(skill => skill.path))
        for (const path of expected) {
          if (!discovered.has(path)) throw new Error(`Missing or malformed bundled Ponytail skill: ${path}`)
        }
        const adjusted = candidates.map(invocationPolicy)
        return Array.isArray(observation) ? adjusted : { ...observation, candidates: adjusted }
      },
      async get(candidate, options) {
        options.signal?.throwIfAborted()
        const skill = await native.get(candidate, options)
        options.signal?.throwIfAborted()
        if (skill === undefined || skill.content.trim() === '') {
          throw new Error(`Missing or malformed bundled Ponytail skill: ${candidate.path}`)
        }
        return invocationPolicy(skill)
      },
    }
    return provider
  })
  ctx.effect(function* () {
    yield async () => { await native.dispose() }
  }, 'ponytail skills')

  try {
    const observation = await provider.list({})
    const candidates = 'candidates' in observation ? observation.candidates : observation
    for (const candidate of candidates) await provider.get(candidate, {})
    if (!candidates.some(skill => skill.name === 'ponytail')) {
      throw new Error(`Bundled Ponytail main skill is missing: ${root}`)
    }
    return candidates
  } catch (error) {
    unregister()
    await native.dispose()
    throw error
  }
}
