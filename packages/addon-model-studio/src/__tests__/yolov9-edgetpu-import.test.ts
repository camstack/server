/**
 * An operator-supplied EdgeTPU YOLOv9 (the community plus catalog export: a
 * full-integer `.tflite` compiled with edgetpu_compiler, box `[1, N, 64]` +
 * class-logit `[1, N, C]` with the strides concatenated) is importable
 * through the Register flow: format `tflite` (the edgetpu runtime) and the
 * `yolo-split-dfl` decode, which the pool ships. A decode the Register flow
 * does not list is dropped and the step default `yolo` would decode the file
 * — wrongly — so the decode's presence in the list is the import path.
 */
import { describe, expect, it } from 'vitest'
import { parsePlusCatalogLabelmap } from '../plus-catalog/plus-catalog-import.js'
import {
  buildRegistrationDescriptor,
  REGISTRABLE_POSTPROCESSORS,
  registrablePostprocessor,
} from '../plus-catalog/registration.js'

// labels-coco17.txt as the export ships it, one label per line.
const COCO17_LABELMAP = [
  'person',
  'bicycle',
  'car',
  'motorcycle',
  'airplane',
  'bus',
  'train',
  'truck',
  'boat',
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
].join('\n')

describe('YOLOv9 EdgeTPU import (operator-supplied file)', () => {
  it('offers the split-head DFL decode the Edge TPU YOLOv9 layout needs', () => {
    expect(REGISTRABLE_POSTPROCESSORS).toContain('yolo-split-dfl')
    expect(registrablePostprocessor('yolo-split-dfl')).toBe('yolo-split-dfl')
  })

  it('still drops a decode nobody ships (the step default then applies)', () => {
    expect(registrablePostprocessor('not-a-decode')).toBeUndefined()
    expect(registrablePostprocessor('')).toBeUndefined()
  })

  it('registers the uploaded .tflite as an edgetpu-runtime detector with its labelmap', () => {
    const labels = parsePlusCatalogLabelmap(COCO17_LABELMAP)
    const postprocessor = registrablePostprocessor('yolo-split-dfl')
    const descriptor = buildRegistrationDescriptor({
      type: 'custom',
      modelId: 'yolov9-s-relu6-320-edgetpu',
      name: 'YOLOv9 S (Coral)',
      stepId: 'object-detection',
      source: {
        kind: 'upload',
        filename: 'yolov9-s-relu6-best_320_int8_edgetpu.tflite',
        sizeMB: 8.2,
      },
      format: 'tflite',
      ...(postprocessor !== undefined ? { postprocessor } : {}),
      inputWidth: 320,
      inputHeight: 320,
      labels,
    })
    const { entry } = descriptor
    expect(descriptor.stepId).toBe('object-detection')
    expect(Object.keys(entry.formats)).toEqual(['tflite'])
    expect(entry.formats.tflite?.url).toBe(
      'camstack-local://yolov9-s-relu6-320-edgetpu/yolov9-s-relu6-best_320_int8_edgetpu.tflite',
    )
    expect(entry.postprocessor).toBe('yolo-split-dfl')
    expect(entry.inputSize).toEqual({ width: 320, height: 320 })
    expect(entry.preprocessMode).toBe('letterbox')
    expect(entry.provider).toBe('custom')
    // Order IS the logit index: class 9 of the export is `bird`, not COCO-80's `traffic light`.
    expect(entry.labels.map((l) => l.id)).toHaveLength(17)
    expect(entry.labels[9]?.id).toBe('bird')
    expect(entry.labels[16]?.id).toBe('bear')
  })
})
