#!/usr/bin/env node
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('../', import.meta.url))
const artifactDir = join(root, '.runtime/artifacts')
const reportPath = join(root, '.runtime/package-verification.json')
const dshBin = join(root, '.runtime/node_modules/.bin/dsh')
const packageManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
await mkdir(artifactDir, { recursive: true })
await mkdir(dirname(reportPath), { recursive: true })
const work = await mkdtemp(join(root, '.runtime/package-check-'))
const environment = {
  ...Object.fromEntries(['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec',
    'PATHEXT', 'npm_config_registry', 'NPM_CONFIG_REGISTRY'].filter(name => process.env[name] !== undefined)
    .map(name => [name, process.env[name]])),
  DSH_HOME: join(work, 'home'), DSH_AGENTS_HOME: join(work, 'agents'),
  DSH_TELEMETRY_DISABLED: '1', XDG_CONFIG_HOME: join(work, 'config'),
  XDG_CACHE_HOME: join(work, 'cache'), XDG_DATA_HOME: join(work, 'data'),
  npm_config_cache: join(root, '.runtime/npm-cache'),
  PONYTAIL_PACKAGE_PROBE_REPORT: join(work, 'profile-probe.json'),
}
delete environment.DSH_BUNDLED_SKILL_DIR
delete environment.PONYTAIL_DEFAULT_MODE
let step = 0
const report = {
  completed: false, work, tarball: null, commands: [], checks: [],
  runtime: { node: process.version, dsh: JSON.parse(await readFile(join(root, '.runtime/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version },
}

function packInfo(text) {
  const parsed = JSON.parse(text)
  return Array.isArray(parsed) ? parsed[0] : parsed.filename ? parsed : Object.values(parsed)[0]
}

async function run(label, command, args, cwd = root, expectedFailure = false) {
  console.log(`verify-package: ${label}`)
  let result
  try {
    result = await execute(command, args, { cwd, env: environment, timeout: 45000, maxBuffer: 12 * 1024 * 1024 })
    result.code = 0
  } catch (error) {
    result = error
    if (!expectedFailure || typeof error.code !== 'number' || error.code === 0) throw error
  } finally {
    const log = join(work, `${++step}-${label.replaceAll(/[^a-z0-9]+/gi, '-')}.log`)
    await writeFile(log, `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`.replaceAll(/([?&]token=)[^\s&)]+/g, '$1[redacted]'))
    report.commands.push({ label, command, args, cwd, code: result?.code ?? null, log })
  }
  if (expectedFailure) assert.notEqual(result.code, 0, `${label} unexpectedly succeeded`)
  return result
}

// npm 12 may select stale latest tags for absent peers. Pin the installed host-peer closure explicitly.
async function peerPins() {
  const pins = new Map()
  const pending = Object.keys(packageManifest.peerDependencies)
  for (const name of pending) {
    assert(Object.hasOwn(packageManifest.devDependencies, name), `Host peer lacks a development dependency: ${name}`)
  }
  while (pending.length) {
    const name = pending.shift()
    if (pins.has(name)) continue
    const manifest = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'))
    pins.set(name, manifest.version)
    pending.push(...Object.keys(manifest.peerDependencies ?? {})
      .filter(peer => manifest.peerDependenciesMeta?.[peer]?.optional !== true))
  }
  return [...pins].map(([name, version]) => `${name}@${version}`)
}

const importProbe = `
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
const url = import.meta.resolve('dsh-ponytail');
assert(fileURLToPath(url).startsWith(process.cwd() + '/node_modules/dsh-ponytail/'));
const plugin = await import(url);
assert.equal(plugin.name, 'ponytail'); assert.equal(typeof plugin.apply, 'function');
console.log('INSTALLED_IMPORT_OK', url);
`

try {
  const source = join(work, 'source')
  await mkdir(source)
  for (const path of ['package.json', 'package-lock.json', 'tsconfig.json', 'src', 'vendor',
    'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    await cp(join(root, path), join(source, path), { recursive: true })
  }
  await run('isolated-source-prepare', 'npm', ['ci', '--no-audit', '--no-fund'], source)
  await readFile(join(source, 'dist/index.js'))
  await rm(join(source, 'dist'), { recursive: true })
  const packed = await run('pack-prepare', 'npm', ['pack', '--json', '--pack-destination', artifactDir], source)
  report.checks.push('self-contained-source-prepare', 'pack-prepare')
  const info = packInfo(packed.stdout)
  const tarball = resolve(artifactDir, info.filename)
  report.tarball = tarball
  report.tarballSha256 = createHash('sha256').update(await readFile(tarball)).digest('hex')
  assert.equal(info.name, packageManifest.name)
  assert.equal(info.version, packageManifest.version)
  const archive = (await run('archive-list', 'tar', ['-tzf', tarball])).stdout.trim().split('\n')
  for (const entry of archive) {
    assert(entry.startsWith('package/') && !entry.split('/').includes('..'), `Unsafe archive entry: ${entry}`)
    assert(!/^package\/(node_modules|src|tests|scripts|docs|research|\.runtime)\//.test(entry), `Development file packaged: ${entry}`)
  }
  for (const required of ['package.json', 'cordis.patch.yml', 'dist/index.js', 'dist/index.d.ts', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    assert(archive.includes(`package/${required}`), `Tarball is missing ${required}`)
  }
  const extracted = join(work, 'extracted')
  await mkdir(extracted)
  await run('archive-extract', 'tar', ['-xzf', tarball, '-C', extracted])
  const packedRoot = join(extracted, 'package')
  const upstream = JSON.parse(await readFile(join(root, 'vendor/ponytail/UPSTREAM.json'), 'utf8'))
  for (const [path, digest] of Object.entries(upstream.files)) {
    const source = await readFile(join(root, 'vendor/ponytail', path))
    const packaged = await readFile(join(packedRoot, 'vendor/ponytail', path))
    assert(source.equals(packaged), `Packaged upstream asset drift: ${path}`)
    assert.equal(createHash('sha256').update(packaged).digest('hex'), digest)
  }
  assert.equal(JSON.parse(await readFile(join(packedRoot, 'vendor/ponytail/package.json'), 'utf8')).type, 'commonjs')
  report.checks.push('archive-layout', 'upstream-byte-equality', 'commonjs-scope')

  const consumer = join(work, 'consumer')
  await mkdir(consumer)
  await writeFile(join(consumer, 'package.json'), JSON.stringify({ name: 'ponytail-clean-consumer', private: true, type: 'module' }))
  report.peerPins = await peerPins()
  await run('clean-consumer-install', 'npm', [
    'install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false',
    '--cache', join(root, '.runtime/npm-cache'), tarball, ...report.peerPins,
  ], consumer)
  await run('clean-consumer-import', process.execPath, ['--input-type=module', '-e', importProbe], consumer)
  report.checks.push('clean-tarball-import')
  const installedSkill = join(consumer, 'node_modules/dsh-ponytail/vendor/ponytail/skills/ponytail/SKILL.md')
  const original = await readFile(installedSkill)
  await rm(installedSkill)
  const missing = await run('missing-asset-rejected', process.execPath, ['--input-type=module', '-e', importProbe], consumer, true)
  assert.match(missing.stderr, /Ponytail asset validation failed/)
  await writeFile(installedSkill, Buffer.concat([original, Buffer.from('\ncorrupt\n')]))
  const corrupt = await run('corrupt-asset-rejected', process.execPath, ['--input-type=module', '-e', importProbe], consumer, true)
  assert.match(corrupt.stderr, /Corrupt upstream asset/)
  await writeFile(installedSkill, original)
  report.checks.push('missing-asset-rejection', 'corrupt-asset-rejection')

  await run('official-profile-install', dshBin, [
    'plugin', '--profile', 'web', 'add', tarball, '--ignore-scripts', '--store-dir', join(work, 'pnpm-store'),
  ])
  const profileDir = join(environment.DSH_HOME, 'profiles/web')
  const profileManifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8'))
  assert(profileManifest.dsh.profile.bundles.includes('dsh-ponytail'), 'Official plugin manager did not activate the bundle')
  const dump = await run('official-profile-config', dshBin, ['--profile', 'web', '--dump-config'])
  assert.match(dump.stdout, /id: ponytail/)
  assert.doesNotMatch(dump.stderr, /skipping profile bundle.*dsh-ponytail/)
  report.checks.push('official-plugin-add', 'bundle-admission', 'composed-profile')
  await cp(join(root, 'tests/package/profile-probe.mjs'), join(profileDir, 'profile-probe.mjs'))
  await writeFile(join(profileDir, 'cordis.patch.yml'), '- insert:\n    - id: ponytail-package-probe\n      name: ./profile-probe.mjs\n')
  const boot = await run('official-web-boot', dshBin, ['--profile', 'web', '--no-open', '--host', '127.0.0.1', '--port', '0'])
  assert.match(boot.stdout, /PONYTAIL_PACKAGE_SMOKE_OK/)
  report.profileProbe = JSON.parse(await readFile(environment.PONYTAIL_PACKAGE_PROBE_REPORT, 'utf8'))
  report.checks.push('official-web-loader', 'installed-two-session-isolation', 'installed-off', 'installed-skills', 'installed-one-shot-model', 'installed-cleanup', 'authenticated-web-http')

  const incompatible = JSON.parse(await readFile(join(packedRoot, 'package.json'), 'utf8'))
  incompatible.peerDependencies['@deepseek-ai/dsh-agent'] = '0.1.0-rc.1'
  await writeFile(join(packedRoot, 'package.json'), JSON.stringify(incompatible, null, 2))
  const deniedDir = join(work, 'denied')
  await mkdir(deniedDir)
  const deniedPack = await run('incompatible-pack', 'npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', deniedDir], packedRoot)
  const deniedTarball = join(deniedDir, packInfo(deniedPack.stdout).filename)
  const denied = await run('incompatible-bundle-rejected', dshBin, [
    'plugin', '--profile', 'denied', 'add', deniedTarball, '--offline', '--ignore-scripts', '--store-dir', join(work, 'pnpm-store'),
  ], root, true)
  assert.match(denied.stderr, /installation rejected.*incompatible/s)
  report.checks.push('official-incompatible-peer-rejection')
  report.completed = true
  console.log(`verify-package: PASS (${report.checks.length} checks); tarball: ${tarball}`)
} catch (error) {
  report.error = error.stack ?? String(error)
  console.error(`verify-package: FAILED; diagnostics retained in ${work}`)
  console.error(error.message?.split('\n')[0] ?? String(error))
  process.exitCode = 1
} finally {
  report.completedAt = new Date().toISOString()
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n')
  // Diagnostics stay local and reproducible; no package contents or reports are published.
}
