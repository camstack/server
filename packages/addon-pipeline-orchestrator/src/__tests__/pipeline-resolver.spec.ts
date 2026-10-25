/**
 * Unit tests for the pure, DEVICE-AWARE `pipeline-resolver` module — covers the
 * per-camera gate, per-DEVICE format skip-check, tree construction (structure
 * only — no modelId/settings), and audio extraction. Provisioning (model +
 * settings attach) is a separate stage (`applyDeviceProvisioning`).
 */
import { describe, it, expect } from 'vitest'
import {
  resolvePipeline,
  resolvePipelineWithSkips,
  buildTreeFromAddons,
  OBJECT_DETECTION_STEP_ID,
} from '../pipeline-resolver.js'
import type { PipelineSchema, PipelineEngineChoice, CameraPipelineSettings } from '@camstack/types'

const ENGINE_CPU: PipelineEngineChoice = { runtime: 'python', backend: 'cpu', format: 'onnx' }

function model(id: string, formats: readonly string[] = ['onnx', 'coreml']) {
  return {
    id,
    name: id,
    formats: Object.fromEntries(formats.map((f) => [f, { downloaded: false, sizeMB: 1 }])),
  }
}

function addon(opts: {
  id: string
  slot: 'detector' | 'cropper' | 'classifier' | 'refiner' | 'audio-classifier'
  inputClasses?: readonly string[]
  outputClasses: readonly string[]
  defaultModelId: string
  models?: readonly ReturnType<typeof model>[]
  defaultModelIdByFormat?: Record<string, string>
  enabledByDefault?: boolean
}) {
  return {
    id: opts.id,
    name: opts.id,
    slot: opts.slot,
    inputClasses: opts.inputClasses ?? [],
    outputClasses: opts.outputClasses,
    childSlots: [] as const,
    models: opts.models ?? [model(opts.defaultModelId)],
    defaultModelId: opts.defaultModelId,
    defaultConfidence: 0.5,
    ...(opts.defaultModelIdByFormat ? { defaultModelIdByFormat: opts.defaultModelIdByFormat } : {}),
    ...(opts.enabledByDefault !== undefined ? { enabledByDefault: opts.enabledByDefault } : {}),
  }
}

function makeCatalog(): PipelineSchema {
  return {
    availableEngines: [],
    selectedEngine: ENGINE_CPU,
    slots: [
      {
        id: 'detector',
        label: 'Detector',
        priority: 0,
        parentSlot: null,
        addons: [
          addon({
            id: 'object-detection',
            slot: 'detector',
            outputClasses: ['person', 'vehicle', 'animal'],
            defaultModelId: 'yolov9s',
          }),
        ],
      },
      {
        id: 'cropper',
        label: 'Cropper',
        priority: 1,
        parentSlot: 'detector',
        addons: [
          addon({
            id: 'face-detection',
            slot: 'cropper',
            inputClasses: ['person'],
            outputClasses: ['face'],
            defaultModelId: 'scrfd',
          }),
          addon({
            id: 'plate-detection',
            slot: 'cropper',
            inputClasses: ['vehicle'],
            outputClasses: ['plate'],
            defaultModelId: 'yolox-tiny-plate',
          }),
        ],
      },
      {
        id: 'classifier',
        label: 'Classifier',
        priority: 2,
        parentSlot: 'cropper',
        addons: [
          addon({
            id: 'face-embedding',
            slot: 'classifier',
            inputClasses: ['face'],
            outputClasses: ['identity'],
            defaultModelId: 'arcface',
          }),
          addon({
            id: 'plate-ocr',
            slot: 'classifier',
            inputClasses: ['plate'],
            outputClasses: ['plate-text'],
            defaultModelId: 'vgg-g2',
          }),
          addon({
            id: 'bird-classifier',
            slot: 'classifier',
            inputClasses: ['animal'],
            outputClasses: ['species'],
            defaultModelId: 'bird-404',
            enabledByDefault: false,
          }),
          addon({
            id: 'animal-classifier',
            slot: 'classifier',
            inputClasses: ['animal'],
            outputClasses: ['animal-type'],
            defaultModelId: 'animals-10',
            enabledByDefault: false,
          }),
        ],
      },
      {
        id: 'audio-classifier',
        label: 'Audio',
        priority: 4,
        parentSlot: null,
        addons: [
          addon({
            id: 'audio-classifier',
            slot: 'audio-classifier',
            outputClasses: ['audio'],
            defaultModelId: 'yamnet-onnx',
            models: [model('yamnet-onnx', ['onnx']), model('apple-soundanalysis', ['coreml'])],
            defaultModelIdByFormat: { coreml: 'apple-soundanalysis' },
          }),
        ],
      },
    ],
  }
}

