import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { OBJECT_DETECTION_MODELS } from '../registry/model-catalogs.js'
import {
  getDefaultModelForFormat,
  getStepDefinition,
  resolveModelForFormat,
} from '../registry/step-definitions.js'
import { buildPoolModelConfigForStep } from '../engine/engine-factory.js'
import { postprocessorConsumesNms } from '../registry/model-knob-applicability.js'

/** The one CamStack-offered Coral OD model (D703 follow-up: rivals deleted). */
const CORAL_DEFAULT_ID = 'ssd-mobilenet-v2-coco-edgetpu'
/** The Coral default since D908: the YOLOv9-s @320 build beats the SSD on the same TPU. */
const CORAL_FORMAT_DEFAULT_ID = 'yolov9s-320-edgetpu'
const DELETED_CORAL_IDS = ['efficientdet-lite0-edgetpu', 'ssdlite-mobiledet-coco-edgetpu'] as const

const coralDefault = OBJECT_DETECTION_MODELS.find((m) => m.id === CORAL_DEFAULT_ID)

describe('OBJECT_DETECTION_MODELS — CamStack Coral SSD survivor', () => {
  it('is the only CamStack SSD tflite detector, selectable (not legacy)', () => {
    expect(coralDefault).toBeDefined()
    expect(coralDefault?.legacy).not.toBe(true)
    // Beside it only the YOLOv9-s Coral builds (selectable, never a default —
    // model-catalogs-coral-yolov9.spec.ts).
    const tfliteIds = OBJECT_DETECTION_MODELS.filter((m) => m.formats.tflite !== undefined).map(
      (m) => m.id,
    )
    expect(tfliteIds).toEqual([CORAL_DEFAULT_ID, 'yolov9s-320-edgetpu', 'yolov9s-512-edgetpu'])
    expect(
      getStepDefinition('object-detection').models.some((m) => m.id === CORAL_DEFAULT_ID),
    ).toBe(true)
  })

  it('has tflite only, python runtime, ssd decode, 300×300', () => {
    expect(Object.keys(coralDefault?.formats ?? {})).toEqual(['tflite'])
    expect(coralDefault?.formats.tflite?.runtimes).toEqual(['python'])
    expect(coralDefault?.postprocessor).toBe('ssd')
    expect(coralDefault?.preprocessMode).toBe('letterbox')
    expect(coralDefault?.labels).toEqual([])
    expect(coralDefault?.inputSize).toEqual({ width: 300, height: 300 })
    expect(coralDefault?.formats.tflite?.url).toBe(
      'https://github.com/google-coral/test_data/raw/master/ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite',
    )
  })

  it('is no longer the tflite format default (D908) but stays selectable and pinnable', () => {
    const def = getStepDefinition('object-detection')
    expect(def.defaultModelIdByFormat?.tflite).toBe(CORAL_FORMAT_DEFAULT_ID)
    expect(getDefaultModelForFormat('object-detection', 'tflite')).toBe(CORAL_FORMAT_DEFAULT_ID)
    expect(resolveModelForFormat('object-detection', null, 'tflite')).toBe(CORAL_FORMAT_DEFAULT_ID)
    expect(resolveModelForFormat('object-detection', CORAL_DEFAULT_ID, 'tflite')).toBe(
      CORAL_DEFAULT_ID,
    )
  })

  it('reaches the edgetpu pool as postprocessor ssd', () => {
    const config = buildPoolModelConfigForStep({
      stepId: 'object-detection',
      modelId: CORAL_DEFAULT_ID,
      poolRuntime: 'edgetpu',
      modelsDir: '/nonexistent-models-dir',
    })
    expect(config.postprocessor).toBe('ssd')
    expect(config.inputSize).toBe(300)
    expect(config.preprocessMode).toBe('letterbox')
  })

  it('does not consume the NMS knob', () => {
    expect(postprocessorConsumesNms('ssd')).toBe(false)
  })

  it('is named in the third-party notice (selectable, not the default since D908, not hidden)', () => {
    const notice = readFileSync(new URL('../../../THIRD_PARTY_MODELS.md', import.meta.url), 'utf8')
    const row = notice.split('\n').find((line) => line.includes(`\`${CORAL_DEFAULT_ID}\``))
    expect(row).toBeDefined()
    expect(row).toMatch(/Apache-2\.0/)
    expect(row).not.toMatch(/default/)
    expect(row).not.toMatch(/hidden/)
  })

  it.each(DELETED_CORAL_IDS)('%s is gone from the catalog', (id) => {
    expect(OBJECT_DETECTION_MODELS.some((m) => m.id === id)).toBe(false)
    expect(resolveModelForFormat('object-detection', id, 'tflite')).toBe(id)
  })
})
