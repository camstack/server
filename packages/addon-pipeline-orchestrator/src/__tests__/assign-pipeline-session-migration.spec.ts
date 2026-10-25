/**
 * `assignPipeline` × session-time dispatch (on-motion cameras).
 *
 * Bug (cam-104, 2026-07-16): pinning an on-motion camera while a detection
 * session is ACTIVE on a different node was a silent no-op — session cameras
 * never populate `ledger.setConfig`, so `assignPipeline` always took the
 * "no cached config yet" early return: the pin persisted, but the running
 * session stayed on the old node and — because continuous motion keeps
 * cancelling the cooldown teardown — could stay there indefinitely. The
 * operator saw the stale pre-pin `{pinned:false, reason:'capacity'}`
 * assignment record and concluded the pin was ignored.
 *
 * Desired behaviour: pinning a session camera to a DIFFERENT node closes the
 * active session (detach + drop + deregister, camera stays armed) so the next
 * motion event re-dispatches onto the pinned node via the balancer's manual
 * affinity (L1). Pinning to the node the session already runs on keeps the
 * session (no churn) and re-stamps the assignment record as manual/pinned.
 *
 * Seam: same as `on-motion-session-cutover.spec.ts` — drive
 * `startDetection` + real `MotionOnMotionChanged` events through the fake
 * two-node broker, then call `assignPipeline` mid-session.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { EventCategory } from '@camstack/types'
import type { CameraDetectionConfig } from '@camstack/types'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

function makeOnboardOnMotionConfig(
  overrides: Partial<CameraDetectionConfig> = {},
): CameraDetectionConfig {
  return {
    enabled: true,
    pipelineEnabled: true,
    motionSources: ['onboard'],
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

/** Exposes the `protected` `sessionRegistry` seam (same convention as `on-motion-session-cutover.spec.ts`). */
class TestOrchestrator extends PipelineOrchestratorAddon {
  peekHasActiveSession(deviceId: number): boolean {
    return this.sessionRegistry.has(deviceId)
  }
}

interface SessionFixture {
  orch: TestOrchestrator
  runnerHub: ReturnType<typeof makeFakeRunner>
  runnerA: ReturnType<typeof makeFakeRunner>
  fireMotion: (deviceId: number) => void
}

/**
 * Two-node fleet, BOTH frame-source-eligible, with an on-motion camera whose
 * active session deterministically lands on `agent-a` (equal capacity scores
 * → the balancer's alphabetical tie-break picks 'agent-a' over 'hub').
 */
async function startSessionOnAgentA(deviceId: number): Promise<SessionFixture> {
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
  const orch = new TestOrchestrator()
  await orch.initialize(ctx)

  const fireMotion = (id: number): void => {
    eventBus.emit({
      id: `evt-motion-${id}-${Math.random().toString(36).slice(2)}`,
      timestamp: new Date(),
      source: { type: 'device', id },
      category: EventCategory.MotionOnMotionChanged,
      data: { deviceId: id, detected: true, timestamp: Date.now(), source: 'onboard' },
    })
  }

  await orch.startDetection(deviceId, makeOnboardOnMotionConfig())
  fireMotion(deviceId)
  await waitUntil(() => runnerA.attachedCameras.has(deviceId))

  expect(orch.getPipelineAssignment({ deviceId })?.agentNodeId).toBe('agent-a')
  expect(orch.getPipelineAssignment({ deviceId })?.pinned).toBe(false)
  expect(orch.peekHasActiveSession(deviceId)).toBe(true)

  return { orch, runnerHub, runnerA, fireMotion }
}

describe('assignPipeline — session-mode (on-motion) cameras', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('pin to a DIFFERENT node closes the active session; the next motion re-dispatches onto the pinned node as manual/pinned', async () => {
    const { orch, runnerHub, runnerA, fireMotion } = await startSessionOnAgentA(805)
    addon = orch

    await orch.assignPipeline({ deviceId: 805, agentNodeId: 'hub' })

    // The stale session on agent-a is GONE — detached, deregistered, and its
    // pre-pin `{pinned:false}` assignment record dropped (no more stale
    // "capacity/hub"-style records shadowing the pin).
    expect(runnerA.attachedCameras.has(805)).toBe(false)
    expect(orch.peekHasActiveSession(805)).toBe(false)
    expect(orch.getPipelineAssignment({ deviceId: 805 })).toBeNull()

    // The camera stayed ARMED: the very next motion event re-dispatches a
    // session — now onto the pinned node, via the balancer's manual affinity.
    fireMotion(805)
    await waitUntil(() => runnerHub.attachedCameras.has(805))

    const assignment = orch.getPipelineAssignment({ deviceId: 805 })
    expect(assignment?.agentNodeId).toBe('hub')
    expect(assignment?.pinned).toBe(true)
    expect(assignment?.reason).toBe('manual')
    expect(runnerA.attachedCameras.has(805)).toBe(false)
  })

  it('pin to the node the session ALREADY runs on keeps the session (no churn) and re-stamps the record as manual/pinned', async () => {
    const { orch, runnerA } = await startSessionOnAgentA(806)
    addon = orch

    await orch.assignPipeline({ deviceId: 806, agentNodeId: 'agent-a' })

    // Session untouched — still attached, still registered.
    expect(runnerA.attachedCameras.has(806)).toBe(true)
    expect(orch.peekHasActiveSession(806)).toBe(true)

    // But the record now tells the truth: this placement is manual + pinned.
    const assignment = orch.getPipelineAssignment({ deviceId: 806 })
    expect(assignment?.agentNodeId).toBe('agent-a')
    expect(assignment?.pinned).toBe(true)
    expect(assignment?.reason).toBe('manual')
  })
})
