/**
 * Phase 3 slice 2 (Task 2) — on-motion cameras cut over to session-time
 * dispatch.
 *
 * `startDetection` no longer standing-attaches an `on-motion` camera: an
 * analyzer-class camera gets a watch-only attach on the singleton
 * `clusterRoles.motionNode` role instead (grey-decode keeps emitting
 * `MotionOnMotionChanged`); an onboard-only camera gets no attach at all
 * while idle (firmware emits motion itself). The already-wired
 * `handleSessionMotion` subscriber (Task 1) then owns dispatch/teardown for
 * real motion events. `stopDetection` must clean up BOTH an active session
 * and any motion-watch attach.
 *
 * Seam: same as `first-dispatch-node-reresolve.spec.ts` — call
 * `PipelineOrchestratorAddon#startDetection`/`#stopDetection` directly with a
 * hand-built `CameraDetectionConfig`, driving the real dispatch/attach path
 * end to end through a fake two-node broker.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventCategory } from '@camstack/types'
import type { CameraDetectionConfig, IScopedLogger } from '@camstack/types'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

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

/**
 * Test subclass exposing the `protected` `sessionRegistry` seam (mirrors the
 * `audioSubscriptions`/`pendingReasons` convention) so the C1 regression
 * test below can assert directly on session-registry state rather than
 * inferring it from `assignments`/runner-attach side effects alone.
 */
class TestOrchestrator extends PipelineOrchestratorAddon {
  peekHasActiveSession(deviceId: number): boolean {
    return this.sessionRegistry.has(deviceId)
  }
}

