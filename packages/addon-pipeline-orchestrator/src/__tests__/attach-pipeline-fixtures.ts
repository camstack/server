/**
 * Shared fixtures for the D650 attach-pipeline tests: a Coral + openvino:gpu node whose
 * DEFAULT engine format is tflite (the catalog's `selectedEngine`), and a REAL
 * `PipelineSettingsStore` over an in-memory durable state. Only the transport
 * is faked (`getSchema`, `getBindings`): every gate and every provisioning
 * read under test is production code.
 */
import {
  type AddonContext,
  createDurableState,
  type DurableState,
  type PipelineSchema,
} from '@camstack/types'
import type { ZodType } from 'zod'
import { PipelineSettingsStore } from '../pipeline-settings-store.js'
import { makeSilentLogger } from './e2e-helpers.js'

export const NODE = 'hub'
export const CORAL = 'edgetpu:usb'
export const GPU = 'openvino:gpu'

function build(
  formats: readonly string[],
): Record<string, { downloaded: boolean; sizeMB: number }> {
  return Object.fromEntries(formats.map((f) => [f, { downloaded: true, sizeMB: 1 }]))
}

/** tflite ships ONLY the object detector; face-detection is onnx/openvino only. */
export const CORAL_GPU_CATALOG: PipelineSchema = {
  availableEngines: [],
  selectedEngine: { runtime: 'python', backend: 'edgetpu', format: 'tflite' },
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
          defaultModelId: 'yolo26n',
          defaultConfidence: 0.5,
          models: [
            { id: 'yolo26n', name: 'yolo26n', formats: build(['onnx', 'openvino']) },
            { id: 'ssd-edgetpu', name: 'ssd-edgetpu', formats: build(['tflite']) },
          ],
        },
      ],
    },
    {
      id: 'cropper',
      label: 'Cropper',
      priority: 1,
      parentSlot: 'detector',
      addons: [
        {
          id: 'face-detection',
          name: 'face-detection',
          slot: 'cropper',
          inputClasses: ['person'],
          outputClasses: ['face'],
          childSlots: [],
          defaultModelId: 'scrfd-2.5g',
          defaultConfidence: 0.5,
          models: [
            { id: 'scrfd-2.5g', name: 'scrfd-2.5g', formats: build(['onnx', 'openvino']) },
            { id: 'scrfd-10g', name: 'scrfd-10g', formats: build(['onnx', 'openvino']) },
          ],
        },
      ],
    },
  ],
}

/**
 * `CORAL_GPU_CATALOG` plus `segmentation`: an OPT-IN video root (no input
 * classes, `enabledByDefault: false`) with onnx/openvino builds only — the
 * shape that made round 3 refuse a whole Coral camera.
 */
export const CORAL_GPU_SEGMENTATION_CATALOG: PipelineSchema = {
  ...CORAL_GPU_CATALOG,
  slots: [
    ...CORAL_GPU_CATALOG.slots,
    {
      id: 'refiner',
      label: 'Refiner',
      priority: 3,
      parentSlot: null,
      addons: [
        {
          id: 'segmentation',
          name: 'segmentation',
          slot: 'refiner',
          inputClasses: [],
          outputClasses: ['mask'],
          childSlots: [],
          defaultModelId: 'sam',
          defaultConfidence: 0.5,
          enabledByDefault: false,
          models: [{ id: 'sam', name: 'sam', formats: build(['onnx', 'openvino']) }],
        },
      ],
    },
  ],
}

export interface RealStore {
  readonly store: PipelineSettingsStore
  /** Whole-blob reads of the addon store so far — the settings-store RPCs a dispatch pays. */
  readonly blobReads: () => number
  readonly warns: () => readonly string[]
}

export function makeRealStore(catalog: PipelineSchema = CORAL_GPU_CATALOG): RealStore {
  let blob: Record<string, unknown> = {}
  let reads = 0
  const state = <T>(key: string, schema: ZodType<T>, fallback: T): DurableState<T> =>
    createDurableState<T>({
      key,
      schema,
      fallback,
      read: async () => {
        reads++
        return blob
      },
      write: async (patch) => {
        blob = { ...blob, ...patch }
      },
    })
  const api = {
    pipelineExecutor: { getSchema: { query: async (): Promise<unknown> => catalog } },
    deviceManager: {
      getBindings: {
        query: async (): Promise<unknown> => ({
          entries: [{ capName: 'detection-pipeline', kind: 'wrapped' }],
        }),
      },
    },
  }
  const acquireCapability = (async (): Promise<unknown> =>
    undefined) as AddonContext['acquireCapability']
  // A warn is recorded as `<message> <meta JSON>` so a test can check WHAT a
  // line named (the skipped steps), not only that it fired.
  const warns: string[] = []
  const logger = {
    ...makeSilentLogger(),
    warn: (message: string, ctx?: { readonly meta?: unknown }) =>
      void warns.push(ctx?.meta === undefined ? message : `${message} ${JSON.stringify(ctx.meta)}`),
  }
  const store = new PipelineSettingsStore({
    state,
    api: () => api as never,
    acquireCapability,
    getAssignmentNode: () => NODE,
    hasPackageZone: async () => false,
    logger,
  })
  return { store, blobReads: () => reads, warns: () => warns }
}

/** Both devices enabled, the GPU with a base pin for face-detection. */
export async function seedCoralGpuNode(store: PipelineSettingsStore): Promise<void> {
  await store.writeAgentSettings(NODE, {
    maxCameras: null,
    inferenceDevices: {
      [CORAL]: { enabled: true, steps: { 'object-detection': { modelId: 'ssd-edgetpu' } } },
      [GPU]: { enabled: true, steps: { 'face-detection': { modelId: 'scrfd-10g' } } },
    },
  })
}

export const CORAL_GPU_ELIGIBLE: Readonly<Record<string, number>> = { [CORAL]: 1, [GPU]: 1 }
