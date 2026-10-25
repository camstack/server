/**
 * `setPipelineDevicePin` (Block D3) — per-camera INFERENCE DEVICE pin.
 *
 * Sibling of `assignPipeline`: `assignPipeline` moves a camera between NODES;
 * `setPipelineDevicePin` pins the accelerator (device pool) WITHIN the node. The
 * device is chosen per SESSION (the second `balance()` pass at dispatch), so a
 * running session already committed to a device — the setter closes it so the
 * next dispatch re-picks onto the pin. The camera stays on the SAME node (a
 * device pin never migrates between nodes). `'auto'`/empty clears the pin.
 *
 * Seam: reuses the two-node fake-broker harness from
 * `assign-pipeline-session-migration.spec.ts`.
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

/** Exposes the `protected` session registry + the private device-pin reader. */
class TestOrchestrator extends PipelineOrchestratorAddon {
  peekHasActiveSession(deviceId: number): boolean {
    return this.sessionRegistry.has(deviceId)
  }
  peekDevicePin(deviceId: number): Promise<string | null> {
    return (
      this as unknown as { readPipelineDevicePin: (id: number) => Promise<string | null> }
    ).readPipelineDevicePin(deviceId)
  }
}

interface SessionFixture {
  orch: TestOrchestrator
  runnerA: ReturnType<typeof makeFakeRunner>
  fireMotion: (deviceId: number) => void
}

/** Two frame-source-eligible nodes; an on-motion camera whose session lands on
 *  `agent-a` (equal scores → alphabetical tie-break picks 'agent-a' over 'hub'). */
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
      // This spec is about the device pin, not about spreading sessions: under
      // `share` the election remembers the first session and alternates nodes,
      // which is intended but not what is tested here.
      sessionPlacement: 'least-loaded',
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
  expect(orch.peekHasActiveSession(deviceId)).toBe(true)

  return { orch, runnerA, fireMotion }
}

describe('setPipelineDevicePin — per-camera inference device affinity', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('persists the device key, closes the active session, and re-dispatches on the SAME node', async () => {
    const { orch, runnerA, fireMotion } = await startSessionOnAgentA(810)
    addon = orch

    await orch.setPipelineDevicePin({ deviceId: 810, deviceKey: 'openvino:npu' })

    // The pin is persisted (readable via readPipelineDevicePin).
    await expect(orch.peekDevicePin(810)).resolves.toBe('openvino:npu')
    // The running session is closed so the next dispatch re-picks the device.
    expect(orch.peekHasActiveSession(810)).toBe(false)
    expect(runnerA.attachedCameras.has(810)).toBe(false)

    // The camera stays on the SAME node — a device pin never moves it: the next
    // motion re-dispatches onto agent-a again (no node pin, agent-a wins).
    fireMotion(810)
    await waitUntil(() => runnerA.attachedCameras.has(810))
    expect(orch.getPipelineAssignment({ deviceId: 810 })?.agentNodeId).toBe('agent-a')
  })

  it("'auto' clears the device pin", async () => {
    const { orch } = await startSessionOnAgentA(811)
    addon = orch

    await orch.setPipelineDevicePin({ deviceId: 811, deviceKey: 'edgetpu:usb' })
    await expect(orch.peekDevicePin(811)).resolves.toBe('edgetpu:usb')

    await orch.setPipelineDevicePin({ deviceId: 811, deviceKey: 'auto' })
    // 'auto' reads back as null (no concrete pin) per readPipelineDevicePin.
    await expect(orch.peekDevicePin(811)).resolves.toBeNull()
  })
})
