/**
 * D754 narrowed by D927 — the CAMERA-WIDE step-settings layer, and the
 * absence of every other per-camera model layer.
 *
 * "A model is chosen by the accelerator that runs it; a camera only turns
 * steps on or off." A camera may still carry CAMERA-SEMANTIC settings (an
 * allow-list of classes) on every accelerator it lands on. It never carries a
 * model, a model binding or a `minConfidence*` floor: those are the
 * accelerator's.
 *
 * Pinned here:
 *   - dispatch merges node ⊕ camera, key by key, on EVERY accelerator and the
 *     default pool (`''`);
 *   - a legacy `stepOverridesByDevice` row left on disk has NO effect: the
 *     accelerator's own model and settings run;
 *   - a legacy model-bound value in the camera layer is dropped at dispatch,
 *     the accelerator's pair applies;
 *   - `setCameraStepSettings` REFUSES a model-scoped key and writes nothing;
 *   - the layer is written / cleared per step and pruned when empty.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createDurableState, type DurableState } from '@camstack/types'
import type { ZodType } from 'zod'
import { applyDeviceProvisioning } from '../apply-device-provisioning.js'
import PipelineOrchestratorAddon from '../index.js'
import { PipelineSettingsStore } from '../pipeline-settings-store.js'
import { makeFakeBroker, makeFakeContext, makeSilentLogger } from './e2e-helpers.js'

const NODE = 'hub'
const DEVICE_ID = 101
const STEP = 'object-detection'

function makeStore(seed: Record<string, unknown> = {}): PipelineSettingsStore {
  let blob: Record<string, unknown> = { ...seed }
  const state = <T>(key: string, schema: ZodType<T>, fallback: T): DurableState<T> =>
    createDurableState<T>({
      key,
      schema,
      fallback,
      read: async () => blob,
      write: async (patch) => {
        blob = { ...blob, ...patch }
      },
    })
  return new PipelineSettingsStore({
    state,
    api: () => null,
    acquireCapability: () => Promise.reject(new Error('not used')),
    getAssignmentNode: () => NODE,
    hasPackageZone: async () => false,
    logger: makeSilentLogger(),
  })
}

async function seedNode(store: PipelineSettingsStore): Promise<void> {
  await store.writeAgentSettings(NODE, {
    maxCameras: null,
    stepSettings: { [STEP]: { a: 1, b: 2 } },
    inferenceDevices: {
      'openvino:gpu': {
        enabled: true,
        weight: 1,
        steps: {
          [STEP]: {
            settings: {
              minConfidencePerson: 0.6,
              minConfidencePersonModelId: 'gpu-model',
            },
          },
        },
      },
      'openvino:npu': { enabled: true, weight: 1, steps: { [STEP]: { modelId: 'npu-model' } } },
    },
  })
}

/** What the step really runs with on `deviceKey`: the dispatch merge, end to end. */
async function effectiveStep(
  store: PipelineSettingsStore,
  deviceKey: string,
): Promise<{ readonly modelId?: string; readonly settings?: Readonly<Record<string, unknown>> }> {
  const sources = await store.readDeviceProvisioning(DEVICE_ID, NODE, [deviceKey])
  const src = sources.get(deviceKey)
  const [step] = applyDeviceProvisioning(
    [{ addonId: STEP, enabled: true }],
    src?.base ?? {},
    src?.override ?? {},
  )
  return {
    ...(step?.modelId !== undefined ? { modelId: step.modelId } : {}),
    ...(step?.settings !== undefined ? { settings: step.settings } : {}),
  }
}

