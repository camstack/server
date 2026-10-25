/**
 * D650 round 3 — a placement never attaches a camera without its root.
 *
 * Round 2 made the device eligibility's root guard read the catalog from the
 * cache, for EVERY path. On a cold cache it failed open: a first dispatch
 * could elect a Coral with no tflite root build, the resolve then dropped the
 * root, and the camera was attached with no detector and recorded as placed —
 * nothing would ever re-place it. Now a first placement waits for the catalog
 * before electing, and any attach whose elected device cannot run a gated-on
 * root is refused, named, and left pending.
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

function build(
  formats: readonly string[],
): Record<string, { downloaded: boolean; sizeMB: number }> {
  return Object.fromEntries(formats.map((f) => [f, { downloaded: true, sizeMB: 1 }]))
}

/** The root ships an OPENVINO build only — a Coral cannot run it. */
function catalog(rootFormats: readonly string[], selected: 'openvino'): PipelineSchema {
  return {
    availableEngines: [],
    selectedEngine: { runtime: 'python', backend: selected, format: selected },
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
            models: [{ id: 'yolo', name: 'yolo', formats: build(rootFormats) }],
          },
        ],
      },
    ],
  }
}

function device(key: string, format: string) {
  const [backend, dev] = key.split(':')
  return { key, backend, device: dev, format, runtime: 'python', score: 10, available: true }
}

class TestOrchestrator extends PipelineOrchestratorAddon {
  peekPendingReason(deviceId: number): PendingReason | undefined {
    return this.ledger?.getPendingReason(deviceId)
  }
}

interface Booted {
  readonly addon: TestOrchestrator
  readonly runner: ReturnType<typeof makeFakeRunner>
  /** From now on the node's executor answers its catalog; before, every read fails. */
  readonly answerCatalog: () => void
}

async function boot(
  schema: PipelineSchema,
  devices: readonly ReturnType<typeof device>[],
): Promise<Booted> {
  const broker = makeFakeBroker('hub')
  const runner = makeFakeRunner({ nodeId: 'agent-a' })
  wireRunnerToBroker(broker, 'agent-a', runner)
  broker.addNode('agent-a')
  let answering = false
  const { ctx } = makeFakeContext({
    addonConfig: { moleculerBroker: broker },
    initialGlobalSettings: { enabledNodes: ['agent-a'] },
    providers: {
      'pipeline-executor': {
        // A COLD cache: every read fails (so nothing is cached) until the test
        // lets the node answer — then it answers after a beat, so the
        // dispatch's own read is the first that lands.
        getSchema: () => {
          if (!answering) return Promise.reject(new Error('executor not answering yet'))
          return new Promise((resolve) => setTimeout(() => resolve(schema), 10))
        },
      },
      'platform-probe': {
        getCapabilities: () => ({ nodeId: 'agent-a', reachable: true, devices }),
      },
    },
  })
  const addon = new TestOrchestrator()
  await addon.initialize(ctx)
  const enabled = Object.fromEntries(devices.map((d) => [d.key, { enabled: true }]))
  await addon.setAgentInferenceDevices({ agentNodeId: 'agent-a', inferenceDevices: enabled })
  return {
    addon,
    runner,
    answerCatalog: () => {
      answering = true
    },
  }
}

describe('a placement never attaches a camera without its root (D650 round 3)', () => {
  let addon: TestOrchestrator | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('cold cache + first dispatch: waits for the catalog and never elects the Coral', async () => {
    const booted = await boot(catalog(['openvino'], 'openvino'), [
      device('edgetpu:usb', 'tflite'),
      device('openvino:npu', 'openvino'),
    ])
    addon = booted.addon
    booted.answerCatalog()

    const result = await addon.dispatchCamera(makeRunnerCameraConfig(900))

    expect(result.kind).toBe('assigned')
    const attached = booted.runner.attachedCameras.get(900)
    expect(attached?.deviceKey).not.toBe('edgetpu:usb')
    expect(attached?.steps?.map((s) => s.addonId)).toEqual(['object-detection'])
  })

  it('refuses an attach whose elected device cannot run the root — named, pending, no assignment', async () => {
    // The only device the node has is one the root does not build for, and the
    // guard excludes it — the default pool is the node's own openvino engine.
    const booted = await boot(catalog(['tflite'], 'openvino'), [device('openvino:npu', 'openvino')])
    addon = booted.addon
    booted.answerCatalog()

    const result = await addon.dispatchCamera(makeRunnerCameraConfig(901))

    expect(result.kind).toBe('pending')
    expect(addon.getPipelineAssignment({ deviceId: 901 })).toBeNull()
    expect(booted.runner.attachedCameras.has(901)).toBe(false)
    expect(addon.peekPendingReason(901)).toBe('root-unrunnable:agent-a/default-pool')
  })
})
