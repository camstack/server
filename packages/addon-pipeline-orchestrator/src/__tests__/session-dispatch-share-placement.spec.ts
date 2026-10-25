/**
 * D748 — share placement on the real session path. Under `least-loaded` an
 * idle cluster sends every session to the alphabetically-first node (every
 * node scores 0); under `share` the PARALLEL distribution holds the weights,
 * a capped node yields, a stale device pin is said once and ignored, and the
 * placement statistics see every start.
 */
import { CAMERA_TRIGGER } from '@camstack/types'
import type {
  CameraDetectionConfig,
  IScopedLogger,
  RunnerCameraConfig,
  RunnerLocalLoad,
  SessionPlacementPolicy,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RoundRobinInferenceDeviceRotation } from '../device-balancer.js'
import {
  SessionDispatchController,
  type SessionDispatchControllerDeps,
} from '../session-dispatch-controller.js'
import { SessionAffinityMemory } from '../session-affinity.js'
import { SessionPlacementStats } from '../session-placement-stats.js'
import { ShareElectionHistory } from '../share-election-history.js'

interface Line {
  readonly message: string
  readonly meta: Record<string, unknown>
}

function logger(lines: Line[]): IScopedLogger {
  const push = (message: string, opts?: { meta?: Record<string, unknown> }): void => {
    lines.push({ message, meta: opts?.meta ?? {} })
  }
  const log: Partial<IScopedLogger> = { info: push, warn: push, error: push, debug: push }
  log.withTags = () => log as IScopedLogger
  return log as IScopedLogger
}

function load(nodeId: string, attached: number): RunnerLocalLoad {
  return {
    nodeId,
    attachedCameras: attached,
    activeCameras: 0,
    avgInferenceFps: 0,
    avgInferenceTimeMs: 0,
    queueDepthTotal: 0,
    devices: [],
    hardware: { hasGpu: false },
  }
}

function detectionConfig(): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['onboard'],
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionFps: 2,
    detectionFps: 6,
    motionCooldownMs: 30_000,
    detectionMode: 'on-motion',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: false,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 0,
    occupancyRecheckFrames: 0,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
  }
}

const NODES = ['hub', 'agent-a', 'mac']

interface World {
  readonly controller: SessionDispatchController
  readonly placedOn: string[]
  readonly lines: Line[]
  readonly stats: SessionPlacementStats
}

function world(opts: {
  readonly policy: SessionPlacementPolicy
  readonly caps?: Record<string, number | null>
  readonly devicePin?: string | null
  readonly weights?: Record<string, number>
  /** Inject the election memory (and, with `affinity`, the camera affinity). */
  readonly history?: boolean
  readonly affinity?: boolean
}): World {
  const placedOn: string[] = []
  const live: string[] = []
  const lines: Line[] = []
  const stats = new SessionPlacementStats()
  // The runner census follows what is attached now — each node's attached count.
  const attachedBy = (nodeId: string): number => live.filter((n) => n === nodeId).length
  const deps: SessionDispatchControllerDeps = {
    ledger: {
      hasAssignment: () => false,
      hasPending: () => false,
      markDispatching: () => ({ dispose: () => {} }),
      listAssignments: () => [],
    } as unknown as SessionDispatchControllerDeps['ledger'],
    topology: {
      detectionEligibleNodes: () => NODES,
      knownRunnerNodeIds: () => NODES,
    } as unknown as SessionDispatchControllerDeps['topology'],
    loadService: {
      collectAgentLoad: async () => NODES.map((n) => load(n, attachedBy(n))),
    } as unknown as SessionDispatchControllerDeps['loadService'],
    settingsStore: {
      buildNodeCaps: async () => opts.caps ?? {},
      buildNodeWeights: async () => opts.weights ?? { hub: 20, mac: 70, 'agent-a': 10 },
      readDeviceProvisioning: async (_d: number, _n: string, keys: readonly string[]) =>
        new Map(keys.map((k) => [k, { base: {}, override: {} }])),
      resolvePipelineForDeviceWithRoots: async () => ({
        config: { steps: [], audio: null },
        droppedRoots: [],
      }),
    } as unknown as SessionDispatchControllerDeps['settingsStore'],
    getEligibleInferenceDevices: async () => ({ 'coreml:all': 1 }),
    isNodeInferenceUsable: () => true,
    getInferenceDeviceCaps: async () => ({}),
    readPipelineDevicePin: async () => opts.devicePin ?? null,
    inferenceRotation: new RoundRobinInferenceDeviceRotation(),
    sessionPlacement: () => opts.policy,
    placementStats: stats,
    ...(opts.history === true ? { shareHistory: new ShareElectionHistory() } : {}),
    ...(opts.affinity === true ? { sessionAffinity: new SessionAffinityMemory() } : {}),
    attachOn: async (nodeId: string, _config: RunnerCameraConfig) => {
      placedOn.push(nodeId)
      live.push(nodeId)
    },
    detachOn: async (nodeId: string) => {
      const at = live.indexOf(nodeId)
      if (at >= 0) live.splice(at, 1)
    },
    recordAssignment: () => {},
    dropAssignment: () => {},
    reconcilePlacementFromRunners: async () => {},
    getActiveDetectionConfig: () => detectionConfig(),
    dropActiveDetection: () => {},
    listZones: async () => [],
    readPipelinePin: async () => null,
    logger: logger(lines),
  }
  return { controller: new SessionDispatchController(deps), placedOn, lines, stats }
}

