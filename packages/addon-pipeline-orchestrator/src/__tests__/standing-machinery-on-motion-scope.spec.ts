/**
 * Phase 3 slice 2 (Task 3) — scope the STANDING placement machinery to
 * `always-on` cameras.
 *
 * Task 2 cut `on-motion` cameras over to session-time dispatch: idle
 * between motion events, no standing `assignments` entry, no `cameraConfigs`
 * entry either (see the doc comment on `reattachAudioForDevice` — a
 * `cameraConfigs` entry with no matching `assignments` entry is exactly
 * what `handleDetectionPipelineReadiness`'s hub-local fallback treats as
 * "needs a standing re-attach", so `startDetection`'s on-motion branch
 * deliberately never populates `cameraConfigs`). That invariant already
 * keeps most of the STANDING sweeps (which iterate `cameraConfigs`) away
 * from on-motion cameras. Task 3 adds an explicit, independent guard to
 * each standing consumer anyway — defense in depth against a future
 * refactor breaking that invariant, and because some consumers
 * (`handleNodeDisconnect`, `reconcilePlacementFromRunners`'s
 * `dropStaleAssignment` half) iterate `assignments`, which DOES hold a
 * live entry for an ACTIVE on-motion session.
 *
 * This suite proves each guard:
 *  (predicate) `isSessionCamera` / `isIdleSessionCamera` reflect
 *    `activeDetections` + `sessionRegistry` state correctly.
 *  (1) the stranded/pending retry sweep does not force-dispatch a
 *    would-be-idle on-motion camera even if a stale `cameraConfigs` entry
 *    existed for it.
 *  (2) `rebalance()` skips that same stale entry.
 *  (3) `handleNodeDisconnect` drops an active session instead of failing
 *    it over.
 *  (4) `handleNodeConnect`'s 'restore' path does not resurrect a standing
 *    attach for an on-motion camera whose session Step 3 just dropped —
 *    the highest-risk consumer per the task brief.
 *  (5) `reconcilePlacementFromRunners`'s `dropStaleAssignment` half drops
 *    a stale session assignment WITHOUT wedging future motion dispatch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventCategory } from '@camstack/types'
import type { CameraDetectionConfig, IEventBus } from '@camstack/types'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

/** Test subclass exposing the `protected` Task 3 predicate seam. */
class TestOrchestrator extends PipelineOrchestratorAddon {
  peekIsSessionCamera(deviceId: number): boolean {
    return this.isSessionCamera(deviceId)
  }
  peekIsIdleSessionCamera(deviceId: number): boolean {
    return this.isIdleSessionCamera(deviceId)
  }
}

function makeOnMotionConfig(overrides: Partial<CameraDetectionConfig> = {}): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['analyzer'],
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    motionFps: 4,
    detectionFps: 10,
    motionCooldownMs: 10_000,
    detectionMode: 'on-motion',
    audioMode: 'disabled',
    onboardMotionDrivesAnalyzer: true,
    occupancyRecheckEnabled: false,
    occupancyRecheckSec: 30,
    occupancyRecheckFrames: 4,
    preRollInferenceEnabled: true,
    preRollInferenceFrames: 12,
    ...overrides,
  }
}

function emitMotion(eventBus: IEventBus, deviceId: number, detected: boolean): void {
  eventBus.emit({
    id: `evt-motion-${deviceId}-${detected}-${Date.now()}`,
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.MotionOnMotionChanged,
    data: { deviceId, detected, timestamp: Date.now(), source: 'onboard' },
  })
}

describe('PipelineOrchestratorAddon — isSessionCamera / isIdleSessionCamera predicate (Task 3)', () => {
  let addon: TestOrchestrator | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('is true+idle for an armed on-motion camera, true+non-idle once a session dispatches, and false for always-on / unknown devices', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'], enabledDecoderNodes: ['hub'] },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    // Unknown device — never seen.
    expect(addon.peekIsSessionCamera(9999)).toBe(false)
    expect(addon.peekIsIdleSessionCamera(9999)).toBe(false)

    // Armed on-motion, idle (no motion fired yet).
    await addon.startDetection(1, makeOnMotionConfig({ motionSources: ['onboard'] }))
    expect(addon.peekIsSessionCamera(1)).toBe(true)
    expect(addon.peekIsIdleSessionCamera(1)).toBe(true)

    // Motion fires — a session dispatches. Still an on-motion camera, but
    // no longer idle.
    emitMotion(eventBus, 1, true)
    await waitUntil(() => addon!.getPipelineAssignment({ deviceId: 1 }) !== null)
    expect(addon.peekIsSessionCamera(1)).toBe(true)
    expect(addon.peekIsIdleSessionCamera(1)).toBe(false)

    // always-on camera — never a session camera, idle or otherwise.
    await addon.startDetection(2, {
      ...makeOnMotionConfig(),
      detectionMode: 'always-on',
      motionSources: [],
    })
    expect(addon.peekIsSessionCamera(2)).toBe(false)
    expect(addon.peekIsIdleSessionCamera(2)).toBe(false)
  })
})