describe('resolvePipeline (structure only)', () => {
  const catalog = makeCatalog()

  it('stepToggles force-disables a default-on addon', () => {
    const cam: CameraPipelineSettings = { stepToggles: { 'face-detection': false } }
    const res = resolvePipeline(cam, 'onnx', catalog)
    const root = res.steps.find((s) => s.addonId === 'object-detection')!
    expect((root.children ?? []).some((c) => c.addonId === 'face-detection')).toBe(false)
    expect((root.children ?? []).some((c) => c.addonId === 'plate-detection')).toBe(true)
  })

  it('stepToggles force-enables a default-off addon', () => {
    const cam: CameraPipelineSettings = { stepToggles: { 'bird-classifier': true } }
    const res = resolvePipeline(cam, 'onnx', catalog)
    const root = res.steps.find((s) => s.addonId === 'object-detection')!
    expect((root.children ?? []).some((c) => c.addonId === 'bird-classifier')).toBe(true)
  })

  it('extracts audio-classifier into CameraPipelineConfig.audio — no modelId, no engine', () => {
    const res = resolvePipeline(null, 'onnx', catalog)
    expect(res.audio?.enabled).toBe(true)
    expect(res.audio?.modelId).toBeUndefined()
    expect(res.audio).not.toHaveProperty('engine')
    expect(res.steps.every((s) => s.addonId !== 'audio-classifier')).toBe(true)
  })

  it('builds the default tree: obj-det → face+plate → face-embed+plate-ocr', () => {
    const res = resolvePipeline(null, 'onnx', catalog)
    expect(res.steps).toHaveLength(1)
    const root = res.steps[0]!
    expect(root.addonId).toBe('object-detection')
    const faceBranch = (root.children ?? []).find((c) => c.addonId === 'face-detection')!
    const plateBranch = (root.children ?? []).find((c) => c.addonId === 'plate-detection')!
    expect((faceBranch.children ?? []).some((c) => c.addonId === 'face-embedding')).toBe(true)
    expect((plateBranch.children ?? []).some((c) => c.addonId === 'plate-ocr')).toBe(true)
  })

  it('enablement is catalog-default-driven — null camera resolves the default tree', () => {
    const res = resolvePipeline(null, 'onnx', catalog)
    expect(res.steps).toHaveLength(1)
    expect(res.steps[0]!.addonId).toBe('object-detection')
    const root = res.steps[0]!
    expect((root.children ?? []).some((c) => c.addonId === 'bird-classifier')).toBe(false)
  })

  it('produces structure with NO modelId (provisioning is a later stage)', () => {
    const res = resolvePipeline({ stepToggles: { 'object-detection': true } }, 'onnx', catalog)
    expect(res.steps[0]!.addonId).toBe('object-detection')
    expect(res.steps[0]!.modelId).toBeUndefined()
    // children likewise carry no model
    expect((res.steps[0]!.children ?? []).every((c) => c.modelId === undefined)).toBe(true)
  })
})