async function motion(w: World, deviceId: number): Promise<void> {
  await w.controller.handleSessionMotion(deviceId, true, undefined, 'onboard', CAMERA_TRIGGER)
  // The balancer memo refreshes off the dispatch path; let it settle so the
  // next dispatch reads the census that includes this session.
  await vi.advanceTimersByTimeAsync(5_000)
}

describe('session dispatch — share placement (D748)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('least-loaded: an idle cluster hands the first session to the alphabetically-first node', async () => {
    const w = world({ policy: 'least-loaded' })
    await motion(w, 1)
    expect(w.placedOn).toEqual(['agent-a'])
  })

  it('share: parallel sessions follow 70/20/10 — the first to the 70', async () => {
    const w = world({ policy: 'share' })
    for (let id = 1; id <= 10; id++) await motion(w, id)
    const count = (n: string): number => w.placedOn.filter((x) => x === n).length
    expect(w.placedOn[0]).toBe('mac')
    expect([count('mac'), count('hub'), count('agent-a')]).toEqual([7, 2, 1])
  })

  it('share: a node at its cap yields, and the yield is logged and counted', async () => {
    const w = world({ policy: 'share', caps: { mac: 1 } })
    await motion(w, 1)
    await motion(w, 2)
    expect(w.placedOn).toEqual(['mac', 'hub'])
    expect(w.lines.some((l) => l.message.includes('share turn yielded'))).toBe(true)
    const mac = w.stats.snapshot(60 * 60 * 1000).nodes.find((n) => n.nodeId === 'mac')
    expect(mac?.yieldsAway).toBe(1)
  })

  it('a device pin naming a device the node does not offer is said ONCE and ignored', async () => {
    const w = world({ policy: 'share', devicePin: 'edgetpu:usb' })
    await motion(w, 3836)
    await w.controller.handleSessionMotion(3836, false, undefined, 'onboard', CAMERA_TRIGGER)
    await vi.advanceTimersByTimeAsync(120_000)
    await motion(w, 3836)
    const said = w.lines.filter((l) => l.message.startsWith('device pin ignored'))
    expect(said).toHaveLength(1)
    // Ignored ⇒ the single-device node serves it from its default pool.
    const selections = w.lines.filter((l) => l.message === 'inference device selection')
    expect(selections.every((l) => l.meta['chosen'] === null)).toBe(true)
  })

  it('D916: a camera keeps its node across sessions while the share allows it, and says so', async () => {
    const run = async (affinity: boolean): Promise<World> => {
      const w = world({
        policy: 'share',
        weights: { hub: 1, mac: 1, 'agent-a': 1 },
        history: true,
        affinity,
      })
      // Two cameras taking turns — sessions that never overlap.
      for (let i = 0; i < 6; i++) {
        for (const id of [3835, 637]) {
          await motion(w, id)
          await w.controller.handleSessionMotion(id, false, undefined, 'onboard', CAMERA_TRIGGER)
          await vi.advanceTimersByTimeAsync(120_000)
        }
      }
      return w
    }
    const movesOf = (w: World, nth: 0 | 1): number => {
      const mine = w.placedOn.filter((_, i) => i % 2 === nth)
      return mine.filter((n, i) => i > 0 && n !== mine[i - 1]).length
    }
    const plain = await run(false)
    // Without affinity the recency memory rotates a camera on purpose.
    expect(movesOf(plain, 0)).toBeGreaterThan(2)
    const sticky = await run(true)
    expect(movesOf(sticky, 0) + movesOf(sticky, 1)).toBeLessThan(
      movesOf(plain, 0) + movesOf(plain, 1),
    )
    expect(movesOf(sticky, 0)).toBeLessThanOrEqual(2)
    const dispatched = sticky.lines.filter(
      (l) => l.message === 'detection session: dispatched on motion',
    )
    expect(dispatched[0]?.meta).toMatchObject({ sticky: false, stickyReason: 'no-previous' })
    expect(dispatched.some((l) => l.meta['sticky'] === true)).toBe(true)
    for (const l of dispatched) {
      expect(l.meta).toHaveProperty('turnKey')
      expect(l.meta).toHaveProperty('recent')
      expect(l.meta).toHaveProperty('running')
    }
  })

  it('the placement statistics see every session start', async () => {
    const w = world({ policy: 'share' })
    await motion(w, 1)
    await motion(w, 2)
    const snap = w.stats.snapshot(60 * 60 * 1000)
    expect(snap.nodes.reduce((s, n) => s + n.sessionsStarted, 0)).toBe(2)
    expect(snap.sessionsNow).toBe(2)
  })
})
