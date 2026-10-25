/**
 * Pure-function tests for the remote-assignment health loop (T7).
 *
 * `evaluateRemoteHealth` inspects a snapshot of the orchestrator's live
 * pipeline assignments + per-camera fps telemetry and returns the set of
 * remote cameras that must be re-placed because they accepted an attach but
 * produce nothing (zero-fps) or have gone metrics-silent (stale-metrics).
 *
 * The hub watchdog covers LOCAL cameras; this loop is the remote-node
 * equivalent (gap i). The function is PURE — deterministic, no clock, no I/O.
 */

import type { PipelineAssignment } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  DEFAULT_REMOTE_HEALTH_OPTS,
  evaluateRemoteHealth,
  type RemoteHealthAction,
  type RemoteHealthInput,
} from '../remote-health.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const NOW = 10_000_000
const LOCAL = 'hub'
const GRACE = DEFAULT_REMOTE_HEALTH_OPTS.graceMs
const STALE = DEFAULT_REMOTE_HEALTH_OPTS.staleMs

/** Build a PipelineAssignment that is OLD (past grace) unless overridden. */
function assignment(over: Partial<PipelineAssignment> & { deviceId: number }): PipelineAssignment {
  return {
    agentNodeId: 'agent',
    pinned: false,
    reason: 'capacity',
    assignedAt: NOW - (GRACE + 60_000), // comfortably past grace by default
    ...over,
  }
}

/** Run `evaluateRemoteHealth` with sensible empty defaults, overriding as needed. */
function run(over: Partial<RemoteHealthInput>): RemoteHealthAction[] {
  return evaluateRemoteHealth({
    assignments: new Map(),
    fpsMap: new Map(),
    activeDeviceIds: new Set(),
    localNodeId: LOCAL,
    now: NOW,
    opts: DEFAULT_REMOTE_HEALTH_OPTS,
    ...over,
  })
}

describe('evaluateRemoteHealth', () => {
  it('ignores a LOCAL assignment even at 0 fps (hub watchdog owns local)', () => {
    const actions = run({
      assignments: new Map([[1, assignment({ deviceId: 1, agentNodeId: LOCAL })]]),
      activeDeviceIds: new Set([1]),
      fpsMap: new Map([[1, { fps: 0, nodeId: LOCAL, lastSeen: NOW }]]),
    })
    expect(actions).toEqual([])
  })

  it('ignores a YOUNG remote assignment (still inside cold-start grace)', () => {
    const actions = run({
      assignments: new Map([
        [2, assignment({ deviceId: 2, agentNodeId: 'agent', assignedAt: NOW - 30_000 })],
      ]),
      activeDeviceIds: new Set([2]),
      fpsMap: new Map([[2, { fps: 0, nodeId: 'agent', lastSeen: NOW }]]),
    })
    expect(actions).toEqual([])
  })

  it('flags a remote + active + 0-fps camera past grace → replace(zero-fps)', () => {
    const actions = run({
      assignments: new Map([[3, assignment({ deviceId: 3, agentNodeId: 'agent' })]]),
      activeDeviceIds: new Set([3]),
      fpsMap: new Map([[3, { fps: 0, nodeId: 'agent', lastSeen: NOW }]]),
    })
    expect(actions).toEqual<RemoteHealthAction[]>([
      { deviceId: 3, kind: 'replace', why: 'zero-fps' },
    ])
  })

  it('flags a remote camera with NO fps entry past grace → replace(stale-metrics)', () => {
    const actions = run({
      assignments: new Map([[4, assignment({ deviceId: 4, agentNodeId: 'agent' })]]),
      activeDeviceIds: new Set([4]),
      fpsMap: new Map(), // no telemetry ever arrived
    })
    expect(actions).toEqual<RemoteHealthAction[]>([
      { deviceId: 4, kind: 'replace', why: 'stale-metrics' },
    ])
  })

  it('flags a remote camera whose metrics stopped (lastSeen older than staleMs) → replace(stale-metrics)', () => {
    const actions = run({
      assignments: new Map([[7, assignment({ deviceId: 7, agentNodeId: 'agent' })]]),
      activeDeviceIds: new Set([7]),
      fpsMap: new Map([[7, { fps: 5, nodeId: 'agent', lastSeen: NOW - (STALE + 30_000) }]]),
    })
    expect(actions).toEqual<RemoteHealthAction[]>([
      { deviceId: 7, kind: 'replace', why: 'stale-metrics' },
    ])
  })

  it('leaves a HEALTHY remote camera (fps 5, fresh metrics) alone', () => {
    const actions = run({
      assignments: new Map([[5, assignment({ deviceId: 5, agentNodeId: 'agent' })]]),
      activeDeviceIds: new Set([5]),
      fpsMap: new Map([[5, { fps: 5, nodeId: 'agent', lastSeen: NOW }]]),
    })
    expect(actions).toEqual([])
  })

  it('ignores a remote camera that is NOT in activeDeviceIds (detection not expected)', () => {
    const actions = run({
      assignments: new Map([[6, assignment({ deviceId: 6, agentNodeId: 'agent' })]]),
      activeDeviceIds: new Set(), // no active detection for 6
      fpsMap: new Map([[6, { fps: 0, nodeId: 'agent', lastSeen: NOW }]]),
    })
    expect(actions).toEqual([])
  })
})