describe('PipelineOrchestratorAddon — Step 1/2 guards: stranded-retry sweep + rebalance() skip an idle on-motion camera (Task 3)', () => {
  let addon: TestOrchestrator | null = null

  afterEach(async () => {
    vi.useRealTimers()
    if (addon) await addon.shutdown()
    addon = null
  })

  /**
   * Seeds a "stale cameraConfigs entry co-existing with an on-motion
   * activeDetections cache" — the state Steps 1/2 defend, reachable via two
   * PUBLIC calls: `dispatchCamera` (which unconditionally populates
   * `cameraConfigs`, the only thing that ever does for a device
   * `startDetection`'s on-motion branch does not touch) followed by
   * `startDetection` with an on-motion config for a device that has NO
   * prior `activeDetections` entry (so `startDetection` does not call
   * `stopDetection` first, which is the only thing that would clear the
   * stale `cameraConfigs` entry).
   */
  /**
   * The pending seed is driven via OVER-CAP (fill the hub's single slot with
   * a standing camera first): `no-frame-source` is no longer reachable from
   * dispatch — decode is co-located with detection, so every detect-enabled
   * node can source frames.
   */
  async function seedStaleCameraConfigsEntry(
    orchestrator: TestOrchestrator,
    deviceId: number,
  ): Promise<void> {
    await orchestrator.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: 1 })
    const filler = await orchestrator.dispatchCamera(makeRunnerCameraConfig(deviceId + 10_000))
    expect(filler.kind).toBe('assigned')
    const first = await orchestrator.dispatchCamera(makeRunnerCameraConfig(deviceId))
    expect(first.kind).toBe('pending') // hub is at its cap — stranded over-cap
    await orchestrator.startDetection(deviceId, makeOnMotionConfig({ motionSources: ['onboard'] }))
    expect(orchestrator.peekIsIdleSessionCamera(deviceId)).toBe(true)
  }

  it('retryPendingDispatches does not force-dispatch the stale entry once capacity frees (debounced sweep)', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    await seedStaleCameraConfigsEntry(addon, 901)

    // Capacity frees — `setAgentMaxCameras` fires the debounced pending-retry
    // sweep. Without the Task 3 guard, `computeStrandedDevices` would include
    // 901 (known via the stale `cameraConfigs` entry, unassigned) and
    // re-dispatch it as a standing camera.
    vi.useFakeTimers()
    await addon.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: null })
    await vi.advanceTimersByTimeAsync(2_100)
    vi.useRealTimers()

    expect(addon.getPipelineAssignment({ deviceId: 901 })).toBeNull()
    expect(runnerHub.attachedCameras.has(901)).toBe(false)
  })

  it('rebalance() skips the stale entry outright', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    await seedStaleCameraConfigsEntry(addon, 902)

    await addon.setAgentMaxCameras({ agentNodeId: 'hub', maxCameras: null })
    // Call rebalance() directly rather than waiting for the debounced sweep.
    await addon.rebalance()

    expect(addon.getPipelineAssignment({ deviceId: 902 })).toBeNull()
    expect(runnerHub.attachedCameras.has(902)).toBe(false)
  })
})

describe('PipelineOrchestratorAddon — Step 3 guard: handleNodeDisconnect drops a session instead of failing it over (Task 3)', () => {
  let addon: TestOrchestrator | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('drops the active on-motion session on disconnect and re-dispatches fresh on the next motion event', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'hub', runnerHub)
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    broker.addNode('agent-a')

    // Both nodes are frame-source eligible — a STANDING camera in this
    // shape would fail over to the surviving node. Deterministic tie-break
    // (equal load) picks the alphabetically-first node: 'agent-a'.
    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['hub', 'agent-a'],
        enabledDecoderNodes: ['hub', 'agent-a'],
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    await addon.startDetection(1001, makeOnMotionConfig({ motionSources: ['onboard'] }))
    emitMotion(eventBus, 1001, true)
    await waitUntil(() => addon!.getPipelineAssignment({ deviceId: 1001 }) !== null)
    const sessionNode = addon.getPipelineAssignment({ deviceId: 1001 })!.agentNodeId
    expect(sessionNode).toBe('agent-a')
    expect(runnerA.attachedCameras.has(1001)).toBe(true)

    // Disconnect the node hosting the session.
    broker.removeNode(sessionNode)
    await waitUntil(() => addon!.getPipelineAssignment({ deviceId: 1001 }) === null)

    // No failover attach landed on the surviving node (hub) — a standing
    // camera would have migrated there instead of being dropped.
    expect(runnerHub.attachedCameras.has(1001)).toBe(false)

    // The session was deregistered (not just the assignment dropped) — the
    // next motion event produces a FRESH dispatch rather than being
    // swallowed by `handleSessionMotion`'s `sessionRegistry.has` gate.
    emitMotion(eventBus, 1001, true)
    await waitUntil(() => addon!.getPipelineAssignment({ deviceId: 1001 }) !== null)
    expect(addon.getPipelineAssignment({ deviceId: 1001 })?.agentNodeId).toBe('hub')
    expect(runnerHub.attachedCameras.has(1001)).toBe(true)
  })
})

