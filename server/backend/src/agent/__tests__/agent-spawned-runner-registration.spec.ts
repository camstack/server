/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */
/**
 * Bug-4 regression: agent-spawned addon-runners must receive
 * CAMSTACK_PARENT_TCP_PORT in their child env so they connect to the spawning
 * agent's broker instead of falling back to port 6000 (the hub). Without the
 * correct port the runner calls `$agent.registerNode` through the hub, which
 * has no `$agent` service, producing a retry storm (attempt 80+).
 *
 * This suite pins the env-wiring contract at the unit level using the same
 * `spawnFn` DI pattern as
 * `packages/system/src/kernel/__tests__/moleculer/addon-runner.spec.ts`.
 * The `ProcessServiceDeps` injection point is intentionally private to the
 * module — callers supply it via the optional `deps` arg.
 *
 * The eslint-disable above suppresses the Moleculer ServiceBroker unsafe-typing
 * warnings — a pre-existing issue across all broker-using test files in this repo.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { EventEmitter } from 'node:events'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import type { SpawnOptions, ChildProcess } from 'node:child_process'
import { createProcessService, deriveAgentListenPort } from '@camstack/system'

/**
 * The fake runners' pids are invented: every group reads as already empty so the
 * D668 reap never signals a real process group on the machine running the suite.
 */
const inertProcessGroups = {
  kill: (): void => {
    throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' })
  },
  listMembers: () => Promise.resolve([]),
  sleep: () => Promise.resolve(),
  graceMs: 0,
}

// ---------------------------------------------------------------------------
// Helpers — mirror the minimal fake-child from addon-runner.spec.ts
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

// ---------------------------------------------------------------------------
// Suite A — agent-spawned runners get the agent's port in their child env
// ---------------------------------------------------------------------------

describe('Bug-4 regression: agent-spawned addon-runner env wiring', { timeout: 15_000 }, () => {
  const agentNodeId = 'dev-agent-0'
  const agentTcpPort = deriveAgentListenPort(agentNodeId)

  const broker = new ServiceBroker({
    nodeID: agentNodeId,
    transporter: 'Fake',
    logger: false,
  })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-runner-spec-'))
  const spawnCalls: Array<{
    command: string
    args: readonly string[]
    env: Record<string, string>
  }> = []
  let pidCounter = 50000

  const fakeSpawn = (
    command: string,
    args: readonly string[],
    opts: SpawnOptions,
  ): ChildProcess => {
    spawnCalls.push({ command, args, env: (opts.env ?? {}) as Record<string, string> })
    return makeFakeChild(++pidCounter) as unknown as ChildProcess
  }

  beforeAll(async () => {
    broker.createService(
      createProcessService(
        agentNodeId,
        tmpDir,
        { spawnFn: fakeSpawn, processGroups: inertProcessGroups },
        agentTcpPort,
      ),
    )
    await broker.start()
  })

  afterAll(async () => {
    await broker.stop()
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      /* non-critical */
    }
  })

  it('CAMSTACK_PARENT_TCP_PORT equals the agent listen port when parentTcpPort is provided', async () => {
    const addons = [{ addonId: 'edge-detector', addonDir: '/opt/addons/edge-detector' }]
    const beforeCount = spawnCalls.length

    await broker.call('$process.spawnRunner', {
      runnerId: 'edge-detector',
      addons,
    })

    expect(spawnCalls.length).toBeGreaterThan(beforeCount)
    const lastCall = spawnCalls[spawnCalls.length - 1]!
    const env = lastCall.env

    // The core invariant: agent TCP port reaches the child.
    expect(env.CAMSTACK_PARENT_TCP_PORT).toBe(String(agentTcpPort))
    // Sanity-check: the port must not be the hub's fixed 6000 for any real agent.
    expect(Number(env.CAMSTACK_PARENT_TCP_PORT)).not.toBe(6000)
    // Standard env vars must still be set.
    expect(env.CAMSTACK_PARENT_NODE_ID).toBe(agentNodeId)
    expect(env.CAMSTACK_RUNNER_ID).toBe('edge-detector')
  })

  it('CAMSTACK_RUNNER_ADDONS contains the correct addon descriptor', async () => {
    const addons = [{ addonId: 'audio-codec-nodeav', addonDir: '/opt/addons/audio-codec-nodeav' }]

    await broker.call('$process.spawnRunner', {
      runnerId: 'audio-codec-nodeav',
      addons,
    })

    const lastCall = spawnCalls[spawnCalls.length - 1]!
    const parsed = JSON.parse(lastCall.env.CAMSTACK_RUNNER_ADDONS!) as Array<{
      addonId: string
      addonDir: string
    }>
    expect(parsed).toEqual(addons)
  })
})

