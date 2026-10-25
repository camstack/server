import { describe, it, expect } from 'vitest'
import {
  ANIMAL_CLASSIFIER_MODELS,
  BIRD_CLASSIFIER_MODELS,
  FACE_DETECTION_MODELS,
  VEHICLE_CLASSIFIER_MODELS,
} from '../registry/model-catalogs.js'
import { stepModelRunsOnFormat } from '@camstack/types'
import { buildSubtreeCanRun, resolveStepDevice } from '../../pipeline-runner/device-jump.js'
import { getDefaultModelForFormat, getStepDefinition } from '../registry/step-definitions.js'

// ---------------------------------------------------------------------------
// New PRIMARY classifiers (2026-07-19) + legacy demotion.
// ---------------------------------------------------------------------------

describe('classifier model catalogs — PRIMARY entries + legacy flags', () => {
  // `animals-10`, `bird-nabirds-404` and `vehicle-type-efficientnet` were
  // deleted from the catalog (D661) — see removed-model-ids.spec.ts.
  it('animal catalog is `animal-classifier` alone', () => {
    expect(ANIMAL_CLASSIFIER_MODELS.map((m) => m.id)).toEqual(['animal-classifier'])
    expect(ANIMAL_CLASSIFIER_MODELS[0]?.legacy).toBeUndefined()
  })

  it('bird catalog is `bird-classifier` alone (the AIY-edgetpu stub is gone)', () => {
    expect(BIRD_CLASSIFIER_MODELS.map((m) => m.id)).toEqual(['bird-classifier'])
    expect(BIRD_CLASSIFIER_MODELS[0]?.legacy).toBeUndefined()
  })

  it('vehicle catalog is `vehicle-type-v1` alone', () => {
    expect(VEHICLE_CLASSIFIER_MODELS.map((m) => m.id)).toEqual(['vehicle-type-v1'])
    expect(VEHICLE_CLASSIFIER_MODELS[0]?.legacy).toBeUndefined()
  })

  it('every PRIMARY entry ships onnx + coreml + openvino formats', () => {
    for (const m of [
      ANIMAL_CLASSIFIER_MODELS[0],
      BIRD_CLASSIFIER_MODELS[0],
      VEHICLE_CLASSIFIER_MODELS[0],
    ]) {
      expect(m?.formats.onnx).toBeDefined()
      expect(m?.formats.coreml).toBeDefined()
      expect(m?.formats.openvino).toBeDefined()
    }
  })
})

describe('classifier model catalogs — HF URLs + label extraFiles', () => {
  const BASE = 'https://huggingface.co/camstack/camstack-models/resolve/main/'

  it('animal-classifier resolves the expected HF onnx URL + labels extraFile', () => {
    const m = ANIMAL_CLASSIFIER_MODELS[0]
    expect(m?.formats.onnx?.url).toBe(
      `${BASE}animalClassification/animal-classifier/onnx/animal-classifier.onnx`,
    )
    expect(m?.formats.openvino?.url).toBe(
      `${BASE}animalClassification/animal-classifier/openvino/animal-classifier.xml`,
    )
    const labels = m?.extraFiles?.find((f) => f.filename.endsWith('-labels.json'))
    expect(labels?.filename).toBe('animal-classifier-labels.json')
    expect(labels?.url).toBe(
      `${BASE}animalClassification/animal-classifier/onnx/animal-classifier-labels.json`,
    )
  })

  it('bird-classifier resolves the expected HF URLs + labels extraFile', () => {
    const m = BIRD_CLASSIFIER_MODELS[0]
    expect(m?.formats.onnx?.url).toBe(
      `${BASE}animalClassification/bird-classifier/onnx/bird-classifier.onnx`,
    )
    const labels = m?.extraFiles?.find((f) => f.filename.endsWith('-labels.json'))
    expect(labels?.filename).toBe('bird-classifier-labels.json')
  })

  it('vehicle-type-v1 resolves the expected HF URLs + labels extraFile', () => {
    const m = VEHICLE_CLASSIFIER_MODELS[0]
    expect(m?.formats.onnx?.url).toBe(
      `${BASE}vehicleClassification/vehicle-type-v1/onnx/vehicle-type-v1.onnx`,
    )
    const labels = m?.extraFiles?.find((f) => f.filename.endsWith('-labels.json'))
    expect(labels?.filename).toBe('vehicle-type-v1-labels.json')
  })
})

// ---------------------------------------------------------------------------
// THE BIRD TRAP: per-entry preprocessing must diverge on all three axes.
// ---------------------------------------------------------------------------