describe('per-camera gate + per-device skip', () => {
  const catalog = makeCatalog()

  it('drops a gated-on step with no model for the DEVICE format (per-device skip)', () => {
    // object-detection has only an onnx/coreml build; device format 'tflite' ⇒ skip.
    const { config, skipped } = resolvePipelineWithSkips(
      { stepToggles: { 'object-detection': true } },
      'tflite',
      catalog,
    )
    expect(config.steps).toHaveLength(0)
    expect(skipped).toContainEqual({ addonId: 'object-detection', reason: 'no-compatible-model' })
  })

  it('gate ON but no compatible model for a child on the device → child SKIPPED', () => {
    // vehicle-classifier: coreml-only model, device format = onnx → unprovisioned.
    const catWithCoremlOnly: PipelineSchema = {
      ...catalog,
      slots: catalog.slots.map((slot) =>
        slot.id !== 'classifier'
          ? slot
          : {
              ...slot,
              addons: [
                ...slot.addons,
                addon({
                  id: 'vehicle-classifier',
                  slot: 'classifier',
                  inputClasses: ['vehicle'],
                  outputClasses: ['vehicle-type'],
                  defaultModelId: 'vtype',
                  models: [model('vtype', ['coreml'])], // no onnx build
                  enabledByDefault: false,
                }),
              ],
            },
      ),
    }
    const cam: CameraPipelineSettings = { stepToggles: { 'vehicle-classifier': true } }
    const { config, skipped } = resolvePipelineWithSkips(cam, 'onnx', catWithCoremlOnly)
    const root = config.steps.find((s) => s.addonId === 'object-detection')!
    expect((root.children ?? []).some((c) => c.addonId === 'vehicle-classifier')).toBe(false)
    expect(skipped).toEqual([{ addonId: 'vehicle-classifier', reason: 'no-compatible-model' }])
  })

  it('gate ON with a compatible model resolves normally, no skips', () => {
    const cam: CameraPipelineSettings = { stepToggles: { 'animal-classifier': true } }
    const { config, skipped } = resolvePipelineWithSkips(cam, 'onnx', catalog)
    const root = config.steps.find((s) => s.addonId === 'object-detection')!
    expect((root.children ?? []).some((c) => c.addonId === 'animal-classifier')).toBe(true)
    expect(skipped).toEqual([])
  })
})

describe('buildTreeFromAddons', () => {
  const catalog = makeCatalog()

  it('orphan leaves (no compatible parent in enabled set) are silently dropped', () => {
    const out = buildTreeFromAddons([{ addonId: 'face-embedding' }], catalog)
    expect(out).toEqual([])
  })

  it('a partial set without a root detector produces empty (conservative)', () => {
    const out = buildTreeFromAddons(
      [{ addonId: 'face-detection' }, { addonId: 'face-embedding' }],
      catalog,
    )
    expect(out).toEqual([])
  })
})

// A catalog shaped like the FIXED `buildSchemaSlots` output on a Coral node:
// object-detection carries BOTH the onnx nano AND the tflite Coral ssd build
// (multi-format), while the enrichment steps stay onnx/coreml-only. This is the
// exact shape that lets the per-DEVICE skip-gate provision the ROOT on the
// Coral's `tflite` format while honestly skipping enrichment that has no tflite
// build. Before FIX 1 the catalog was filtered to the node's single selected
// engine format, so the tflite ssd model was absent and EVERY step (incl. the
// root) skipped as `no-compatible-model`.
function makeEdgetpuCatalog(): PipelineSchema {
  return {
    availableEngines: [],
    selectedEngine: ENGINE_CPU,
    slots: [
      {
        id: 'detector',
        label: 'Detector',
        priority: 0,
        parentSlot: null,
        addons: [
          addon({
            id: 'object-detection',
            slot: 'detector',
            outputClasses: ['person', 'vehicle', 'animal'],
            defaultModelId: 'yolo26n',
            models: [
              model('yolo26n', ['onnx', 'coreml']),
              model('ssd-mobilenet-v2-coco-edgetpu', ['tflite']),
            ],
            defaultModelIdByFormat: { tflite: 'ssd-mobilenet-v2-coco-edgetpu' },
          }),
        ],
      },
      {
        id: 'cropper',
        label: 'Cropper',
        priority: 1,
        parentSlot: 'detector',
        addons: [
          addon({
            id: 'face-detection',
            slot: 'cropper',
            inputClasses: ['person'],
            outputClasses: ['face'],
            defaultModelId: 'scrfd', // onnx/coreml only — no tflite build
          }),
        ],
      },
    ],
  }
}

describe('resolvePipelineWithSkips — edgetpu / tflite root provisioning (FIX 1)', () => {
  const catalog = makeEdgetpuCatalog()

  it('provisions object-detection on tflite and skips enrichment with no tflite build', () => {
    const { config, skipped } = resolvePipelineWithSkips(null, 'tflite', catalog)
    // The object-detection ROOT is provisioned (present in the structure tree),
    // NOT skipped — the Coral ssd model gives it a tflite build.
    expect(config.steps.map((s) => s.addonId)).toEqual(['object-detection'])
    expect(skipped.some((s) => s.addonId === 'object-detection')).toBe(false)
    // face-detection is gated on by default but has no tflite build → honest skip.
    expect(skipped).toContainEqual({ addonId: 'face-detection', reason: 'no-compatible-model' })
  })

  it('the same catalog on the onnx node keeps the full tree (no regression)', () => {
    const { config, skipped } = resolvePipelineWithSkips(null, 'onnx', catalog)
    const root = config.steps.find((s) => s.addonId === 'object-detection')!
    expect(root).toBeDefined()
    expect((root.children ?? []).some((c) => c.addonId === 'face-detection')).toBe(true)
    expect(skipped).toEqual([])
  })
})

