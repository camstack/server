/**
 * A CUSTOM (operator-registered) model selected for a step must produce a
 * valid Python-pool model config — this was the break in the custom-model
 * chain: the picker offered the model (buildSchemaSlots merges the
 * custom-model-registry), the download path resolved it
 * (provider.resolveModelEntry), but `buildPoolModelConfig` looked ONLY in the
 * static `def.models` and threw `Model "X" not found in step "Y" catalog`,
 * failing the whole pool applyConfig.
 */
import { describe, expect, it } from 'vitest'
import * as os from 'node:os'
import type { ModelCatalogEntry } from '@camstack/types'
import { buildPoolModelConfigForStep } from '../engine-factory.js'

const PLUS_CATALOG_LABELS = ['person', 'car', 'dog'] as const

const customEntry: ModelCatalogEntry = {
  id: 'frigate-yolonas-s',
  name: 'plus catalog YOLO-NAS S',
  description: 'plus catalog style YOLO-NAS (flat NMS export)',
  formats: {
    onnx: {
      url: 'camstack-local://frigate-yolonas-s/frigate-yolonas-s.onnx',
      sizeMB: 49,
    },
  },
  inputSize: { width: 320, height: 320 },
  labels: PLUS_CATALOG_LABELS.map((name, i) => ({
    id: name,
    name: name || String(i),
  })),
  preprocessMode: 'letterbox',
  postprocessor: 'yolonas',
}

describe('buildPoolModelConfigForStep — custom models', () => {
  it('resolves a custom model through the injected resolver', () => {
    const config = buildPoolModelConfigForStep({
      stepId: 'object-detection',
      modelId: 'frigate-yolonas-s',
      poolRuntime: 'onnxruntime',
      modelsDir: os.tmpdir(),
      resolveCustomModel: (stepId, modelId) =>
        stepId === 'object-detection' && modelId === 'frigate-yolonas-s' ? customEntry : undefined,
    })
    expect(config.path.endsWith('/frigate-yolonas-s.onnx')).toBe(true)
    expect(config.inputWidth).toBe(320)
    expect(config.inputHeight).toBe(320)
    // The custom entry's per-model postprocessor override must win over the
    // step default ('yolo') even though the entry is not in the static catalog.
    expect(config.postprocessor).toBe('yolonas')
    // The custom entry's own label set must reach the pool — NOT the step's
    // COCO-80 fallback (a plus catalog model decodes with plus catalog labels).
    expect(config.labels).toEqual([...PLUS_CATALOG_LABELS])
    expect(config.numClasses).toBe(PLUS_CATALOG_LABELS.length)
  })

  it('reports the labels the step classMap will drop — never silently (D214)', () => {
    const dropped: {
      stepId: string
      modelId: string
      unmappedLabels: readonly string[]
    }[] = []
    const withUnmapped: ModelCatalogEntry = {
      ...customEntry,
      labels: ['person', 'car', 'deer', 'amazon'].map((name) => ({
        id: name,
        name,
      })),
    }
    buildPoolModelConfigForStep({
      stepId: 'object-detection',
      modelId: 'frigate-yolonas-s',
      poolRuntime: 'onnxruntime',
      modelsDir: os.tmpdir(),
      resolveCustomModel: () => withUnmapped,
      onClassMapDrop: (info) => dropped.push(info),
    })
    expect(dropped).toEqual([
      {
        stepId: 'object-detection',
        modelId: 'frigate-yolonas-s',
        unmappedLabels: ['deer', 'amazon'],
      },
    ])
  })

  it('does not report vehicle/animal as dropped when the model ships an identity classMap', () => {
    const dropped: unknown[] = []
    const pluginCatalog: ModelCatalogEntry = {
      ...customEntry,
      id: 'plugin-catalog-yolo',
      labels: ['person', 'vehicle', 'animal'].map((name) => ({ id: name, name })),
      classMap: {
        mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
        preserveOriginal: false,
      },
    }
    buildPoolModelConfigForStep({
      stepId: 'object-detection',
      modelId: 'plugin-catalog-yolo',
      poolRuntime: 'onnxruntime',
      modelsDir: os.tmpdir(),
      resolveCustomModel: () => pluginCatalog,
      onClassMapDrop: (info) => dropped.push(info),
    })
    expect(dropped).toEqual([])
  })

  it('does not invoke the drop reporter when every label maps', () => {
    const dropped: unknown[] = []
    buildPoolModelConfigForStep({
      stepId: 'object-detection',
      modelId: 'frigate-yolonas-s',
      poolRuntime: 'onnxruntime',
      modelsDir: os.tmpdir(),
      resolveCustomModel: () => customEntry,
      onClassMapDrop: (info) => dropped.push(info),
    })
    expect(dropped).toEqual([])
  })

  it('still throws for a model neither static nor custom', () => {
    expect(() =>
      buildPoolModelConfigForStep({
        stepId: 'object-detection',
        modelId: 'no-such-model',
        poolRuntime: 'onnxruntime',
        modelsDir: os.tmpdir(),
      }),
    ).toThrow(/not found/)
  })

  it('keeps static catalog resolution byte-identical (no resolver needed)', () => {
    const config = buildPoolModelConfigForStep({
      stepId: 'object-detection',
      modelId: 'yolo26n',
      poolRuntime: 'onnxruntime',
      modelsDir: os.tmpdir(),
    })
    expect(config.path.endsWith('/camstack-yolo26n.onnx')).toBe(true)
    expect(config.postprocessor).toBe('yolo')
    // yolo26n declares `labels: []` → the step's COCO-80 fallback applies.
    expect(config.labels?.length).toBe(80)
  })
})
