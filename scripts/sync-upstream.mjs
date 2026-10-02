import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
const upstream = resolve(project, '../upstream/ponytail');
const vendor = join(project, 'vendor/ponytail');
const pin = {
  repository: 'https://github.com/DietrichGebert/ponytail',
  commit: 'e3ba2aa6f1e6f0bc4d69eb09c9f0d0a93af56156',
  releaseTag: 'v4.10.0',
  releaseCommit: '1d95ff7d39de12d87014ea40d4e22201bddc501b',
};

assert(process.argv.length === 3 && ['--check', '--update'].includes(process.argv[2]),
  'Usage: node scripts/sync-upstream.mjs --check|--update');
const git = (...args) => execFileSync('git', args, { cwd: upstream, encoding: 'utf8' }).trim();
assert.equal(git('rev-parse', 'HEAD'), pin.commit, 'Upstream checkout must be at the pinned commit');
assert.equal(git('rev-parse', `${pin.releaseTag}^{commit}`), pin.releaseCommit, 'Release tag differs from pin');
const sourcePaths = [
  'hooks/ponytail-instructions.js',
  'hooks/ponytail-config.js',
  'LICENSE',
  ...git('ls-tree', '-r', '--name-only', pin.commit, '--', 'skills').split('\n').filter(Boolean),
].sort();
assert(sourcePaths.some((path) => path === 'skills/ponytail/SKILL.md'), 'Upstream main skill is missing');
git('diff', '--exit-code', 'HEAD', '--', ...sourcePaths);

// Read Git blobs so checkout newline conversion cannot change the pinned bytes.
const expected = new Map(sourcePaths.map((path) => [path,
  execFileSync('git', ['show', `${pin.commit}:${path}`], { cwd: upstream }),
]));
const provenance = {
  ...pin,
  files: Object.fromEntries([...expected].map(([path, bytes]) => [
    path, createHash('sha256').update(bytes).digest('hex'),
  ])),
};
expected.set('package.json', Buffer.from(`${JSON.stringify({ private: true, type: 'commonjs' }, null, 2)}\n`));
expected.set('UPSTREAM.json', Buffer.from(`${JSON.stringify(provenance, null, 2)}\n`));

if (process.argv[2] === '--update') {
  // This directory is generated; the default/check command never changes it.
  rmSync(vendor, { recursive: true, force: true });
  for (const [path, bytes] of expected) {
    const destination = join(vendor, path);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, bytes);
  }
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    assert(!entry.isSymbolicLink(), `Unexpected symlink: ${path}`);
    return entry.isDirectory() ? files(path) : [relative(vendor, path).split('\\').join('/')];
  });
}

assert.deepEqual(files(vendor).sort(), [...expected.keys()].sort(), 'Vendor asset list differs from upstream');
for (const [path, bytes] of expected) {
  assert.deepEqual(readFileSync(join(vendor, path)), bytes, `Upstream asset drift: ${path}`);
}
const require = createRequire(import.meta.url);
const original = require(join(upstream, 'hooks/ponytail-instructions.js'));
const packaged = require(join(vendor, 'hooks/ponytail-instructions.js'));
for (const mode of ['lite', 'full', 'ultra']) {
  assert.equal(packaged.getPonytailInstructions(mode), original.getPonytailInstructions(mode),
    `Packaged renderer differs for ${mode}`);
}
console.log(`Ponytail ${pin.releaseTag}: ${sourcePaths.length} exact upstream assets verified (${pin.commit}).`);
