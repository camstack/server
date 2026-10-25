/**
 * D650 round 2 — a pending-retry sweep never waits for a node's catalog.
 *
 * The re-place paths run cameras SERIALLY under one in-flight flag. When
 * `dispatchCamera` started resolving the pipeline itself, a node the topology
 * reports online but whose pipeline-executor never answers (the 2026-07-17
 * shape) would have held every later camera in the sweep — and every later
 * sweep — forever. `redispatchCamera` reads the catalog from the cache only: the
 * wedged node's camera stays pending, named, and the rest of the sweep runs.
 */
import type { PipelineSchema } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import type { PendingReason } from '../placement-ledger.js'
import {
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeRunnerCameraConfig,
  wireRunnerToBroker,
} from './e2e-helpers.js'

const CATALOG: PipelineSchema = {
  availableEngines: [],
  selectedEngine: { runtime: 'python', backend: 'cpu', format: 'onnx' },
  slots: [
    {
      id: 'detector',
      label: 'Detector',
      priority: 0,
      parentSlot: null,
      addons: [
        {
          id: 'object-detection',
          name: 'object-detection',
          slot: 'detector',
          inputClasses: [],
          outputClasses: ['person'],
          childSlots: [],
          defaultModelId: 'yolo',
          defaultConfidence: 0.5,
          models: [
            { id: 'yolo', name: 'yolo', formats: { onnx: { downloaded: true, sizeMB: 1 } } },
          ],
        },
      ],
    },
  ],
}

class TestOrchestrator extends PipelineOrchestratorAddon {
  peekPendingReason(deviceId: number): PendingReason | undefined {
    return this.ledger?.getPendingReason(deviceId)
  }
  sweep(): Promise<void> {
    return this.retryPendingDispatches()
  }
}

/** Rejects if `promise` does not settle within `ms` — the sweep must not hang. */
async function withinMs<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`sweep did not complete within ${ms}ms`)), ms)
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

const NODES = ['agent-a', 'agent-b', 'agent-c'] as const
const CAMERA_ON: Readonly<Record<string, number>> = { 'agent-a': 11, 'agent-b': 12, 'agent-c': 13 }

describe('pending-retry sweep with one wedged executor (D650 round 2)', () => {
  let addon: TestOrchestrator | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('places the cameras on A and C, leaves B named-pending, and completes; B lands once it answers', async () => {
    const broker = makeFakeBroker('hub')
    const runners = new Map(NODES.map((n) => [n, makeFakeRunner({ nodeId: n })]))
    for (const [nodeId, runner] of runners) {
      wireRunnerToBroker(broker, nodeId, runner)
      broker.addNode(nodeId)
    }
    // agent-b's executor is reachable per topology but never answers — until
    // the test releases it.
    let answerB: (() => void) | null = null
    const bAnswered = new Promise<void>((resolve) => {
      answerB = resolve
    })
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: [] },
      providers: {
        // agent-b's executor answers NOTHING — neither its catalog nor its
        // pool health — until released. Each unanswered read here stands for
        // one broker `requestTimeout` a re-place would otherwise serve, per
        // camera, in series.
        'pipeline-executor': {
          getSchema: (input: { nodeId: string }) =>
            input.nodeId === 'agent-b' ? bAnswered.then(() => CATALOG) : CATALOG,
          getInferenceDeviceHealth: (input: { nodeId: string }) =>
            input.nodeId === 'agent-b'
              ? bAnswered.then(() => ({ unhealthy: [] }))
              : { unhealthy: [] },
        },
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)

    // No node detect-enabled ⇒ the three cameras become KNOWN but unplaced.
    for (const n of NODES) {
      const deviceId = CAMERA_ON[n]!
      await ctx.settings!.writeDeviceStore(deviceId, { pipelineNodeId: n })
      const first = await addon.dispatchCamera(makeRunnerCameraConfig(deviceId)).catch(() => null)
      expect(first?.kind ?? 'unplaced').not.toBe('assigned')
    }
    // The nodes come up; each camera is pinned to its node. A and C have
    // answered the dispatcher once (their device probe is warm); B never has.
    for (const n of NODES) await addon.setAgentCapabilities({ agentNodeId: n, detect: true })
    await addon.resolveEligibleInferenceDevices('agent-a', 'await-catalog')
    await addon.resolveEligibleInferenceDevices('agent-c', 'await-catalog')

    // Sweep 1: completes although agent-b never answers.
    await withinMs(addon.sweep(), 3_000)
    await withinMs(addon.sweep(), 3_000)
    expect(addon.getPipelineAssignment({ deviceId: 11 })?.agentNodeId).toBe('agent-a')
    expect(addon.getPipelineAssignment({ deviceId: 13 })?.agentNodeId).toBe('agent-c')
    expect(addon.getPipelineAssignment({ deviceId: 12 })).toBeNull()
    // B's probe has never come back — the first thing a re-place needs.
    expect(addon.peekPendingReason(12)).toBe('device-health-unavailable:agent-b')
    expect(runners.get('agent-b')!.attachedCameras.has(12)).toBe(false)

    // agent-b answers; the background refresh the sweep started lands, and the
    // NEXT sweep places the camera.
    answerB!()
    for (let round = 0; round < 50; round++) {
      await withinMs(addon.sweep(), 3_000)
      if (addon.getPipelineAssignment({ deviceId: 12 }) !== null) break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(addon.getPipelineAssignment({ deviceId: 12 })?.agentNodeId).toBe('agent-b')
    expect(runners.get('agent-b')!.attachedCameras.has(12)).toBe(true)
  })

  it('a node whose catalog is cold stays pending on a re-place — the root guard never fails open', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'agent-d' })
    wireRunnerToBroker(broker, 'agent-d', runner)
    broker.addNode('agent-d')
    // agent-d answers its pool health but never its catalog: its probe warms,
    // its catalog never does.
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: [] },
      providers: {
        'pipeline-executor': {
          getSchema: () => Promise.reject(new Error('executor not answering its catalog')),
          getInferenceDeviceHealth: () => ({ unhealthy: [] }),
        },
      },
    })
    addon = new TestOrchestrator()
    await addon.initialize(ctx)
    await ctx.settings!.writeDeviceStore(21, { pipelineNodeId: 'agent-d' })
    await addon.dispatchCamera(makeRunnerCameraConfig(21)).catch(() => null)
    await addon.setAgentCapabilities({ agentNodeId: 'agent-d', detect: true })

    // Round 1 finds the probe cold and starts it; later rounds find it warm and
    // the catalog still cold.
    for (let round = 0; round < 20; round++) {
      await withinMs(addon.sweep(), 3_000)
      if (addon.peekPendingReason(21) === 'catalog-unavailable:agent-d') break
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(addon.peekPendingReason(21)).toBe('catalog-unavailable:agent-d')
    expect(addon.getPipelineAssignment({ deviceId: 21 })).toBeNull()
    expect(runner.attachedCameras.has(21)).toBe(false)
  })
})