// D650 — a detail step the ELECTED device cannot run is kept when another
// enabled device of the SAME node can (the runner jumps it there); the root is
// never jumped. `jumpFormats` are the formats of the node's jump roster.
function makeCoralHubCatalog(): PipelineSchema {
  const base = makeEdgetpuCatalog()
  return {
    ...base,
    slots: [
      ...base.slots.map((slot) =>
        slot.id !== 'cropper'
          ? slot
          : {
              ...slot,
              addons: slot.addons.map((a) =>
                a.id === 'face-detection'
                  ? { ...a, models: [model('scrfd', ['onnx', 'openvino'])] }
                  : a,
              ),
            },
      ),
      {
        id: 'classifier',
        label: 'Classifier',
        priority: 2,
        parentSlot: 'cropper',
        addons: [
          addon({
            id: 'face-embedding',
            slot: 'classifier',
            inputClasses: ['face'],
            outputClasses: ['identity'],
            defaultModelId: 'arcface',
            models: [model('arcface', ['onnx', 'openvino'])],
          }),
        ],
      },
      {
        id: 'audio-classifier',
        label: 'Audio',
        priority: 4,
        parentSlot: null,
        addons: [
          addon({
            id: 'audio-classifier',
            slot: 'audio-classifier',
            outputClasses: ['audio'],
            defaultModelId: 'yamnet-onnx',
            models: [model('yamnet-onnx', ['onnx', 'openvino'])],
          }),
        ],
      },
    ],
  }
}

// D657 — ONE placement rule (`stepModelRunsOnFormat`, @camstack/types): a
// LEGACY build is a catalog stub (the Coral face SSD has no working
// postprocessor) and never provisions a format on its own. Counting it kept
// face-detection on a Coral, where it resolved to a model with no tflite build.
function makeCoralWithFaceStubCatalog(): PipelineSchema {
  const base = makeCoralHubCatalog()
  const stub = { ...model('ssd-mobilenet-v2-face-edgetpu', ['tflite']), legacy: true }
  return {
    ...base,
    slots: base.slots.map((slot) =>
      slot.id !== 'cropper'
        ? slot
        : {
            ...slot,
            addons: slot.addons.map((a) =>
              a.id === 'face-detection'
                ? { ...a, models: [model('yunet', ['onnx', 'openvino']), stub] }
                : a,
            ),
          },
    ),
  }
}

describe('resolvePipelineWithSkips — a legacy build provisions nothing (D657)', () => {
  const catalog = makeCoralWithFaceStubCatalog()

  it('Coral-only node: face-detection is skipped BY NAME and the root runs', () => {
    const { config, skipped, droppedRoots } = resolvePipelineWithSkips(null, 'tflite', catalog, [
      'tflite',
    ])
    expect(config.steps.map((s) => s.addonId)).toEqual(['object-detection'])
    expect(config.steps[0]!.children ?? []).toEqual([])
    expect(skipped).toContainEqual({ addonId: 'face-detection', reason: 'no-compatible-model' })
    expect(droppedRoots).toEqual([])
  })

  it('Coral + an openvino device: face-detection is kept, for the runner to jump', () => {
    const { config } = resolvePipelineWithSkips(null, 'tflite', catalog, ['openvino'])
    const face = (config.steps[0]!.children ?? []).find((c) => c.addonId === 'face-detection')
    expect(face).toBeDefined()
  })
})

