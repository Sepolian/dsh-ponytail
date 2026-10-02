import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createRuntime } from '../tests/helpers/runtime.mjs'
import { renderInstructions } from '../dist/upstream.js'

const root = await mkdtemp(join(tmpdir(), 'dsh-ponytail-benchmark-'))
const runtime = await createRuntime(root)
try {
  const { agent } = await runtime.create('benchmark')
  await runtime.command(agent, '/ponytail ultra')
  for (let i = 0; i < 100; i++) await runtime.prompt(agent)
  const samples = []
  const iterations = 1000
  for (let sample = 0; sample < 5; sample++) {
    const start = performance.now()
    for (let i = 0; i < iterations; i++) {
      assert.equal(await runtime.prompt(agent), renderInstructions('ultra'))
    }
    samples.push(performance.now() - start)
  }
  assert.equal(runtime.adapter.requests.length, 0, 'Mode selection/assembly must not make a model request')
  const median = [...samples].sort((a, b) => a - b)[Math.floor(samples.length / 2)]
  const report = {
    measuredAt: new Date().toISOString(), node: process.version,
    dsh: '0.2.0-rc.2', ponytail: '4.10.0',
    operation: 'Real DSH system-prompt assembly with cached ultra instructions and equality assertion',
    iterationsPerSample: iterations, samplesMs: samples,
    medianMicrosecondsPerAssembly: median * 1000 / iterations,
    modelRequests: runtime.adapter.requests.length,
    limitation: 'Single local machine; no network or model latency; no cross-machine performance promise.',
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n')
} finally {
  await runtime.close()
  await rm(root, { recursive: true, force: true })
}