// ---------------------------------------------------------------------------
// Suite B — hub-spawned runners omit CAMSTACK_PARENT_TCP_PORT (fallback to 6000)
// ---------------------------------------------------------------------------

describe('Hub-spawned runner does not set CAMSTACK_PARENT_TCP_PORT (fallback 6000 applies)', {
  timeout: 15_000,
}, () => {
  const hubNodeId = 'hub'

  const broker = new ServiceBroker({
    nodeID: hubNodeId,
    transporter: 'Fake',
    logger: false,
  })

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-runner-spec-'))
  const spawnCalls: Array<{
    command: string
    args: readonly string[]
    env: Record<string, string>
  }> = []
  let pidCounter = 60000

  const fakeSpawn = (
    command: string,
    args: readonly string[],
    opts: SpawnOptions,
  ): ChildProcess => {
    spawnCalls.push({ command, args, env: (opts.env ?? {}) as Record<string, string> })
    return makeFakeChild(++pidCounter) as unknown as ChildProcess
  }

  beforeAll(async () => {
    // Intentionally NO parentTcpPort — simulates the hub call site which relies
    // on the addon-runner.ts default fallback (`?? 6000`).
    broker.createService(
      createProcessService(hubNodeId, tmpDir, {
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
      /* non-critical */
    }
  })

  it('CAMSTACK_PARENT_TCP_PORT is not explicitly set by process-service when parentTcpPort is omitted', async () => {
    // Unset the env var before this test so process.env doesn't accidentally
    // satisfy the assertion via inheritance from a parent runner context.
    const prevVal = process.env.CAMSTACK_PARENT_TCP_PORT
    delete process.env.CAMSTACK_PARENT_TCP_PORT

    const addons = [{ addonId: 'provider-rtsp', addonDir: '/opt/addons/provider-rtsp' }]
    const beforeCount = spawnCalls.length

    await broker.call('$process.spawnRunner', {
      runnerId: 'provider-rtsp',
      addons,
    })

    // Restore env to avoid side-effects on other tests.
    if (prevVal !== undefined) process.env.CAMSTACK_PARENT_TCP_PORT = prevVal

    expect(spawnCalls.length).toBeGreaterThan(beforeCount)
    const lastCall = spawnCalls[spawnCalls.length - 1]!
    const env = lastCall.env

    // When parentTcpPort is omitted, process-service does NOT inject the
    // var — the runner picks up 6000 from its own default fallback in
    // addon-runner.ts. This verifies backward compat for hub-spawned runners.
    expect(env.CAMSTACK_PARENT_TCP_PORT).toBeUndefined()
    expect(env.CAMSTACK_PARENT_NODE_ID).toBe(hubNodeId)
  })
})

// ---------------------------------------------------------------------------
// Suite C — deriveAgentListenPort is stable and deterministic
// ---------------------------------------------------------------------------

describe('deriveAgentListenPort produces a stable, unique port per nodeId', () => {
  it('returns the same port for the same nodeId on repeated calls', () => {
    const port1 = deriveAgentListenPort('dev-agent-0')
    const port2 = deriveAgentListenPort('dev-agent-0')
    expect(port1).toBe(port2)
  })

  it('returns distinct ports for different nodeIds', () => {
    const portA = deriveAgentListenPort('dev-agent-0')
    const portB = deriveAgentListenPort('dev-agent-1')
    expect(portA).not.toBe(portB)
  })

  it('always returns a port in the 20000-30000 range', () => {
    for (const nodeId of ['dev-agent-0', 'dev-agent-1', 'production-agent-abc123', 'x']) {
      const port = deriveAgentListenPort(nodeId)
      expect(port).toBeGreaterThanOrEqual(20000)
      expect(port).toBeLessThan(30000)
    }
  })

  it('never returns 6000 (the hub fixed port)', () => {
    // Any real agent nodeId must map to a port outside the hub's reserved 6000.
    const testNodeIds = ['dev-agent-0', 'dev-agent-1', 'agent-raspberry', 'camstack-edge']
    for (const nodeId of testNodeIds) {
      expect(deriveAgentListenPort(nodeId)).not.toBe(6000)
    }
  })
})
