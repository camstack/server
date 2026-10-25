/**
 * The per-format facts `getSchema` reports beside `downloaded`: what is on
 * disk (`onDisk` — current / stale / missing, D743/D744) and the precision of
 * the build (`precision`). Model Studio → Installed renders both; before they
 * existed a stale copy read exactly like "not downloaded" and nothing said
 * whether a file was an INT8 or an FP16 build.
 */
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { HF_REPO, hfModelUrl, type ModelCatalogEntry } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatPrecision, modelOnDiskState } from '../model-format-facts.js'

const MIRROR = hfModelUrl(HF_REPO, '')

function entry(partial: Partial<ModelCatalogEntry> & Pick<ModelCatalogEntry, 'formats'>) {
  const base: ModelCatalogEntry = {
    id: 'm',
    name: 'M',
    description: '',
    inputSize: { width: 320, height: 320 },
    labels: [],
    formats: {},
  }
  return { ...base, ...partial }
}

describe('formatPrecision', () => {
  it('reads an explicit precision token from the artefact file name', () => {
    const e = entry({
      formats: {
        openvino: { url: `${MIRROR}x/openvino/camstack-yolov9m-320-int8.xml`, sizeMB: 20 },
        onnx: { url: `${MIRROR}x/onnx/camstack-yolo26n-fp16.onnx`, sizeMB: 5 },
        tflite: { url: `${MIRROR}x/camstack-yunet_int8_edgetpu.tflite`, sizeMB: 1 },
      },
    })
    expect(formatPrecision(e, 'openvino')).toBe('int8')
    expect(formatPrecision(e, 'onnx')).toBe('fp16')
    expect(formatPrecision(e, 'tflite')).toBe('int8')
  })

  it('an int8 variant group is int8 in every format', () => {
    const e = entry({
      group: { family: 'yolov9', tier: 'm', precision: 'int8' },
      formats: { openvino: { url: `${MIRROR}x/openvino/camstack-yolov9m.xml`, sizeMB: 20 } },
    })
    expect(formatPrecision(e, 'openvino')).toBe('int8')
  })

  it('an EdgeTPU build is int8 (the compiler takes nothing else)', () => {
    const e = entry({
      formats: { tflite: { url: `${MIRROR}x/ssd_mobilenet_v2_coco_edgetpu.tflite`, sizeMB: 6 } },
    })
    expect(formatPrecision(e, 'tflite')).toBe('int8')
  })

  it('a CamStack Core ML build is fp16 (D743), a third-party one is not assumed', () => {
    const own = entry({
      formats: { coreml: { url: `${MIRROR}x/coreml/camstack-yolov9m-320.mlpackage`, sizeMB: 38 } },
    })
    expect(formatPrecision(own, 'coreml')).toBe('fp16')
    const imported = entry({
      provider: 'scrypted',
      formats: {
        coreml: { url: 'https://example.invalid/plugin-catalog/yolov9.mlpackage', sizeMB: 38 },
      },
    })
    expect(formatPrecision(imported, 'coreml')).toBeUndefined()
  })

  it('says nothing when the build does not tell (an unsuffixed IR is fp16 for one family and fp32 for another)', () => {
    const e = entry({
      formats: {
        openvino: { url: `${MIRROR}x/openvino/camstack-yolo26n.xml`, sizeMB: 9 },
        onnx: { url: `${MIRROR}x/onnx/camstack-yolo26n.onnx`, sizeMB: 10 },
      },
    })
    expect(formatPrecision(e, 'openvino')).toBeUndefined()
    expect(formatPrecision(e, 'onnx')).toBeUndefined()
    expect(formatPrecision(e, 'coreml')).toBeUndefined()
  })
})

describe('modelOnDiskState', () => {
  let dir: string
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'format-facts-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  const revisioned = entry({
    formats: { onnx: { url: `${MIRROR}x/m.onnx`, sizeMB: 1, revision: 'abc' } },
  })
  const plain = entry({ formats: { onnx: { url: `${MIRROR}x/p.onnx`, sizeMB: 1 } } })

  it('missing when no file is on disk, or the format has no build', () => {
    expect(modelOnDiskState(dir, revisioned, 'onnx')).toBe('missing')
    expect(modelOnDiskState(dir, revisioned, 'openvino')).toBe('missing')
  })

  it('stale when a file is there but is not the recorded revision', () => {
    fs.writeFileSync(path.join(dir, 'm.onnx'), 'old bytes')
    expect(modelOnDiskState(dir, revisioned, 'onnx')).toBe('stale')
    fs.writeFileSync(path.join(dir, 'm.onnx.revision'), 'older')
    expect(modelOnDiskState(dir, revisioned, 'onnx')).toBe('stale')
  })

  it('current when the recorded revision matches, or the format carries none', () => {
    fs.writeFileSync(path.join(dir, 'm.onnx'), 'bytes')
    fs.writeFileSync(path.join(dir, 'm.onnx.revision'), 'abc')
    expect(modelOnDiskState(dir, revisioned, 'onnx')).toBe('current')
    fs.writeFileSync(path.join(dir, 'p.onnx'), 'bytes')
    expect(modelOnDiskState(dir, plain, 'onnx')).toBe('current')
  })
})

describe('formatPrecision on the shipped catalog', () => {
  it('names the precision of the detectors the cluster runs', async () => {
    const { getStepDefinition } = await import('../registry/step-definitions.js')
    const models = getStepDefinition('object-detection').models
    const byId = (id: string) => {
      const found = models.find((m) => m.id === id)
      if (found === undefined) throw new Error(`catalog has no ${id}`)
      return found
    }
    expect(formatPrecision(byId('yolov9m-320-int8'), 'openvino')).toBe('int8')
    expect(formatPrecision(byId('yolov9m-320'), 'coreml')).toBe('fp16')
    expect(formatPrecision(byId('ssd-mobilenet-v2-coco-edgetpu'), 'tflite')).toBe('int8')
  })
})