// ── Orchestrator wiring (detach + re-dispatch + bounded backoff) ─────────────

/** Test subclass exposing the protected health-loop seam + the backoff ledger. */
class TestOrchestrator extends PipelineOrchestratorAddon {
  runHealthSweep(): Promise<void> {
    return this.evaluateRemoteAssignmentHealth()
  }

  peekPendingReason(deviceId: number): string | undefined {
    return this.ledger?.getPendingReason(deviceId)
  }

  peekAttemptCount(deviceId: number): number | undefined {
    return this.remoteHealthAttempts.get(deviceId)?.count
  }

  seedAttempts(deviceId: number, count: number): void {
    this.remoteHealthAttempts.set(deviceId, { count, windowStart: Date.now() })
  }
}

/**
 * Reach into the private state to stage a broken REMOTE assignment. S6
 * seam-retarget: `assignments`/`cameraConfigs` moved into `PlacementLedger`
 * (`placement-ledger.ts`) — `seedAssignment` is the raw-write test seam that
 * mirrors the old direct `Map.set` (unlike `recordAssignment`, it lets the
 * test stamp an AGED `assignedAt` to simulate past-grace). S8 seam-retarget:
 * `cameraFpsMap` moved into `LoadShedController` (`load-shed-controller.ts`)
 * — `seedCameraFps` is the equivalent raw-write test seam.
 */
interface OrchestratorInternals {
  ledger: {
    seedAssignment(deviceId: number, assignment: PipelineAssignment): void
    setConfig(deviceId: number, config: ReturnType<typeof makeRunnerCameraConfig>): void
  }
  activeDetections: Map<number, unknown>
  loadShed: {
    seedCameraFps(deviceId: number, entry: { fps: number; nodeId: string; lastSeen: number }): void
  }
}

const OLD_ASSIGN_MS = 10 * 60_000 // comfortably past the 3-min grace

function stageBrokenRemote(addon: TestOrchestrator, deviceId: number, fps: number): void {
  const internals = addon as unknown as OrchestratorInternals
  internals.ledger.seedAssignment(deviceId, {
    deviceId,
    agentNodeId: 'agent',
    pinned: false,
    reason: 'capacity',
    assignedAt: Date.now() - OLD_ASSIGN_MS,
  })
  internals.activeDetections.set(deviceId, { deviceId })
  internals.ledger.setConfig(deviceId, makeRunnerCameraConfig(deviceId))
  internals.loadShed.seedCameraFps(deviceId, { fps, nodeId: 'agent', lastSeen: Date.now() })
}

describe('PipelineOrchestratorAddon — remote-assignment health loop (T7 wiring)', () => {
  let addon: TestOrchestrator | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('re-places a 0-fps remote camera onto an eligible node and counts the attempt', async () => {
    const broker = makeFakeBroker('hub')
    const hubRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', hubRunner)
    // Only the hub is eligible → the re-dispatch deterministically lands on hub.
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'], enabledDecoderNodes: ['hub'] },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    stageBrokenRemote(addon, 42, 0)
    // D650 round 3: a re-place elects against the node's LAST ANSWERED device
    // probe and never waits for one; the dispatcher's own reads (a first
    // placement, the session refresher) are what warm it in production.
    await addon.resolveEligibleInferenceDevices('hub', 'await-catalog')
    await addon.runHealthSweep()

    // The broken remote assignment was re-placed onto the hub.
    await waitUntil(() => addon!.getPipelineAssignment({ deviceId: 42 }) !== null, 2_000)
    expect(addon.getPipelineAssignment({ deviceId: 42 })?.agentNodeId).toBe('hub')
    expect(hubRunner.attachedCameras.has(42)).toBe(true)
    // One replacement attempt was recorded (under the 3/hour budget).
    expect(addon.peekAttemptCount(42)).toBe(1)
  })

  it('leaves the camera visibly pending(unhealthy) once the retry budget is exhausted', async () => {
    const broker = makeFakeBroker('hub')
    const hubRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', hubRunner)
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'], enabledDecoderNodes: ['hub'] },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    stageBrokenRemote(addon, 43, 0)
    // Pretend this camera has already used its 3 replacements this window.
    addon.seedAttempts(43, 3)

    await addon.runHealthSweep()

    // Over budget → dropped + marked unhealthy, NOT re-dispatched.
    expect(addon.getPipelineAssignment({ deviceId: 43 })).toBeNull()
    expect(addon.peekPendingReason(43)).toBe('unhealthy')
    expect(hubRunner.attachedCameras.has(43)).toBe(false)
  })

  it('ignores a healthy remote camera (fps 5) — no detach, no re-dispatch', async () => {
    const broker = makeFakeBroker('hub')
    const hubRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', hubRunner)
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'], enabledDecoderNodes: ['hub'] },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    stageBrokenRemote(addon, 44, 5) // healthy fps
    await addon.runHealthSweep()

    // Untouched: still assigned to agent, no attempt recorded.
    expect(addon.getPipelineAssignment({ deviceId: 44 })?.agentNodeId).toBe('agent')
    expect(addon.peekAttemptCount(44)).toBeUndefined()
    expect(hubRunner.attachedCameras.has(44)).toBe(false)
  })
})
