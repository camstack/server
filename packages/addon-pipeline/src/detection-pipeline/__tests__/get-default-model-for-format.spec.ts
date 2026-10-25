import { describe, it, expect } from 'vitest'
import {
  getDefaultModelForFormat,
  getDefaultModelForFormatFromDef,
  getStepDefinition,
} from '../registry/step-definitions.js'
import type { ModelFormat } from '@camstack/types'

/**
 * G1: getDefaultModelForFormat must honor the step's DECLARED default
 * (defaultModelIdByFormat[format], then defaultModelId) before ever
 * falling back to "smallest model with a build for this format".
 *
 * Resolution order under test:
 *   1. def.defaultModelIdByFormat?.[format] — if that model exists in
 *      def.models AND has a build for `format`.
 *   2. def.defaultModelId — if it exists in def.models AND has a build
 *      for `format`.
 *   3. Smallest-by-size non-legacy model with a build for `format`.
 *   4. No non-legacy model has a `format` build: the declared per-format id
 *      if any, else def.defaultModelId unchanged (the unloadable case).
 */

// Independently re-derive "smallest model with a build for `format`" from the
// catalog — a local oracle, not a call into the production algorithm — so
// the "existing behavior preserved" assertion doesn't just re-assert the
// implementation against itself.
function smallestByFormat(stepId: string, format: ModelFormat): string | undefined {
  const def = getStepDefinition(stepId)
  const available = def.models.filter((m) => m.formats[format])
  if (available.length === 0) return undefined
  const sorted = [...available].sort((a, b) => {
    const sizeA = a.formats[format]?.sizeMB ?? Infinity
    const sizeB = b.formats[format]?.sizeMB ?? Infinity
    return sizeA - sizeB
  })
  return sorted[0]!.id
}

describe('getDefaultModelForFormat — declared-default resolution order', () => {
  it('honors a declared defaultModelIdByFormat entry over defaultModelId (audio-classifier/coreml → apple-soundanalysis)', () => {
    // Real catalog declaration: audio-classifier declares
    // defaultModelIdByFormat.coreml = 'apple-soundanalysis', distinct from
    // its plain defaultModelId ('yamnet-onnx'). Self-skip if that catalog
    // entry is ever removed.
    const def = getStepDefinition('audio-classifier')
    if (def.defaultModelIdByFormat?.['coreml'] === undefined) return

    const declared = def.defaultModelIdByFormat['coreml']
    expect(getDefaultModelForFormat('audio-classifier', 'coreml')).toBe(declared)
    // Prove step 1 (per-format map) actually fired, not step 2 (plain default).
    expect(declared).not.toBe(def.defaultModelId)
  })

  it('object-detection coreml/openvino default is the DECLARED defaultModelId (yolo26n), not the smallest model (yolov9t)', () => {
    const def = getStepDefinition('object-detection')
    expect(def.defaultModelId).toBe('yolo26n')
    // No per-format override declared for object-detection — resolution
    // falls to step 2 (plain defaultModelId).
    expect(def.defaultModelIdByFormat?.['coreml']).toBeUndefined()
    expect(def.defaultModelIdByFormat?.['openvino']).toBeUndefined()

    // Both formats have a smaller model than yolo26n — the FP16 YOLOv9 CoreML
    // packages (D743) and the OpenVINO int8 variants — so the declared default
    // winning is not an accident of size.
    expect(smallestByFormat('object-detection', 'coreml')).not.toBe('yolo26n')
    expect(smallestByFormat('object-detection', 'openvino')).not.toBe('yolo26n')

    expect(getDefaultModelForFormat('object-detection', 'coreml')).toBe('yolo26n')
    expect(getDefaultModelForFormat('object-detection', 'openvino')).toBe('yolo26n')
  })

  it('face-detection: the declared default is YuNet on every format it ships, never SCRFD (D645, 2026-09-26)', () => {
    const def = getStepDefinition('face-detection')
    expect(def.defaultModelId).toBe('yunet-2023mar')
    // No per-format override for the formats YuNet ships — step 2 answers.
    for (const format of ['onnx', 'coreml', 'openvino'] as const) {
      expect(def.defaultModelIdByFormat?.[format]).toBeUndefined()
      expect(getDefaultModelForFormat('face-detection', format)).toBe('yunet-2023mar')
      expect(getDefaultModelForFormat('face-detection', format)).not.toBe('scrfd-2.5g')
    }
  })

  it('face-detection tflite: NO declared default — YuNet, the step default, ships its own Coral build (D710)', () => {
    const def = getStepDefinition('face-detection')
    // The old declaration named a model with no tflite build (D657). Since
    // YuNet's Edge TPU build, the step default itself has one.
    expect(
      def.models.filter((m) => m.formats.tflite && m.legacy !== true).map((m) => m.id),
    ).toEqual([def.defaultModelId])
    expect(def.defaultModelIdByFormat?.['tflite']).toBeUndefined()
    expect(getDefaultModelForFormat('face-detection', 'tflite')).toBe(def.defaultModelId)
    expect(getDefaultModelForFormatFromDef(def, 'tflite')).toBe(def.defaultModelId)
  })

  it('clip-embedding coreml/openvino default is the DECLARED defaultModelId (siglip2-b16-224)', () => {
    const def = getStepDefinition('clip-embedding')
    expect(def.defaultModelId).toBe('siglip2-b16-224')
    for (const format of ['coreml', 'openvino'] as const) {
      expect(smallestByFormat('clip-embedding', format)).toBe('siglip2-b16-224')
      expect(getDefaultModelForFormat('clip-embedding', format)).toBe('siglip2-b16-224')
    }
    // No clip model ships an onnx build (the int8 vision exports were
    // misaligned — see model-catalogs-clip.spec). Format-default resolution
    // falls back to defaultModelId (the unloadable case); serving is prevented
    // by the format check itself, and the cluster rule forbids substitution.
    expect(getDefaultModelForFormat('clip-embedding', 'onnx')).toBe('siglip2-b16-224')
  })

  it('zero models with a build for the format → unchanged fallback to defaultModelId (unloadable case, not this task’s concern)', () => {
    const def = getStepDefinition('object-detection')
    // No catalog model declares a 'pt' build anywhere.
    expect(getDefaultModelForFormat('object-detection', 'pt')).toBe(def.defaultModelId)
  })

  it('object-detection tflite default is the declared Coral YOLOv9-s @320 build (D908) (defaultModelIdByFormat.tflite), not smallest-by-size', () => {
    const def = getStepDefinition('object-detection')
    // Coral integration: object-detection declares a per-format tflite default
    // (YOLOv9-s @320, D908) distinct from its plain
    // defaultModelId (yolo26n, which has no tflite build). Self-skip if the
    // declaration is ever removed.
    const declared = def.defaultModelIdByFormat?.['tflite']
    if (declared === undefined) return
    expect(declared).toBe('yolov9s-320-edgetpu')
    expect(getDefaultModelForFormat('object-detection', 'tflite')).toBe(declared)
    expect(declared).not.toBe(def.defaultModelId)
  })
})
