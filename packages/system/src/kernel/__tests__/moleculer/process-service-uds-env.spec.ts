/**
 * Unit tests for CAMSTACK_PARENT_UDS_PATH env-var plumbing in
 * `createProcessService`. Mirrors the setup style of addon-runner.spec.ts
 * (Layer 1) — a fake `spawnFn` is injected via the `deps` seam so we can
 * inspect the env object passed to `spawn` without paying real subprocess
 * cost.
 *
 * Two invariants:
 *   (a) When `parentUdsPath` is provided, child env includes
 *       `CAMSTACK_PARENT_UDS_PATH` set to that value.
 *   (b) When `parentUdsPath` is omitted, `CAMSTACK_PARENT_UDS_PATH` is
 *       absent from the child env entirely (not set to "undefined").
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ServiceBroker } from 'moleculer'
import * as cp from 'node:child_process'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { createProcessService } from '../../moleculer/process-service.js'
import { inertProcessGroups } from './inert-process-groups.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeChild extends EventEmitter {
  pid: number
  stdout: EventEmitter
  stderr: EventEmitter
  kill: (sig?: string) => boolean
}

function makeFakeChild(pid: number): FakeChild {
  const ee = new EventEmitter() as FakeChild
  ee.pid = pid
  ee.stdout = new EventEmitter()
  ee.stderr = new EventEmitter()
  ee.kill = () => true
  return ee
}

type SpawnCall = { command: string; args: readonly string[]; env: Record<string, string> }

// ---------------------------------------------------------------------------
// Suite A — with parentUdsPath set
// ---------------------------------------------------------------------------

describe('CAMSTACK_PARENT_UDS_PATH — present when parentUdsPath provided', {
  timeout: 15000,
}, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-uds-env-spec-with-'))
  const spawnCalls: SpawnCall[] = []
  let pidCounter = 91000

  const fakeSpawn = (
    command: string,
    args: readonly string[],
    opts: cp.SpawnOptions,
  ): cp.ChildProcess => {
    spawnCalls.push({ command, args, env: (opts.env ?? {}) as Record<string, string> })
    return makeFakeChild(++pidCounter) as unknown as cp.ChildProcess
  }

  const broker = new ServiceBroker({
    nodeID: 'hub-uds-with',
    transporter: 'Fake',
    logger: false,
  })

  beforeAll(async () => {
    broker.createService(
      createProcessService(
        'hub-uds-with',
        tmpDir,
        { spawnFn: fakeSpawn, processGroups: inertProcessGroups },
        undefined,
        '/tmp/camstack-test.sock',
      ),
    )
    await broker.start()
  })

  afterAll(async () => {
    await broker.stop()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  })

  it('sets CAMSTACK_PARENT_UDS_PATH in child env', async () => {
    const addons = [{ addonId: 'test-addon', addonDir: '/tmp/test-addon' }]
    await broker.call('$process.spawnRunner', { runnerId: 'uds-runner', addons })
    const lastCall = spawnCalls[spawnCalls.length - 1]!
    expect(lastCall.env['CAMSTACK_PARENT_UDS_PATH']).toBe('/tmp/camstack-test.sock')
  })
})

// ---------------------------------------------------------------------------
// Suite B — without parentUdsPath (key must be absent, not "undefined")
// ---------------------------------------------------------------------------

describe('CAMSTACK_PARENT_UDS_PATH — absent when parentUdsPath not provided', {
  timeout: 15000,
}, () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ps-uds-env-spec-without-'))
  const spawnCalls: SpawnCall[] = []
  let pidCounter = 92000

  const fakeSpawn = (
    command: string,
    args: readonly string[],
    opts: cp.SpawnOptions,
  ): cp.ChildProcess => {
    spawnCalls.push({ command, args, env: (opts.env ?? {}) as Record<string, string> })
    return makeFakeChild(++pidCounter) as unknown as cp.ChildProcess
  }

  const broker = new ServiceBroker({
    nodeID: 'hub-uds-without',
    transporter: 'Fake',
    logger: false,
  })

  beforeAll(async () => {
    // No parentUdsPath argument — uses the positional default (undefined)
    broker.createService(
      createProcessService('hub-uds-without', tmpDir, {
        spawnFn: fakeSpawn,
        processGroups: inertProcessGroups,
      }),
    )
    await broker.start()
  })

  afterAll(async () => {
    await broker.stop()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* */
    }
  })

  it('does NOT include CAMSTACK_PARENT_UDS_PATH in child env', async () => {
    const addons = [{ addonId: 'test-addon-no-uds', addonDir: '/tmp/test-addon-no-uds' }]
    await broker.call('$process.spawnRunner', { runnerId: 'no-uds-runner', addons })
    const lastCall = spawnCalls[spawnCalls.length - 1]!
    expect('CAMSTACK_PARENT_UDS_PATH' in lastCall.env).toBe(false)
  })
})
