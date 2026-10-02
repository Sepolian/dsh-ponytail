import assert from 'node:assert/strict'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import Skills, { BUNDLED_SKILL_RANK } from '@deepseek-ai/dsh-skill'
import { FileSystemSkillProvider } from '@deepseek-ai/dsh-skill-filesystem'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { registerSkills } from '../dist/skills.js'

const upstreamSkills = fileURLToPath(new URL('../vendor/ponytail/skills/', import.meta.url))

test('real DSH registry loads every upstream skill unchanged and disposes the provider', async () => {
  const ctx = new Context()
  await ctx.plugin(Skills)
  const control = new AbortController()
  const native = new FileSystemSkillProvider(ctx, { signal: control.signal, invalidate() {} }, {
    providerName: 'ponytail', includeDefaultRoots: false, bundledSkillDir: upstreamSkills, watch: false,
  })
  try {
    let candidates
    const fiber = ctx.plugin({
      name: 'test-ponytail-skills', inject: ['skills'],
      async apply(pluginCtx) { candidates = await registerSkills(pluginCtx, upstreamSkills) },
    })
    await fiber
    const names = (await readdir(upstreamSkills, { withFileTypes: true }))
      .filter(entry => entry.isDirectory()).map(entry => entry.name).sort()
    assert.deepEqual(candidates.map(skill => skill.name).sort(), names)
    const nativeCandidates = await native.list({})
    for (const candidate of candidates) {
      const original = nativeCandidates.find(skill => skill.name === candidate.name)
      const policy = candidate.name === 'ponytail'
        ? { ...original.invocation, modelInvocable: false } : original.invocation
      assert.deepEqual(candidate, { ...original, invocation: policy })
      assert.equal(candidate.rank, BUNDLED_SKILL_RANK)
      const loaded = await ctx.skills.get(candidate.name)
      const originalBody = await native.get(original, {})
      assert.deepEqual(loaded, { ...originalBody, invocation: policy })
      assert.deepEqual(loaded.resourceBase, { kind: 'directory', path: join(upstreamSkills, candidate.name) })
    }
    assert.equal((await ctx.skills.list()).find(skill => skill.name === 'ponytail').invocation.modelInvocable, false)
    ctx.skills.register({ name: 'ponytail-review', description: 'Local override', source: 'runtime', content: 'Local body' })
    assert.equal((await ctx.skills.get('ponytail-review')).content, 'Local body')
    await fiber.dispose()
    assert.deepEqual((await ctx.skills.list()).map(skill => skill.name), ['ponytail-review'])
  } finally {
    control.abort()
    await native.dispose()
    await ctx.fiber.dispose()
  }
})

test('native metadata, CRLF and invocation flags survive automatic discovery of a future skill', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ponytail-skills-'))
  const ctx = new Context()
  await ctx.plugin(Skills)
  try {
    for (const name of ['ponytail', 'future-skill']) await mkdir(join(root, name))
    await writeFile(join(root, 'ponytail', 'SKILL.md'), '---\nname: ponytail\ndescription: Main\nuser-invocable: false\n---\nMain body\n')
    await writeFile(join(root, 'future-skill', 'SKILL.md'), [
      '---', 'name: future-skill', 'description: >', '  Future metadata', '  still works.',
      'whenToUse: On request', 'disable-model-invocation: true', 'user-invocable: false',
      'metadata:', '  audience: maintainer', '---', 'Future body', '',
    ].join('\r\n'))
    const candidates = await registerSkills(ctx, root)
    assert.deepEqual(candidates.map(skill => skill.name).sort(), ['future-skill', 'ponytail'])
    for (const skill of candidates) assert.deepEqual(skill.invocation, { modelInvocable: false, userInvocable: false })
    const loaded = await ctx.skills.get('future-skill')
    assert.equal(loaded.description, 'Future metadata still works.\n')
    assert.equal(loaded.whenToUse, 'On request')
    assert.deepEqual(loaded.metadata, { audience: 'maintainer' })
    assert.equal(loaded.content, 'Future body')
    assert.deepEqual(loaded.resourceBase, { kind: 'directory', path: join(root, 'future-skill') })
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('missing and malformed bundle assets fail startup and leave no provider registration', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ponytail-bad-skills-'))
  const ctx = new Context()
  await ctx.plugin(Skills)
  try {
    await assert.rejects(registerSkills(ctx, join(root, 'missing')), /ENOENT/)
    await assert.rejects(registerSkills(ctx, root), /skill directory is empty/)
    await mkdir(join(root, 'ponytail'))
    await assert.rejects(registerSkills(ctx, root), /Missing or malformed.*ponytail\/SKILL.md/)
    await writeFile(join(root, 'ponytail', 'SKILL.md'), '---\nname: Bad_Name\ndescription: Broken\n---\nBody\n')
    await assert.rejects(registerSkills(ctx, root), /Missing or malformed/)
    assert.deepEqual(await ctx.skills.list(), [])
    await writeFile(join(root, 'ponytail', 'SKILL.md'), '---\nname: ponytail\ndescription: Repaired\n---\nBody\n')
    const candidates = await registerSkills(ctx, root)
    assert.equal(candidates.length, 1)
    assert.equal((await ctx.skills.get('ponytail')).content, 'Body')
  } finally {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})
