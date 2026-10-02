import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MODES, UPSTREAM_ROOT, isDeactivationCommand, renderInstructions, verifyVendoredAssets } from '../dist/upstream.js';

test('packaged renderer preserves each upstream level and omits off', () => {
  const require = createRequire(import.meta.url);
  const upstream = require(join(UPSTREAM_ROOT, 'hooks/ponytail-instructions.js'));
  assert.deepEqual(MODES, ['off', 'lite', 'full', 'ultra']);
  assert.equal(renderInstructions('off'), '');
  for (const mode of MODES.filter((mode) => mode !== 'off')) {
    assert.equal(renderInstructions(mode), upstream.getPonytailInstructions(mode));
    assert(renderInstructions(mode).includes(`| **${mode}** |`));
    assert(renderInstructions(mode).includes('No unrequested abstractions'));
    for (const other of MODES.filter((other) => other !== mode && other !== 'off')) {
      assert(!renderInstructions(mode).includes(`| **${other}** |`));
    }
  }
  assert.throws(() => renderInstructions('invalid'), /Invalid Ponytail mode/);
  assert(isDeactivationCommand(' Normal mode!? '));
  assert(isDeactivationCommand('STOP PONYTAIL.'));
  assert(!isDeactivationCommand('add a normal mode toggle'));
});

test('asset validation rejects corruption, missing files, unsafe manifests, and a wrong module scope', () => {
  const temporary = mkdtempSync(join(tmpdir(), 'dsh-ponytail-assets-'));
  const root = join(temporary, 'ponytail');
  try {
    cpSync(UPSTREAM_ROOT, root, { recursive: true });
    const manifest = verifyVendoredAssets(root);
    const skillPath = join(root, 'skills/ponytail/SKILL.md');
    const skill = readFileSync(skillPath);
    writeFileSync(skillPath, Buffer.concat([skill, Buffer.from('\nmodified\n')]));
    assert.throws(() => verifyVendoredAssets(root), /Corrupt upstream asset: skills\/ponytail\/SKILL.md/);
    rmSync(skillPath);
    assert.throws(() => verifyVendoredAssets(root), /Asset file list differs from manifest/);
    writeFileSync(skillPath, skill);

    const manifestPath = join(root, 'UPSTREAM.json');
    manifest.files['../escape'] = '0'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest));
    assert.throws(() => verifyVendoredAssets(root), /Unsafe asset path: \.\.\/escape/);
    delete manifest.files['../escape'];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    assert.throws(() => verifyVendoredAssets(root), /CommonJS package scope/);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
