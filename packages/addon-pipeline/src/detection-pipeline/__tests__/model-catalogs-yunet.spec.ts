import { describe, it, expect } from 'vitest'
import type { ModelFormat } from '@camstack/types'
import { FACE_DETECTION_MODELS } from '../registry/model-catalogs.js'
import {
  getDefaultModelForFormat,
  getStepDefinition,
  resolveModelForFormat,
} from '../registry/step-definitions.js'
import { buildPoolModelConfigForStep } from '../engine/engine-factory.js'
import { postprocessorConsumesNms } from '../registry/model-knob-applicability.js'

// D645 — YuNet joined the face catalog as a selectable detector and became the
// face-detection default on 2026-09-26, after a live run on camera 104 (hub NPU + GPU).
const YUNET_ID = 'yunet-2023mar'
const yunet = FACE_DETECTION_MODELS.find((m) => m.id === YUNET_ID)

describe('FACE_DETECTION_MODELS catalog — yunet-2023mar', () => {
  it('is in the face-detection step, selectable (not legacy)', () => {
    expect(yunet).toBeDefined()
    expect(yunet?.legacy).not.toBe(true)
    expect(getStepDefinition('face-detection').models.some((m) => m.id === YUNET_ID)).toBe(true)
  })

  it('decodes with the yunet postprocessor — the step default `scrfd` finds 0 faces on this graph', () => {
    expect(yunet?.postprocessor).toBe('yunet')
  })

  it('declares NO pool normalisation: the RGB/255 → BGR 0..255 contract is baked into the graph', () => {
    // A pool-side normalisation on top of the baked Mul(255)+Gather would apply
    // the contract twice — on every backend at once.
    expect(yunet?.inputNormalization).toBeUndefined()
  })

  it('ships onnx / openvino / coreml from faceDetection/yunet on camstack/camstack-models', () => {
    const formats = yunet?.formats
    expect(formats?.onnx?.url).toMatch(
      /camstack\/camstack-models\/resolve\/main\/faceDetection\/yunet\/onnx\/camstack-yunet-2023mar\.onnx$/,
    )
    expect(formats?.openvino?.url).toMatch(
      /faceDetection\/yunet\/openvino\/camstack-yunet-2023mar\.xml$/,
    )
    // Without the .bin sibling OpenVINO compile fails ("Empty weights data").
    expect(formats?.openvino?.files).toEqual(['camstack-yunet-2023mar.bin'])
    expect(formats?.coreml?.url).toMatch(
      /faceDetection\/yunet\/coreml\/camstack-yunet-2023mar\.mlpackage$/,
    )
    expect(formats?.coreml?.isDirectory).toBe(true)
  })

  it('carries its licence like every other entry', () => {
    expect(yunet?.license?.weights).toBe('MIT')
  })

  it('reaches the Python pool as postprocessor yunet with no inputNormalization', () => {
    for (const poolRuntime of ['onnxruntime', 'openvino', 'coreml'] as const) {
      const config = buildPoolModelConfigForStep({
        stepId: 'face-detection',
        modelId: YUNET_ID,
        poolRuntime,
        modelsDir: '/nonexistent-models-dir',
      })
      expect(config.postprocessor).toBe('yunet')
      expect(config.inputNormalization).toBeUndefined()
      expect(config.inputSize).toBe(640)
      expect(config.preprocessMode).toBe('letterbox')
    }
  })

  it('honours the NMS IoU knob (yunet.py runs its own NMS)', () => {
    expect(postprocessorConsumesNms('yunet')).toBe(true)
  })
})

describe('face-detection default is yunet-2023mar (since 2026-09-26)', () => {
  it('declares yunet-2023mar as the step default', () => {
    expect(getStepDefinition('face-detection').defaultModelId).toBe(YUNET_ID)
  })

  it.each<ModelFormat>([
    'onnx',
    'openvino',
    'coreml',
  ])('the %s format default is YuNet', (format) => {
    expect(getDefaultModelForFormat('face-detection', format)).toBe(YUNET_ID)
  })

  it('tflite is YuNet’s own Coral build — a format of the survivor, not a sibling id (D710)', () => {
    expect(yunet?.formats.tflite?.url).toBe(
      'https://huggingface.co/camstack/camstack-models/resolve/main/faceDetection/yunet/tflite/camstack-yunet-2023mar_edgetpu.tflite',
    )
    expect(yunet?.formats.tflite?.runtimes).toEqual(['python'])
    expect(yunet?.license?.modifications).toContain('edgetpu_compiler')
    expect(getDefaultModelForFormat('face-detection', 'tflite')).toBe(YUNET_ID)
    expect(getStepDefinition('face-detection').defaultModelIdByFormat?.['tflite']).toBeUndefined()
  })

  it('YuNet is the ONLY face detector — SCRFD (and its stub siblings) left the catalog', () => {
    expect(FACE_DETECTION_MODELS.map((m) => m.id)).toEqual([YUNET_ID])
    // A saved scrfd pin is no longer redirected: it passes through as a custom id.
    expect(resolveModelForFormat('face-detection', 'scrfd-2.5g', 'onnx')).toBe('scrfd-2.5g')
  })

  it('declares no scrfd input normalization — the baked graphs apply their own contract once', () => {
    expect(yunet?.inputNormalization).toBeUndefined()
  })
})
