import { describe, it, expect } from 'vitest'
import type { ModelCatalogEntry, ModelFormat, StepDefinition } from '@camstack/types'
import { resolveDefaultDetectionModel } from '../default-detection-model'
import { getStepDefinition } from '../registry/step-definitions'

// ---------------------------------------------------------------------------
// Real-catalog behaviour — the accelerated picks are OUR YOLOv9 family
//: yolo26 does NOT compile on the Intel NPU (0 frames),
// while yolov9 runs on it; Apple ANE uses the CoreML yolov9 build. All ship
// onnx + coreml + openvino builds, so the picks resolve for every format.
// ---------------------------------------------------------------------------

describe('resolveDefaultDetectionModel — real catalog', () => {
  it('Apple ANE (coreml) → yolov9m-320 (CoreML v9)', () => {
    expect(resolveDefaultDetectionModel('coreml', 'all', 'coreml')).toBe('yolov9m-320')
    expect(resolveDefaultDetectionModel('coreml', 'ane', 'coreml')).toBe('yolov9m-320')
  })

  it('Intel NPU (openvino/npu) → yolov9m-320-int8 (yolo26 does not compile on NPU)', () => {
    expect(resolveDefaultDetectionModel('openvino', 'npu', 'openvino')).toBe('yolov9m-320-int8')
  })

  it('Intel GPU (openvino/gpu) → yolov9m-320-int8', () => {
    expect(resolveDefaultDetectionModel('openvino', 'gpu', 'openvino')).toBe('yolov9m-320-int8')
  })

  it('OpenVINO default device (auto) → GPU-class yolov9m-320-int8', () => {
    expect(resolveDefaultDetectionModel('openvino', 'auto', 'openvino')).toBe('yolov9m-320-int8')
  })

  it('OpenVINO CPU device → yolov9m-320-int8 (AMD Zen4 OV-CPU / int8 IR path)', () => {
    expect(resolveDefaultDetectionModel('openvino', 'cpu', 'openvino')).toBe('yolov9m-320-int8')
  })

  it('generic CPU (onnx) → yolo26n', () => {
    expect(resolveDefaultDetectionModel('onnx', 'cpu', 'onnx')).toBe('yolo26n')
  })

  it('ONNX CUDA (nvidia) → yolo26n (unmapped → safe nano)', () => {
    expect(resolveDefaultDetectionModel('onnx', 'cuda', 'onnx')).toBe('yolo26n')
  })

  it('unknown backend → yolo26n', () => {
    expect(resolveDefaultDetectionModel('quantum-tpu', null, 'onnx')).toBe('yolo26n')
    expect(resolveDefaultDetectionModel('', null, 'onnx')).toBe('yolo26n')
  })

  it('never promotes hardware-aware defaults to 640 (pipeline-frame-model-eval)', () => {
    // Pin: docs/benchmarks/pipeline-frame-model-eval.md — 640 recovered 0/3
    // misses at the current 0.50 threshold and failed FP/capacity gates.
    // Hardware-aware defaults stay the 320 family; 640 is operator-only.
    const accelerated: ReadonlyArray<[string, string | null, ModelFormat]> = [
      ['coreml', 'all', 'coreml'],
      ['coreml', 'ane', 'coreml'],
      ['openvino', 'npu', 'openvino'],
      ['openvino', 'gpu', 'openvino'],
      ['openvino', 'auto', 'openvino'],
    ]
    for (const [backend, device, format] of accelerated) {
      const id = resolveDefaultDetectionModel(backend, device, format)
      expect(id, `${backend}/${device}/${format}`).not.toMatch(/106/)
      expect(id, `${backend}/${device}/${format}`).toMatch(/320/)
    }
  })

  it('never returns an id absent from the object-detection catalog', () => {
    const catalogIds = new Set(getStepDefinition('object-detection').models.map((m) => m.id))
    const cases: ReadonlyArray<[string, string | null, ModelFormat]> = [
      ['coreml', 'all', 'coreml'],
      ['openvino', 'npu', 'openvino'],
      ['openvino', 'gpu', 'openvino'],
      ['openvino', 'auto', 'openvino'],
      ['onnx', 'cpu', 'onnx'],
      ['weird', 'weird', 'onnx'],
    ]
    for (const [backend, device, format] of cases) {
      expect(catalogIds.has(resolveDefaultDetectionModel(backend, device, format))).toBe(true)
    }
  })

  it('Coral USB (edgetpu/tflite) → the tflite build, never the formatless nano (cam-101 regression)', () => {
    // 2026-08-01, camera 101: the orchestrator's device rotation elected
    // `edgetpu:usb`; the auto (no explicit modelId) path resolved the default
    // through this function, which classified `edgetpu` as the CPU class and
    // returned `defaultModelId` (`yolo26n`) WITHOUT checking it has a tflite
    // build. Every frame then re-attempted a doomed 3-retry model download
    // (~5.5s/frame) — 101 fell from 12.8fps/58ms to 2.4fps/5532ms.
    expect(resolveDefaultDetectionModel('edgetpu', 'usb', 'tflite')).toBe('yolov9s-320-edgetpu')
  })

  it('GUARANTEE: for every known backend×format, the returned id has a build for the format (or the step has zero builds)', () => {
    const def = getStepDefinition('object-detection')
    const backends: ReadonlyArray<[string, string | null]> = [
      ['coreml', 'all'],
      ['openvino', 'npu'],
      ['openvino', 'gpu'],
      ['openvino', 'auto'],
      ['openvino', 'cpu'],
      ['onnx', 'cpu'],
      ['onnx', 'cuda'],
      ['edgetpu', 'usb'],
      ['edgetpu', 'usb:1'],
      ['cpu', 'cpu'],
      ['unknown-backend', null],
    ]
    const formats: readonly ModelFormat[] = ['onnx', 'coreml', 'openvino', 'tflite']
    for (const [backend, device] of backends) {
      for (const format of formats) {
        const stepHasAnyBuild = def.models.some((m) => m.formats[format] !== undefined)
        if (!stepHasAnyBuild) continue // unloadable either way — flagged elsewhere
        const id = resolveDefaultDetectionModel(backend, device, format)
        const entry = def.models.find((m) => m.id === id)
        expect(
          entry?.formats[format],
          `resolveDefaultDetectionModel(${backend}, ${device}, ${format}) returned "${id}" which has no ${format} build`,
        ).toBeDefined()
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Missing-build fallback — injected catalog where the mapped accelerated id
// has no build for the node's format. Mirrors collectZeroBuildIssues' seam.
// ---------------------------------------------------------------------------

function fakeModel(overrides: Partial<ModelCatalogEntry>): ModelCatalogEntry {
  return {
    id: 'fake-model',
    name: 'Fake Model',
    description: 'Fake model for default-detection-model unit test',
    inputSize: { width: 1, height: 1 },
    labels: [],
    formats: {},
    ...overrides,
  }
}

function fakeObjectDetectionDef(overrides: Partial<StepDefinition>): StepDefinition {
  return {
    id: 'object-detection',
    name: 'Object Detection',
    slot: 'detector',
    postprocessor: 'yolo',
    extractMode: 'full-frame',
    inputClasses: null,
    outputClasses: ['person', 'vehicle', 'animal'],
    models: [],
    defaultModelId: 'yolo26n',
    defaultConfidence: 0.5,
    ...overrides,
  }
}

describe('resolveDefaultDetectionModel — missing-catalog-id fallback', () => {
  it('falls back to defaultModelId when the mapped id is absent from the catalog', () => {
    // Catalog only knows yolo26n — the coreml pick (yolov9m-320) is missing.
    const def = fakeObjectDetectionDef({
      models: [fakeModel({ id: 'yolo26n', formats: { coreml: { url: 'x', sizeMB: 1 } } })],
    })
    expect(resolveDefaultDetectionModel('coreml', 'all', 'coreml', () => def)).toBe('yolo26n')
  })

  it('falls back to defaultModelId when the mapped id lacks a build for the format', () => {
    // yolov9m-320-int8 exists but only ships openvino — an onnx node cannot load it.
    const def = fakeObjectDetectionDef({
      models: [
        fakeModel({ id: 'yolo26n', formats: { onnx: { url: 'n', sizeMB: 1 } } }),
        fakeModel({ id: 'yolov9m-320-int8', formats: { openvino: { url: 'm', sizeMB: 1 } } }),
      ],
    })
    expect(resolveDefaultDetectionModel('openvino', 'npu', 'onnx', () => def)).toBe('yolo26n')
  })

  it('returns the mapped id when the injected catalog has a build for the format', () => {
    const def = fakeObjectDetectionDef({
      models: [
        fakeModel({ id: 'yolo26n', formats: { onnx: { url: 'n', sizeMB: 1 } } }),
        fakeModel({ id: 'yolov9m-320-int8', formats: { openvino: { url: 'm', sizeMB: 1 } } }),
      ],
    })
    expect(resolveDefaultDetectionModel('openvino', 'npu', 'openvino', () => def)).toBe(
      'yolov9m-320-int8',
    )
  })

  it('returns the catalog nano when the step lookup throws (never throws itself)', () => {
    const throwing = (): StepDefinition => {
      throw new Error('step unregistered')
    }
    expect(resolveDefaultDetectionModel('coreml', 'all', 'coreml', throwing)).toBe('yolo26n')
  })
})