describe('camera step settings (D754, D927) — store + dispatch merge', () => {
  it('merges node ⊕ camera, key by key', async () => {
    const store = makeStore()
    await seedNode(store)
    await store.writeCameraStepSettings(DEVICE_ID, STEP, { b: 20 })

    expect((await effectiveStep(store, 'openvino:gpu')).settings).toEqual({
      a: 1,
      b: 20,
      minConfidencePerson: 0.6,
      minConfidencePersonModelId: 'gpu-model',
    })
  })

  it('applies on every accelerator, and on the default pool', async () => {
    const store = makeStore()
    await seedNode(store)
    await store.writeCameraStepSettings(DEVICE_ID, STEP, { b: 20 })

    expect((await effectiveStep(store, 'openvino:npu')).settings).toMatchObject({ b: 20 })
    expect((await effectiveStep(store, '')).settings).toMatchObject({ a: 1, b: 20 })
  })

  it('a legacy per-camera-per-accelerator row on disk changes nothing: the accelerator decides', async () => {
    const store = makeStore({
      cameraSettings: {
        [String(DEVICE_ID)]: {
          stepOverridesByDevice: {
            [NODE]: {
              'openvino:npu': { [STEP]: { modelId: 'camera-pin', settings: { b: 99 } } },
            },
          },
        },
      },
    })
    await seedNode(store)

    const step = await effectiveStep(store, 'openvino:npu')
    expect(step.modelId).toBe('npu-model')
    expect(step.settings?.['b']).toBe(2)
  })

  it("a legacy model-bound value in the camera layer is dropped — the accelerator's pair applies", async () => {
    const store = makeStore({
      cameraSettings: {
        [String(DEVICE_ID)]: {
          stepSettings: {
            [STEP]: {
              enabledClasses: ['person'],
              minConfidencePerson: 0.9,
              minConfidencePersonModelId: 'cam-model',
            },
          },
        },
      },
    })
    await seedNode(store)

    expect((await effectiveStep(store, 'openvino:gpu')).settings).toEqual({
      a: 1,
      b: 2,
      enabledClasses: ['person'],
      minConfidencePerson: 0.6,
      minConfidencePersonModelId: 'gpu-model',
    })
  })

  it('node-scoped settings reach every accelerator; a disabled entry is never read (D927)', async () => {
    const store = makeStore({
      agentSettings: {
        [NODE]: {
          maxCameras: null,
          stepSettings: { [STEP]: { enabledClasses: ['person'] } },
          inferenceDevices: {
            cpu: { enabled: false, steps: { [STEP]: { settings: { parked: true } } } },
            'openvino:npu': { enabled: true },
          },
        },
      },
    })
    const settings = (await effectiveStep(store, 'openvino:npu')).settings
    expect(settings).toEqual({ enabledClasses: ['person'] })
    expect((await effectiveStep(store, '')).settings).toEqual({ enabledClasses: ['person'] })
  })

  it('null and {} clear the step, and an empty layer is pruned', async () => {
    const store = makeStore()
    await store.writeCameraStepSettings(DEVICE_ID, STEP, { b: 20 })
    await store.writeCameraStepSettings(DEVICE_ID, 'plate-ocr', { rectify: true })
    await store.writeCameraStepSettings(DEVICE_ID, STEP, null)
    expect((await store.readCameraSettingsMap())[String(DEVICE_ID)]?.stepSettings).toEqual({
      'plate-ocr': { rectify: true },
    })
    await store.writeCameraStepSettings(DEVICE_ID, 'plate-ocr', {})
    expect((await store.readCameraSettingsMap())[String(DEVICE_ID)]).toEqual({})
  })

  it('leaves a camera with no layer exactly as before (no override invented)', async () => {
    const store = makeStore()
    await seedNode(store)
    const src = (await store.readDeviceProvisioning(DEVICE_ID, NODE, ['openvino:gpu', ''])).get('')
    expect(src?.override).toEqual({})
  })
})

describe('pipelineOrchestrator.setCameraStepSettings', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  async function boot(): Promise<PipelineOrchestratorAddon> {
    const { ctx } = makeFakeContext({ addonConfig: { moleculerBroker: makeFakeBroker(NODE) } })
    const a = new PipelineOrchestratorAddon()
    await a.initialize(ctx)
    return a
  }

  it('round-trips through getCameraSettings', async () => {
    addon = await boot()
    await expect(
      addon.setCameraStepSettings({ deviceId: DEVICE_ID, addonId: STEP, settings: { b: 20 } }),
    ).resolves.toEqual({ success: true })
    expect((await addon.getCameraSettings({ deviceId: DEVICE_ID }))?.stepSettings).toEqual({
      [STEP]: { b: 20 },
    })

    await addon.setCameraStepSettings({ deviceId: DEVICE_ID, addonId: STEP, settings: null })
    expect((await addon.getCameraSettings({ deviceId: DEVICE_ID }))?.stepSettings).toBeUndefined()
  })

  it('refuses a model-scoped key by name and writes nothing (D927)', async () => {
    addon = await boot()
    await expect(
      addon.setCameraStepSettings({
        deviceId: DEVICE_ID,
        addonId: STEP,
        settings: {
          enabledClasses: ['person'],
          minConfidencePerson: 0.75,
          minConfidencePersonModelId: 'yolov9m-320-int8',
        },
      }),
    ).rejects.toThrow(/minConfidencePerson, minConfidencePersonModelId belong to the accelerator/)
    expect((await addon.getCameraSettings({ deviceId: DEVICE_ID }))?.stepSettings).toBeUndefined()
  })
})

describe('pipelineOrchestrator.setNodeStepSettings (D927)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('writes the node-wide layer, and clears it with null', async () => {
    const { ctx } = makeFakeContext({ addonConfig: { moleculerBroker: makeFakeBroker(NODE) } })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    await addon.setNodeStepSettings({
      agentNodeId: NODE,
      addonId: 'animal-classifier',
      settings: { enabledClasses: ['bird'] },
    })
    expect((await addon.getAgentSettings({ agentNodeId: NODE }))?.stepSettings).toEqual({
      'animal-classifier': { enabledClasses: ['bird'] },
    })
    await addon.setNodeStepSettings({
      agentNodeId: NODE,
      addonId: 'animal-classifier',
      settings: null,
    })
    expect((await addon.getAgentSettings({ agentNodeId: NODE }))?.stepSettings).toBeUndefined()
  })

  it("refuses a model-scoped key — a floor is the accelerator's", async () => {
    const { ctx } = makeFakeContext({ addonConfig: { moleculerBroker: makeFakeBroker(NODE) } })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)
    await expect(
      addon.setNodeStepSettings({
        agentNodeId: NODE,
        addonId: STEP,
        settings: { minConfidencePerson: 0.7 },
      }),
    ).rejects.toThrow(/minConfidencePerson belong to the accelerator/)
    expect((await addon.getAgentSettings({ agentNodeId: NODE }))?.stepSettings).toBeUndefined()
  })
})
