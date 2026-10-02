import assert from 'node:assert/strict'
import { createRuntime } from './runtime.mjs'
import { renderInstructions } from '../../dist/upstream.js'

const [storageRoot, action] = process.argv.slice(2)
const runtime = await createRuntime(storageRoot)
try {
  const { agent } = await runtime.create('same-session-id')
  if (action === 'write') {
    assert.equal((await runtime.command(agent, '/ponytail default lite')).kind, 'success')
    assert.equal((await runtime.command(agent, '/ponytail ultra')).kind, 'success')
    assert.equal(await runtime.prompt(agent), renderInstructions('ultra'))
  } else {
    assert.equal(action, 'read')
    assert.equal((await runtime.command(agent, '/ponytail')).text,
      'Current effective mode: lite\nSession override: none\nPersistent default: lite')
    assert.equal(await runtime.prompt(agent), renderInstructions('lite'))
  }
  process.stdout.write(`RESTART_${action.toUpperCase()}_OK\n`)
} finally {
  await runtime.close()
}
