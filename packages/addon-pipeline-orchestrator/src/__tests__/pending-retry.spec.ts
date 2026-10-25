/**
 * T3 — Pending/stranded retry sweep.
 *
 * `reconcileDispatch` is additive-only over `cameraConfigs`, so a camera that
 * is KNOWN (has a runner config) but UNASSIGNED (pending / over-cap /
 * no-frame-source / load-shed) is invisible to it forever. The sweep computes
 * the stranded set (`known \ assigned`) and re-runs `dispatchCamera` for each,
 * so freed capacity / newly-eligible nodes recover stranded cameras without a
 * manual poke.
 *
 * This suite has two layers:
 *  1. `computeStrandedDevices` — the pure set-difference helper (mirror of the
 *     dispatch-gap helper in `dispatch-reconcile.ts`).
 *  2. The orchestrator wiring — a camera left pending by an `over-cap` node is
 *     re-dispatched by the debounced sweep once the cap is raised, and the
 *     pending reason surfaces in `getCameraStatus`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import type { PendingReason } from '../placement-ledger.js'
import { computeStrandedDevices } from '../pending-retry.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

/** Test subclass exposing the protected `pendingReasons` seam. */
class TestOrchestrator extends PipelineOrchestratorAddon {
  peekPendingReason(deviceId: number): PendingReason | undefined {
    return this.ledger?.getPendingReason(deviceId)
  }
}

interface TrpcLeaf {
  query: (input?: unknown) => Promise<unknown>
  mutate: (input?: unknown) => Promise<unknown>
}

/** A tRPC node whose every missing method degrades to a null-resolving leaf. */
function degradingNode(): TrpcLeaf {
  const leaf: TrpcLeaf = {
    query: () => Promise.resolve(null),
    mutate: () => Promise.resolve(null),
  }
  return new Proxy(leaf, {
    get(target, prop) {
      if (prop === 'query' || prop === 'mutate') return target[prop]
      return degradingNode()
    },
  })
}

/**
 * Wrap a fake `ctx.api` so any namespace/method absent from the default harness
 * degrades to a null-resolving tRPC leaf. `getCameraStatus` fans out to ~6
 * remote stages (recording / rtsp-entries / engine provisioning / …) that the
 * lightweight harness doesn't stub; we only assert on the orchestrator-local
 * assignment block, so degrading the rest keeps the call from throwing.
 */
function degradingApi(real: Record<string, unknown>): Record<string, unknown> {
  return new Proxy(real, {
    get(target, prop) {
      if (typeof prop !== 'string') return Reflect.get(target, prop)
      const val = target[prop]
      if (val === undefined) return degradingNode()
      if (val !== null && typeof val === 'object' && !('query' in val) && !('mutate' in val)) {
        return degradingApi(val as Record<string, unknown>)
      }
      return val
    },
  })
}

describe('computeStrandedDevices', () => {
  it('returns known devices absent from the assigned set', () => {
    expect(computeStrandedDevices(new Set([1, 2, 3]), new Set([2]))).toEqual([1, 3])
  })

  it('returns [] when nothing is known', () => {
    expect(computeStrandedDevices(new Set<number>(), new Set([2]))).toEqual([])
  })

  it('returns [] when every known device is assigned (assigned ⊇ known)', () => {
    expect(computeStrandedDevices(new Set([1, 2]), new Set([1, 2, 3]))).toEqual([])
  })
})

describe('PipelineOrchestratorAddon — pending retry sweep (T3)', () => {
  let addon: TestOrchestrator

  afterEach(async () => {
    vi.useRealTimers()
    if (addon) await addon.shutdown()
  })

  it('re-dispatches an over-cap-stranded camera once the cap is raised (debounced sweep)', async () => {
    const broker = makeFakeBroker('hub')
    const hubRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', hubRunner)

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    // Cap the hub at ONE camera, fill the slot, then dispatch a second
    // camera: it is known but cannot be placed — pending(over-cap).
    // (`no-frame-source` is no longer reachable from dispatch: decode is
    // co-located with detection, so every detect-enabled node can source.)
    await addon.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: 1 })
    const first = await addon.dispatchCamera(makeRunnerCameraConfig(2))
    expect(first.kind).toBe('assigned')
    const second = await addon.dispatchCamera(makeRunnerCameraConfig(1))
    expect(second.kind).toBe('pending')
    expect(addon.getPipelineAssignment({ deviceId: 1 })).toBeNull()
    expect(addon.peekPendingReason(1)).toBe('over-cap')

    // Raise the cap. `setAgentMaxCameras` fires the debounced pending-retry
    // sweep, which recovers the stranded camera without a manual poke.
    vi.useFakeTimers()
    await addon.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: null })
    await vi.advanceTimersByTimeAsync(2_100)
    vi.useRealTimers()

    // The stranded camera is re-dispatched and attaches to the hub.
    await waitUntil(() => addon.getPipelineAssignment({ deviceId: 1 }) !== null, 2_000)
    expect(addon.getPipelineAssignment({ deviceId: 1 })?.agentNodeId).toBe('hub')
    expect(hubRunner.attachedCameras.has(1)).toBe(true)
  })

  it('surfaces the pending reason in getCameraStatus (pending:over-cap)', async () => {
    const broker = makeFakeBroker('hub')
    const hubRunner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', hubRunner)

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
    })
    // getCameraStatus fans out to remote stages the lightweight harness omits;
    // degrade the unstubbed ones to null so only the assignment block is asserted.
    ;(ctx as { api: Record<string, unknown> }).api = degradingApi(
      (ctx as { api: Record<string, unknown> }).api,
    )
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    // Fill the hub's single slot, then strand a second camera over-cap.
    await addon.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: 1 })
    await addon.dispatchCamera(makeRunnerCameraConfig(2))
    await addon.dispatchCamera(makeRunnerCameraConfig(1))
    expect(addon.peekPendingReason(1)).toBe('over-cap')

    const status = await addon.getCameraStatus({ deviceId: 1 })
    expect(status.assignment.detectionNodeId).toBeNull()
    expect(status.assignment.reasons.detection).toBe('pending:over-cap')
  })
})