describe('resolvePipelineWithSkips — same-node detail-step delegation (D650)', () => {
  const catalog = makeCoralHubCatalog()

  it('keeps face-detection on a tflite election when an openvino device is on the node', () => {
    const { config, skipped } = resolvePipelineWithSkips(null, 'tflite', catalog, ['openvino'])
    const root = config.steps.find((s) => s.addonId === 'object-detection')!
    expect(root).toBeDefined()
    const face = (root.children ?? []).find((c) => c.addonId === 'face-detection')
    expect(face).toBeDefined()
    expect((face!.children ?? []).map((c) => c.addonId)).toEqual(['face-embedding'])
    expect(config.audio).toEqual({ enabled: true })
    expect(skipped).toEqual([])
  })

  it('drops and reports a detail step no device on the node can run', () => {
    // The roster holds another tflite device only — nothing builds face-detection.
    const { config, skipped } = resolvePipelineWithSkips(null, 'tflite', catalog, ['tflite'])
    expect(config.steps.map((s) => s.addonId)).toEqual(['object-detection'])
    expect(config.steps[0]!.children ?? []).toEqual([])
    expect(skipped).toContainEqual({ addonId: 'face-detection', reason: 'no-compatible-model' })
    expect(skipped).toContainEqual({ addonId: 'face-embedding', reason: 'no-compatible-model' })
    // Audio is never format-gated: it runs on the audio-analyzer's backend.
    expect(config.audio).toEqual({ enabled: true })
    expect(skipped.some((x) => x.addonId === 'audio-classifier')).toBe(false)
  })

  it('never jumps the ROOT: a root with no build on the elected format is dropped', () => {
    // object-detection has onnx + tflite builds; the elected device is openvino.
    const { config, skipped } = resolvePipelineWithSkips(null, 'openvino', catalog, [
      'tflite',
      'onnx',
    ])
    expect(config.steps).toEqual([])
    expect(skipped).toContainEqual({
      addonId: 'object-detection',
      reason: 'root-not-runnable-on-elected-device',
    })
  })

  it('audio-classifier is kept on a single-device node whose format has no audio build (no false warn)', () => {
    // tflite elected, no roster, and yamnet ships onnx/openvino only.
    const { config, skipped } = resolvePipelineWithSkips(null, 'tflite', catalog)
    expect(config.audio).toEqual({ enabled: true })
    expect(skipped.some((x) => x.addonId === 'audio-classifier')).toBe(false)
  })

  it('audio-classifier still honours enablement', () => {
    const { config } = resolvePipelineWithSkips(
      { stepToggles: { 'audio-classifier': false } },
      'tflite',
      catalog,
    )
    expect(config.audio).toBeNull()
  })

  it('without a roster the gate is the elected format alone (unchanged behaviour)', () => {
    const { skipped } = resolvePipelineWithSkips(null, 'tflite', catalog)
    expect(skipped).toContainEqual({ addonId: 'face-detection', reason: 'no-compatible-model' })
  })

  // Round 4: `droppedRoots` is the attach REFUSAL backstop, and it must refuse
  // exactly what the election guard checks — the camera root. Any other
  // gated-on root the elected device cannot run (segmentation, an opt-in
  // refiner with no tflite build) is a logged skip, as on main. Counting it
  // refused the whole camera and left it pending forever, because the election
  // guard never looked at segmentation.
  function withSegmentationRoot(base: PipelineSchema): PipelineSchema {
    return {
      ...base,
      slots: [
        ...base.slots,
        {
          id: 'refiner',
          label: 'Refiner',
          priority: 3,
          parentSlot: null,
          addons: [
            addon({
              id: 'segmentation',
              slot: 'refiner',
              outputClasses: ['mask'],
              defaultModelId: 'sam',
              models: [model('sam', ['onnx', 'openvino'])],
              enabledByDefault: false,
            }),
          ],
        },
      ],
    }
  }

  it('a refused OPT-IN root (segmentation) is a logged skip, never a dropped camera root', () => {
    const { config, skipped, droppedRoots } = resolvePipelineWithSkips(
      { stepToggles: { segmentation: true } },
      'tflite',
      withSegmentationRoot(catalog),
      ['openvino'],
    )
    expect(config.steps.map((s) => s.addonId)).toEqual(['object-detection'])
    expect(skipped).toContainEqual({
      addonId: 'segmentation',
      reason: 'root-not-runnable-on-elected-device',
    })
    expect(droppedRoots).toEqual([])
  })

  it('droppedRoots names the camera root, and only it, when the elected device cannot run it', () => {
    const { droppedRoots, skipped } = resolvePipelineWithSkips(
      { stepToggles: { segmentation: true } },
      'openvino',
      withSegmentationRoot(catalog),
      ['tflite', 'onnx'],
    )
    expect(droppedRoots).toEqual([OBJECT_DETECTION_STEP_ID])
    // Segmentation HAS an openvino build here, so it is kept — the two roots
    // are judged independently.
    expect(skipped.some((s) => s.addonId === 'segmentation')).toBe(false)
  })
})
