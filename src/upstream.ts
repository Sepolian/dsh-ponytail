import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

export type PonytailMode = 'off' | 'lite' | 'full' | 'ultra';
export interface UpstreamManifest {
  repository: string;
  commit: string;
  releaseTag: string;
  releaseCommit: string;
  files: Record<string, string>;
}

export const UPSTREAM_ROOT = fileURLToPath(new URL('../vendor/ponytail/', import.meta.url));

export function verifyVendoredAssets(root = UPSTREAM_ROOT): UpstreamManifest {
  try {
    const manifest = JSON.parse(readFileSync(join(root, 'UPSTREAM.json'), 'utf8')) as UpstreamManifest;
    assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Invalid upstream manifest');
    assert.equal(manifest.repository, 'https://github.com/DietrichGebert/ponytail', 'Unexpected upstream repository');
    for (const name of ['commit', 'releaseCommit'] as const) {
      assert(typeof manifest[name] === 'string' && /^[a-f0-9]{40}$/.test(manifest[name]), `Invalid ${name}`);
    }
    assert(typeof manifest.releaseTag === 'string' && /^v\d+\.\d+\.\d+$/.test(manifest.releaseTag), 'Invalid release tag');
    assert(manifest.files && typeof manifest.files === 'object' && !Array.isArray(manifest.files), 'Invalid asset hashes');
    for (const required of ['LICENSE', 'hooks/ponytail-config.js', 'hooks/ponytail-instructions.js', 'skills/ponytail/SKILL.md']) {
      assert(Object.hasOwn(manifest.files, required), `Missing required asset hash: ${required}`);
    }
    const scope = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.equal(scope?.type, 'commonjs', 'Upstream assets require a CommonJS package scope');

    const paths = Object.keys(manifest.files);
    for (const [path, digest] of Object.entries(manifest.files)) {
      assert(!path.includes('\\') && path.split('/').every((part) => part !== '' && part !== '.' && part !== '..'),
        `Unsafe asset path: ${path}`);
      assert(typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest), `Invalid asset hash: ${path}`);
    }
    function files(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        assert(!entry.isSymbolicLink(), `Unexpected asset symlink: ${path}`);
        return entry.isDirectory() ? files(path) : [relative(root, path).split('\\').join('/')];
      });
    }
    assert.deepEqual(files(root).sort(), [...paths, 'UPSTREAM.json', 'package.json'].sort(), 'Asset file list differs from manifest');
    for (const [path, expected] of Object.entries(manifest.files)) {
      const actual = createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
      assert.equal(actual, expected, `Corrupt upstream asset: ${path}`);
    }
    return manifest;
  } catch (error) {
    throw new Error(`Ponytail asset validation failed at ${root}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error });
  }
}

verifyVendoredAssets();
const require = createRequire(import.meta.url);
const config = require(join(UPSTREAM_ROOT, 'hooks/ponytail-config.js'));
assert.deepEqual(config.RUNTIME_MODES, ['off', 'lite', 'full', 'ultra'], 'Upstream runtime modes changed; update adapter types');
assert.equal(typeof config.isDeactivationCommand, 'function', 'Upstream deactivation helper is missing');
export const MODES: readonly PonytailMode[] = Object.freeze([...config.RUNTIME_MODES]);
export const isDeactivationCommand: (text: unknown) => boolean = config.isDeactivationCommand;
const renderer = require(join(UPSTREAM_ROOT, 'hooks/ponytail-instructions.js'));
assert.equal(typeof renderer.getPonytailInstructions, 'function', 'Upstream instruction renderer is missing');
const texts = Object.fromEntries(
  MODES.map((mode) => [mode, mode === 'off' ? '' : renderer.getPonytailInstructions(mode)]),
) as Record<PonytailMode, string>;

export function renderInstructions(mode: PonytailMode): string {
  assert(Object.hasOwn(texts, mode), `Invalid Ponytail mode: ${String(mode)}`);
  return texts[mode];
}