describe('PipelineOrchestratorAddon — on-motion session-time cutover (Task 2)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('analyzer-class on-motion camera: startDetection does NOT standing-dispatch — only a watch-only attach lands on the motionNode role', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.startDetection(801, makeOnMotionConfig())

    // No standing placement — the whole point of the cutover.
    expect(addon.getPipelineAssignment({ deviceId: 801 })).toBeNull()

    // A watch-only attach DID land (analyzer-class) — but it is NOT a
    // detection dispatch: no pipeline runs, motion-sourcing only.
    const attached = runnerHub.attachedCameras.get(801)
    expect(attached).toBeDefined()
    expect(attached?.detectionMode).toBe('disabled')
    expect(attached?.motionSources).toEqual(['analyzer'])
    expect(attached?.pipelineEnabled).toBe(false)
  })

  it('onboard-only on-motion camera: startDetection attaches nothing while idle', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.startDetection(802, makeOnMotionConfig({ motionSources: ['onboard'] }))

    expect(addon.getPipelineAssignment({ deviceId: 802 })).toBeNull()
    expect(runnerHub.attachedCameras.has(802)).toBe(false)
    const statuses = await addon.getCameraStatuses({})
    expect(statuses.map((status) => status.deviceId)).toContain(802)
    expect(statuses.find((status) => status.deviceId === 802)?.assignment.reasons.detection).toBe(
      'armed:on-motion',
    )
  })

  it('removes an unassigned stale session attach before dispatching a fresh session', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'hub', runnerHub)
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    broker.addNode('agent-a')

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['hub', 'agent-a'],
        enabledDecoderNodes: ['hub', 'agent-a'],
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    const activeAddon = addon

    await activeAddon.startDetection(805, makeOnMotionConfig({ motionSources: ['onboard'] }))
    // Simulate the live failure: a runner survived an orchestrator restart, so
    // it still owns the camera while the new in-memory ledger is empty.
    await runnerA.attachCamera(makeRunnerCameraConfig(805))
    expect(activeAddon.getPipelineAssignment({ deviceId: 805 })).toBeNull()

    eventBus.emit({
      id: 'evt-motion-orphan',
      timestamp: new Date(),
      source: { type: 'device', id: 805 },
      category: EventCategory.MotionOnMotionChanged,
      data: { deviceId: 805, detected: true, timestamp: Date.now(), source: 'onboard' },
    })

    await waitUntil(() => activeAddon.getPipelineAssignment({ deviceId: 805 }) !== null)
    const assignedNode = activeAddon.getPipelineAssignment({ deviceId: 805 })?.agentNodeId
    const attachedNodes = [
      ...(runnerHub.attachedCameras.has(805) ? ['hub'] : []),
      ...(runnerA.attachedCameras.has(805) ? ['agent-a'] : []),
    ]
    expect(attachedNodes).toEqual([assignedNode])
  })

  it('stopDetection tears down BOTH an active detection session and a motion-watch attach', async () => {
    // Two-node fleet: `hub` holds the motionNode role (default), `agent-a` is
    // the only frame-source-eligible node — so the watch-only attach lands on
    // `hub` and the motion-triggered session dispatch lands on `agent-a`.
    // Distinct nodes let the assertions tell the two teardowns apart.
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'hub', runnerHub)
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    broker.addNode('agent-a')

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['hub', 'agent-a'],
        enabledDecoderNodes: ['agent-a'],
      },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    await addon.startDetection(803, makeOnMotionConfig())

    // Watch-only attach ensured on the motionNode role (hub).
    await waitUntil(() => runnerHub.attachedCameras.has(803))
    expect(runnerHub.attachedCameras.has(803)).toBe(true)

    // Fire real motion — the session subscriber dispatches a detection
    // session on the only frame-source-eligible node (agent-a).
    eventBus.emit({
      id: 'evt-motion-on',
      timestamp: new Date(),
      source: { type: 'device', id: 803 },
      category: EventCategory.MotionOnMotionChanged,
      data: { deviceId: 803, detected: true, timestamp: Date.now(), source: 'analyzer' },
    })
    await waitUntil(() => runnerA.attachedCameras.has(803))
    expect(runnerA.attachedCameras.has(803)).toBe(true)
    expect(addon.getPipelineAssignment({ deviceId: 803 })?.agentNodeId).toBe('agent-a')

    // Now stop detection entirely (e.g. binding toggled off / device removed).
    await addon.stopDetection(803)

    // Both the session attach (agent-a) AND the motion-watch attach (hub)
    // must be gone — not just one of them.
    expect(runnerA.attachedCameras.has(803)).toBe(false)
    expect(runnerHub.attachedCameras.has(803)).toBe(false)
    expect(addon.getPipelineAssignment({ deviceId: 803 })).toBeNull()
  })

  it('C1 regression: a stopDetection racing a motion-triggered dispatch leaves NO orphan session/assignment/attach', async () => {
    // Same two-node shape as the "tears down BOTH" test above: hub holds the
    // motionNode watch-only attach, agent-a is the only frame-source-eligible
    // node and hosts the session attach.
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    const runnerA = makeFakeRunner({ nodeId: 'agent-a' })
    wireRunnerToBroker(broker, 'hub', runnerHub)
    wireRunnerToBroker(broker, 'agent-a', runnerA)
    broker.addNode('agent-a')

    // Gate the SECOND `detachCamera` RPC to agent-a. Call #1 is
    // `releaseCamera`'s own detach (fires before `stopDetection` ever takes
    // the session lock — resolves immediately, uncontrolled). Call #2 is
    // `stopDetection`'s own session-lock detach (the M2 idempotent
    // belt-and-suspenders one) — gating THIS call stalls `stopDetection`
    // deterministically while it is inside the session-lock critical
    // section, which is exactly the window C1 closes.
    let detachCallCount = 0
    let releaseSecondDetach!: () => void
    const secondDetachGate = new Promise<void>((resolve) => {
      releaseSecondDetach = resolve
    })
    broker.registerAction(
      'agent-a',
      'pipeline-runner.pipeline-runner.detachCamera',
      async (input) => {
        detachCallCount += 1
        if (detachCallCount === 2) await secondDetachGate
        return runnerA.detachCamera(input as { deviceId: number })
      },
    )

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: {
        enabledNodes: ['hub', 'agent-a'],
        enabledDecoderNodes: ['agent-a'],
      },
    })
    const orch = new TestOrchestrator()
    addon = orch
    await orch.initialize(ctx)

    await orch.startDetection(804, makeOnMotionConfig())
    await waitUntil(() => runnerHub.attachedCameras.has(804))

    // Real motion — dispatches a session onto agent-a (the only
    // frame-source-eligible node).
    eventBus.emit({
      id: 'evt-motion-on-1',
      timestamp: new Date(),
      source: { type: 'device', id: 804 },
      category: EventCategory.MotionOnMotionChanged,
      data: { deviceId: 804, detected: true, timestamp: Date.now(), source: 'analyzer' },
    })
    await waitUntil(() => runnerA.attachedCameras.has(804))
    expect(orch.getPipelineAssignment({ deviceId: 804 })?.agentNodeId).toBe('agent-a')
    expect(orch.peekHasActiveSession(804)).toBe(true)

    // Begin `stopDetection` WITHOUT awaiting it, then let it run until it is
    // stalled on the gated 2nd detach — proving it is inside the session
    // lock's critical section. Fire a fresh motion event at that exact
    // moment: its pre-lock `activeDetections` read still sees the (not yet
    // deleted) config, and its own `withSessionLock` call chains AFTER
    // stop's (stop's lock was already taken, synchronously, before it hit
    // the gate) — the precise interleaving described in the C1 bug report.
    const stopPromise = orch.stopDetection(804)
    await waitUntil(() => detachCallCount === 2)

    eventBus.emit({
      id: 'evt-motion-on-2',
      timestamp: new Date(),
      source: { type: 'device', id: 804 },
      category: EventCategory.MotionOnMotionChanged,
      data: { deviceId: 804, detected: true, timestamp: Date.now(), source: 'analyzer' },
    })

    releaseSecondDetach()
    await stopPromise

    // Let the racing motion event's queued (chained-behind-stop) session
    // lock body fully settle — a buggy re-dispatch has several RPC hops
    // (readPipelinePin/collectAgentLoad/attachOn) to run to completion.
    await new Promise((resolve) => setTimeout(resolve, 200))

    // No orphan: no session, no standing assignment, no runner attach.
    expect(orch.peekHasActiveSession(804)).toBe(false)
    expect(orch.getPipelineAssignment({ deviceId: 804 })).toBeNull()
    expect(runnerA.attachedCameras.has(804)).toBe(false)
  })

  it('an event from a source the camera does not list opens no session (whole addon)', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    const activeAddon = addon

    await activeAddon.startDetection(806, makeOnMotionConfig({ motionSources: ['onboard'] }))
    eventBus.emit({
      id: 'evt-motion-unlisted',
      timestamp: new Date(),
      source: { type: 'device', id: 806 },
      category: EventCategory.MotionOnMotionChanged,
      data: { deviceId: 806, detected: true, timestamp: Date.now(), source: 'analyzer' },
    })
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(activeAddon.getPipelineAssignment({ deviceId: 806 })).toBeNull()
    expect(runnerHub.attachedCameras.has(806)).toBe(false)
  })

  it('a device-activity event reaches the dispatcher WITH its trigger — the session runs at the activity rate', async () => {
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    const activeAddon = addon

    await activeAddon.startDetection(
      807,
      makeOnMotionConfig({
        motionSources: ['device-activity'],
        detectionFps: 10,
        activityDetectionFps: 1,
      }),
    )
    eventBus.emit({
      id: 'evt-motion-activity',
      timestamp: new Date(),
      source: { type: 'device', id: 807 },
      category: EventCategory.MotionOnMotionChanged,
      data: { deviceId: 807, detected: true, timestamp: Date.now(), source: 'device-activity' },
    })

    await waitUntil(() => activeAddon.getPipelineAssignment({ deviceId: 807 }) !== null)
    const attached = runnerHub.attachedCameras.get(807)
    expect(attached?.detectionFps).toBe(1)
  })

  it('an unknown source is dropped with a line, not dispatched as the camera rate', async () => {
    const warns: { message: string; tags: Record<string, unknown> }[] = []
    const noop = (): void => {}
    const logger: IScopedLogger = {
      info: noop,
      debug: noop,
      error: noop,
      warn: (message: string, opts?: { tags?: Record<string, unknown> }) => {
        warns.push({ message, tags: opts?.tags ?? {} })
      },
      child: () => logger,
      withTags: () => logger,
    }
    const broker = makeFakeBroker('hub')
    const runnerHub = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runnerHub)

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: ['hub'] },
      logger,
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    const activeAddon = addon

    await activeAddon.startDetection(808, makeOnMotionConfig({ motionSources: ['onboard'] }))
    eventBus.emit({
      id: 'evt-motion-unknown',
      timestamp: new Date(),
      source: { type: 'device', id: 808 },
      category: EventCategory.MotionOnMotionChanged,
      data: { deviceId: 808, detected: true, timestamp: Date.now(), source: 'newer-node-source' },
    })
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(activeAddon.getPipelineAssignment({ deviceId: 808 })).toBeNull()
    expect(runnerHub.attachedCameras.has(808)).toBe(false)
    const line = warns.find((w) => w.message === 'session motion dropped — unknown source')
    expect(line?.tags).toMatchObject({ deviceId: 808 })
  })

  it('camera sensors: an unwatched device moves nothing, and shutdown stops the sustain tick (D672)', async () => {
    // Only intervals are faked: the sustain tick is one, and every other
    // interval the addon starts is one too, so "count after shutdown equals
    // count before init" proves the teardown reaches every source.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const infos: string[] = []
      const noop = (): void => {}
      const logger: IScopedLogger = {
        info: (message: string) => {
          infos.push(message)
        },
        debug: noop,
        warn: noop,
        error: noop,
        child: () => logger,
        withTags: () => logger,
      }
      const PIR = 3299
      const broker = makeFakeBroker('hub')
      wireRunnerToBroker(broker, 'hub', makeFakeRunner({ nodeId: 'hub' }))
      const { ctx, eventBus, captured } = makeFakeContext({
        addonConfig: { moleculerBroker: broker },
        initialGlobalSettings: { enabledNodes: ['hub'] },
        initialDeviceSettings: new Map([
          [
            809,
            {
              cameraSensors: {
                mode: 'in-addition',
                sensors: [{ addonId: 'provider-homeassistant', stableId: 'ha:porch-pir' }],
              },
            },
          ],
        ]),
        sensorDevices: [
          {
            id: PIR,
            addonId: 'provider-homeassistant',
            stableId: 'ha:porch-pir',
            capNames: ['motion'],
          },
        ],
        logger,
      })
      const before = vi.getTimerCount()
      addon = new PipelineOrchestratorAddon()
      await addon.initialize(ctx)
      await waitUntil(() => infos.includes('camera-sensors: attachment ready'))

      const stateChanged = (deviceId: number, detected: boolean, at: number): void => {
        eventBus.emit({
          id: `evt-state-${deviceId}-${at}`,
          timestamp: new Date(at),
          source: { type: 'device', id: deviceId },
          category: EventCategory.DeviceStateChanged,
          data: { deviceId, capName: 'motion', slice: { detected, lastDetectedAt: at } },
        })
      }
      const motions = () =>
        captured.filter((e) => e.category === EventCategory.MotionOnMotionChanged)
      const now = Date.now()
      stateChanged(9_999, false, now)
      stateChanged(9_999, true, now + 1)
      expect(motions()).toEqual([])

      // The attached PIR rises: the camera does not list `onboard` (no active
      // detection), so nothing is forwarded — but the sustain tick is armed.
      stateChanged(PIR, false, now)
      stateChanged(PIR, true, now + 1)
      expect(infos).toContain('camera-sensors: attached sensor triggered camera motion')
      expect(vi.getTimerCount()).toBeGreaterThan(before)

      await addon.shutdown()
      addon = null
      expect(vi.getTimerCount()).toBe(before)
    } finally {
      vi.useRealTimers()
    }
  })
})