describe('PipelineOrchestratorAddon — Step 4 guard: handleNodeConnect restore does not resurrect a dropped session (Task 3, highest risk)', () => {
  let addon: TestOrchestrator | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('reconnect restore leaves an on-motion camera unassigned after its session was dropped on disconnect', async () => {
    const broker = makeFakeBroker('hub')
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    broker.addNode('agent-a')

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['agent-a'], enabledDecoderNodes: ['agent-a'] },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    // Seed a standing attach directly via `dispatchCamera` — models a
    // lingering `cameraConfigs`/`assignments` pair from before this camera
    // was switched to on-motion (e.g. a manual `dispatchCamera` call, or a
    // prior always-on config). Because `activeDetections` has no entry yet,
    // the `startDetection` call right after does NOT run `stopDetection`
    // first, so this stale attach/assignment/cameraConfigs entry survives
    // the mode switch untouched — exactly the state the Task 3 guards
    // defend against.
    const first = await addon.dispatchCamera(
      makeRunnerCameraConfig(1101, { detectionMode: 'always-on' }),
    )
    expect(first.kind).toBe('assigned')
    expect(runnerA.attachedCameras.has(1101)).toBe(true)

    await addon.startDetection(1101, makeOnMotionConfig({ motionSources: ['onboard'] }))
    expect(addon.peekIsSessionCamera(1101)).toBe(true)

    // Disconnect: Step 3 drops the stale standing assignment (agent-a is
    // the only node, so a real failover would leave it pending anyway —
    // the point here is that `assignments` is cleared for it). The fake
    // broker only removes agent-a from its routing table — it does not
    // simulate the disconnected process losing its own pipeline state —
    // so reset the fake runner's attach map by hand to model a genuinely
    // offline node (the orchestrator never called `detachOn`, matching the
    // `leave-unassigned`-style "node is dead, the RPC would fail anyway"
    // reasoning already used elsewhere in `handleNodeDisconnect`).
    broker.removeNode('agent-a')
    runnerA.attachedCameras.delete(1101)
    await waitUntil(() => addon!.getPipelineAssignment({ deviceId: 1101 }) === null)

    // Reconnect: default policy is 'restore', which walks `cameraConfigs`
    // — STILL holding the stale 1101 entry. Without the Step 4 guard,
    // `current` (`assignments.get(1101)`) is `undefined` (Step 3 cleared
    // it), so the loop's `current && current.agentNodeId !== nodeId`
    // check would be FALSE and fall through to force-attach 1101 onto
    // agent-a again as a standing camera.
    broker.addNode('agent-a')
    // No assignment/attach event to poll for (that's exactly what must NOT
    // happen) — wait out a window comfortably larger than the restore
    // loop's synchronous work before asserting the negative.
    await new Promise((resolve) => setTimeout(resolve, 150))

    expect(addon.getPipelineAssignment({ deviceId: 1101 })).toBeNull()
    expect(runnerA.attachedCameras.has(1101)).toBe(false)
  })
})

describe('PipelineOrchestratorAddon — Step 5 guard: reconcilePlacementFromRunners drops a stale session assignment without wedging future dispatch (Task 3)', () => {
  let addon: TestOrchestrator | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('drops a stale on-motion assignment (runner attach silently lost) WITHOUT scheduling a pending retry, and a later motion event dispatches fresh', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'], enabledDecoderNodes: ['hub'] },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    await addon.startDetection(1201, makeOnMotionConfig({ motionSources: ['onboard'] }))
    emitMotion(eventBus, 1201, true)
    await waitUntil(() => addon!.getPipelineAssignment({ deviceId: 1201 }) !== null)
    expect(runnerHub.attachedCameras.has(1201)).toBe(true)

    // Simulate the runner losing the attach WITHOUT going through the
    // orchestrator's own detach flow (a phantom loss / runner-side crash
    // recovery) — `assignments` still believes the session is live, but
    // `getLocalCameras` truth no longer lists it.
    runnerHub.attachedCameras.delete(1201)

    // Nudge a reconcile pass (`AgentOnline` on the already-connected hub
    // fires `scheduleReconcile` → `reconcileDispatch` →
    // `reconcilePlacementFromRunners`, its normal production trigger).
    broker.addNode('hub')
    await waitUntil(() => addon!.getPipelineAssignment({ deviceId: 1201 }) === null, 2_000)

    // Fire motion again — if the stale session had been left registered in
    // `sessionRegistry` (guard broken: assignment dropped but session not
    // deregistered), `handleSessionMotion` would see `sessionRegistry.has`
    // true and its dispatch branch would bail out WITHOUT a fresh attach,
    // leaving the camera stuck forever. With the guard, the session was
    // deregistered alongside the assignment, so this produces a brand-new
    // dispatch.
    emitMotion(eventBus, 1201, true)
    await waitUntil(() => addon!.getPipelineAssignment({ deviceId: 1201 }) !== null, 2_000)
    expect(runnerHub.attachedCameras.has(1201)).toBe(true)
  })
})