describe('classifier inference contract — encoded per catalog entry', () => {
  it('animal + vehicle are NCHW / imagenet / raw-logits (softmax at consumer)', () => {
    for (const m of [ANIMAL_CLASSIFIER_MODELS[0], VEHICLE_CLASSIFIER_MODELS[0]]) {
      expect(m?.inputLayout).toBe('nchw')
      expect(m?.inputNormalization).toBe('imagenet')
      // raw logits ⇒ the postprocessor still applies softmax
      expect(m?.outputProbabilities).toBeUndefined()
      expect(m?.inputSize).toEqual({ width: 224, height: 224 })
    }
  })

  it('bird diverges on ALL THREE axes: NHWC + none + softmax-already-applied', () => {
    const bird = BIRD_CLASSIFIER_MODELS[0]
    expect(bird?.inputLayout).toBe('nhwc')
    expect(bird?.inputNormalization).toBe('none')
    expect(bird?.outputProbabilities).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Step wiring: default model ids point at the new primaries + confidence gates.
// ---------------------------------------------------------------------------

describe('classifier steps — default models + confidence gates + reject list', () => {
  it('animal-classifier step defaults to the new model with a 0.5 gate', () => {
    const def = getStepDefinition('animal-classifier')
    expect(def.defaultModelId).toBe('animal-classifier')
    expect(def.defaultConfidence).toBe(0.5)
    // ON by default, its answer sourced from the root model (D736).
    expect(def.enabledByDefault).toBe(true)
  })

  it('vehicle-classifier step defaults to vehicle-type-v1 with a 0.5 gate', () => {
    const def = getStepDefinition('vehicle-classifier')
    expect(def.defaultModelId).toBe('vehicle-type-v1')
    expect(def.defaultConfidence).toBe(0.5)
  })

  it('bird-classifier step defaults to bird-classifier with a 0.6 gate + background reject', () => {
    const def = getStepDefinition('bird-classifier')
    expect(def.defaultModelId).toBe('bird-classifier')
    expect(def.defaultConfidence).toBe(0.6)
    expect(def.rejectClasses).toContain('background')
  })
})

// ---------------------------------------------------------------------------
// The Coral EdgeTPU face SSD and AIY-bird stubs were DELETED from the catalog:
// neither had a working decode path. Both steps' Coral builds came back the
// D710 way — a FORMAT of the one survivor (same id), not a sibling model —
// once the edgetpu dequant landed (bird), and once the bake could be folded
// into the first Conv (YuNet).
// ---------------------------------------------------------------------------

describe('the deleted Coral stubs leave no tflite sibling behind', () => {
  it('face-detection’s only tflite build is YuNet’s own, and it declares no tflite default', () => {
    expect(
      FACE_DETECTION_MODELS.filter((m) => m.formats.tflite !== undefined).map((m) => m.id),
    ).toEqual(['yunet-2023mar'])
    expect(getStepDefinition('face-detection').defaultModelIdByFormat?.['tflite']).toBeUndefined()
    expect(getDefaultModelForFormat('face-detection', 'tflite')).toBe('yunet-2023mar')
  })

  it('placement: a Coral-elected camera runs face detection on the Coral unless the node sets jumpDeviceKey', () => {
    const canRunFace = buildSubtreeCanRun({ addonId: 'face-detection' }, (id) =>
      getStepDefinition(id),
    )
    const devices = [
      { deviceKey: 'edgetpu:usb', weight: 1, maxSessions: null, attachedCameras: 0 },
      { deviceKey: 'openvino:gpu', weight: 1, maxSessions: null, attachedCameras: 0 },
    ]
    expect(
      resolveStepDevice({ effectiveDeviceKey: 'edgetpu:usb', devices, canRun: canRunFace }),
    ).toEqual({
      kind: 'no-jump',
      deviceKey: 'edgetpu:usb',
    })
    expect(
      resolveStepDevice({
        effectiveDeviceKey: 'edgetpu:usb',
        devices,
        canRun: canRunFace,
        manualJumpDeviceKey: 'openvino:gpu',
      }),
    ).toEqual({ kind: 'jumped', deviceKey: 'openvino:gpu', reason: 'manual' })
  })
})

describe('bird-classifier — the Coral build is a format of the survivor (D710)', () => {
  const BASE = 'https://huggingface.co/camstack/camstack-models/resolve/main/'
  const bird = BIRD_CLASSIFIER_MODELS[0]
  const device = (deviceKey: string) => ({
    deviceKey,
    weight: 1,
    maxSessions: null,
    attachedCameras: 0,
  })
  const canRun = buildSubtreeCanRun({ addonId: 'bird-classifier' }, (id) => getStepDefinition(id))

  it('ships `formats.tflite` on the same id, from the HF mirror, for the python pool', () => {
    expect(BIRD_CLASSIFIER_MODELS.map((m) => m.id)).toEqual(['bird-classifier'])
    expect(bird?.formats.tflite?.url).toBe(
      `${BASE}animalClassification/bird-classifier/tflite/bird-classifier_edgetpu.tflite`,
    )
    expect(bird?.formats.tflite?.runtimes).toEqual(['python'])
    expect(bird?.license?.modifications).toContain('edgetpu_compiler')
  })

  it('a tflite pool can run the step, and its format default is the survivor WITH a build', () => {
    const def = getStepDefinition('bird-classifier')
    expect(stepModelRunsOnFormat(def.models, null, 'tflite')).toBe(true)
    expect(def.defaultModelIdByFormat?.['tflite']).toBeUndefined()
    const id = getDefaultModelForFormat('bird-classifier', 'tflite')
    expect(id).toBe('bird-classifier')
    expect(def.models.find((m) => m.id === id)?.formats.tflite).toBeDefined()
  })

  it('placement: a Coral-elected camera keeps the step on the Coral unless the node sets jumpDeviceKey', () => {
    const devices = [device('edgetpu:usb'), device('openvino:gpu')]
    expect(resolveStepDevice({ effectiveDeviceKey: 'edgetpu:usb', devices, canRun })).toEqual({
      kind: 'no-jump',
      deviceKey: 'edgetpu:usb',
    })
    expect(
      resolveStepDevice({
        effectiveDeviceKey: 'edgetpu:usb',
        devices,
        canRun,
        manualJumpDeviceKey: 'openvino:gpu',
      }),
    ).toEqual({ kind: 'jumped', deviceKey: 'openvino:gpu', reason: 'manual' })
  })
})
