import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
// eslint-disable-next-line no-restricted-imports -- the revision rule is the downloader's (build-time dep, as in provider.ts)
import { resolveFormatRevision } from '@camstack/system/addon-utils'
import { OBJECT_DETECTION_MODELS } from '../registry/model-catalogs.js'
import {
  getDefaultModelForFormat,
  getStepDefinition,
  resolveModelForFormat,
} from '../registry/step-definitions.js'
import { buildPoolModelConfigForStep } from '../engine/engine-factory.js'
import { resolveDefaultDetectionModel } from '../default-detection-model.js'
import { modelFormatFor } from '../runtimes.js'

/**
 * The community YOLOv9-s EdgeTPU builds, offered in the catalog (D661 record
 * `DBRO_YOLOV9_EDGETPU_GPL`): mirrored byte-identical from the publisher's release on our Hugging Face repo, pinned
 * by sha256, decoded by `yolo-split-dfl`.
 */
const CORAL_SSD_ID = 'ssd-mobilenet-v2-coco-edgetpu'
const MIRROR =
  'https://huggingface.co/camstack/camstack-models/resolve/main/objectDetection/yolov9/tflite'

/** The publisher's `labels-coco17.txt`, in logit order. */
const COCO17 = [
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
] as const

const BUILDS = [
  {
    id: 'yolov9s-320-edgetpu',
    res: 320,
    url: `${MIRROR}/yolov9-s-relu6-best_320_int8_edgetpu.tflite`,
    sha256: '49a38e77439b475d0d259a6d9fe7ea32fcaa58de3748499dd120aceebad9c591',
  },
  {
    id: 'yolov9s-512-edgetpu',
    res: 512,
    url: `${MIRROR}/yolov9-s-relu6-tpumax_512_int8_edgetpu.tflite`,
    sha256: 'f634f60259101556825fd69662f96282e74364b507f83e6382cc34d5d0e6170e',
  },
] as const

const entryOf = (id: string) => OBJECT_DETECTION_MODELS.find((m) => m.id === id)

describe.each(BUILDS)('OBJECT_DETECTION_MODELS — $id (YOLOv9-s on the Coral)', (build) => {
  it('is a selectable object-detection entry with a tflite build only', () => {
    const entry = entryOf(build.id)
    expect(entry).toBeDefined()
    expect(entry?.legacy).not.toBe(true)
    expect(Object.keys(entry?.formats ?? {})).toEqual(['tflite'])
    expect(getStepDefinition('object-detection').models.some((m) => m.id === build.id)).toBe(true)
  })

  it('downloads the mirrored publisher file, pinned to its sha256', () => {
    const tflite = entryOf(build.id)?.formats.tflite
    expect(tflite?.url).toBe(build.url)
    // D744: a mirror-hosted format sets no revision inline; the mirror's table pins it.
    expect(tflite?.revision).toBeUndefined()
    expect(tflite === undefined ? undefined : resolveFormatRevision(tflite)).toBe(build.sha256)
    expect(tflite?.runtimes).toEqual(['python'])
  })

  it('declares its 17-class labelmap and the split-DFL decode', () => {
    const entry = entryOf(build.id)
    expect(entry?.postprocessor).toBe('yolo-split-dfl')
    expect(entry?.inputSize).toEqual({ width: build.res, height: build.res })
    expect(entry?.labels.map((l) => l.id)).toEqual([...COCO17])
  })

  it('reaches the edgetpu pool decoded by yolo-split-dfl with its own labels', () => {
    expect(modelFormatFor('edgetpu')).toBe('tflite')
    expect(resolveModelForFormat('object-detection', build.id, 'tflite')).toBe(build.id)
    const config = buildPoolModelConfigForStep({
      stepId: 'object-detection',
      modelId: build.id,
      poolRuntime: 'edgetpu',
      modelsDir: '/nonexistent-models-dir',
    })
    expect(config.postprocessor).toBe('yolo-split-dfl')
    expect(config.inputSize).toBe(build.res)
    expect(config.labels).toEqual([...COCO17])
  })

  it('carries the GPL-3.0 record, hosted on the CamStack mirror', () => {
    const license = entryOf(build.id)?.license
    expect(license?.weights).toBe('GPL-3.0')
    expect(license?.code).toBe('GPL-3.0')
    expect(license?.hosting).toBe('camstack-hf')
    expect(license?.upstream?.url).toBe('https://github.com/dbro/frigate-detector-edgetpu-yolo9')
    expect(license?.attribution).toMatch(/Chien-Yao Wang, I-Hau Yeh, Hong-Yuan Mark Liao/)
  })

  it('is named in the third-party notice as GPL-3.0', () => {
    const notice = readFileSync(new URL('../../../THIRD_PARTY_MODELS.md', import.meta.url), 'utf8')
    const row = notice.split('\n').find((line) => line.includes(`\`${build.id}\``))
    expect(row).toBeDefined()
    expect(row).toMatch(/GPL-3\.0/)
  })
})

describe('YOLOv9-s @320 is the Coral default (D908, amends D710)', () => {
  const DEFAULT_ID = 'yolov9s-320-edgetpu'

  it('is the tflite format default and resolves for cold-start', () => {
    const def = getStepDefinition('object-detection')
    expect(def.defaultModelIdByFormat?.tflite).toBe(DEFAULT_ID)
    expect(getDefaultModelForFormat('object-detection', 'tflite')).toBe(DEFAULT_ID)
    expect(resolveModelForFormat('object-detection', null, 'tflite')).toBe(DEFAULT_ID)
  })

  it.each(['usb', 'pci'])('an edgetpu:%s device defaults to YOLOv9-s @320', (device) => {
    expect(resolveDefaultDetectionModel('edgetpu', device, 'tflite')).toBe(DEFAULT_ID)
  })

  it('an explicit pin keeps its model: the SSD and the 512 build still resolve to themselves', () => {
    expect(resolveModelForFormat('object-detection', CORAL_SSD_ID, 'tflite')).toBe(CORAL_SSD_ID)
    expect(resolveModelForFormat('object-detection', 'yolov9s-512-edgetpu', 'tflite')).toBe(
      'yolov9s-512-edgetpu',
    )
  })

  it('the 512 build is no default of any format', () => {
    const def = getStepDefinition('object-detection')
    const defaults = [def.defaultModelId, ...Object.values(def.defaultModelIdByFormat ?? {})]
    expect(defaults).not.toContain('yolov9s-512-edgetpu')
  })

  it.each(BUILDS)('$id has its own class floors, none at the global person 0.65', (build) => {
    const floors = entryOf(build.id)?.defaultClassFloors
    expect(floors).toBeDefined()
    expect(floors?.['person']).toBeLessThanOrEqual(0.4)
    expect(floors?.['vehicle']).toBeLessThanOrEqual(0.4)
    expect(floors?.['animal']).toBeLessThanOrEqual(0.3)
  })
})
