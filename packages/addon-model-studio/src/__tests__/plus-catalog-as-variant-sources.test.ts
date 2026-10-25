/**
 * plus catalog account models → family cards with every runnable format per
 * (architecture, size, resolution), against the real `/v1/model/list` sample.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildModelVariantGroups } from '@camstack/types'
import {
  plusFacets,
  toPlusModelSummaries,
  type PlusModelSummary,
} from '../plus-catalog/plus-catalog-api.js'
import {
  buildPlusCatalog,
  plusTrainingOffers,
  runnablePlusModels,
} from '../plus-catalog/plus-catalog-as-variant-sources.js'

const FIXTURE = fileURLToPath(new URL('./testdata/plus-catalog-model-list.json', import.meta.url))
const ALL: readonly PlusModelSummary[] = toPlusModelSummaries(
  JSON.parse(readFileSync(FIXTURE, 'utf8')),
)

function narrowed(kind: 'base' | 'custom', release: string): readonly PlusModelSummary[] {
  return plusFacets(runnablePlusModels(ALL), { kind, release }).entries
}

function model(
  over: Partial<PlusModelSummary> & Pick<PlusModelSummary, 'id' | 'name'>,
): PlusModelSummary {
  return {
    type: 'yolo-generic',
    isBaseModel: true,
    baseModel: '2026.1',
    supportedDetectors: ['onnx', 'openvino'],
    trainDate: '2026-04-15T00:00:00.000Z',
    verifiedImages: 0,
    width: 320,
    height: 320,
    ...over,
  }
}

describe('buildPlusCatalog — base 2026.1 (the operator’s release)', () => {
  const view = buildPlusCatalog(narrowed('base', '2026.1'))
  const formatsOf = (sourceId: string) =>
    view.combos.get(sourceId)?.trainings[0]?.offers.map((o) => o.format)

  it('shows every family at once — YOLO-NAS, YOLOv9 AND MobileDet, no runtime filter', () => {
    const families = buildModelVariantGroups(view.sources)
      .map((f) => f.family)
      .toSorted()
    expect(families).toEqual(['mobiledet', 'yolonas', 'yolov9'])
  })

  it('YOLOv9 Small 320 offers the EdgeTPU TFLite next to ONNX / OpenVINO / CoreML', () => {
    expect(formatsOf('yolov9s-320')).toEqual(['onnx', 'openvino', 'coreml', 'tflite'])
    const tflite = view.combos
      .get('yolov9s-320')
      ?.trainings[0]?.offers.find((o) => o.format === 'tflite')
    expect(tflite).toEqual({
      format: 'tflite',
      plusModelId: 'be9c11b4',
      via: 'download',
      needsCoral: true,
    })
    const onnx = view.combos
      .get('yolov9s-320')
      ?.trainings[0]?.offers.find((o) => o.format === 'onnx')
    expect(onnx?.plusModelId).toBe('c1354d18')
  })

  it('a combination with no EdgeTPU build offers no TFLite', () => {
    expect(formatsOf('yolov9s-640')).toEqual(['onnx', 'openvino', 'coreml'])
    expect(formatsOf('yolov9t-640')).toEqual(['onnx', 'openvino', 'coreml'])
    expect(formatsOf('yolonas-320')).toEqual(['onnx', 'openvino', 'coreml'])
  })

  it('MobileDet offers ONLY the EdgeTPU TFLite — the CPU tflite build is not offered', () => {
    expect(formatsOf('mobiledet-320')).toEqual(['tflite'])
    const builds = view.combos.get('mobiledet-320')?.trainings[0]?.builds.map((m) => m.id)
    expect(builds).toEqual(['e39924321'])
  })

  it('OpenVINO / CoreML are conversions of the neural build; ONNX and TFLite are downloads', () => {
    const offers = view.combos.get('yolov9s-320')?.trainings[0]?.offers ?? []
    expect(offers.filter((o) => o.via === 'convert').map((o) => o.format)).toEqual([
      'openvino',
      'coreml',
    ])
    expect(offers.filter((o) => o.via === 'download').map((o) => o.format)).toEqual([
      'onnx',
      'tflite',
    ])
  })

  it('size and resolution chips come from the axes; the source formats mirror the offers', () => {
    const yolov9 = view.sources.filter((s) => s.group?.family === 'yolov9')
    expect(yolov9.map((s) => `${s.group?.tier}@${s.group?.resolution}`).toSorted()).toEqual([
      's@320',
      's@640',
      't@640',
    ])
    const s320 = view.sources.find((s) => s.id === 'yolov9s-320')
    expect(Object.keys(s320?.formats ?? {})).toEqual(['onnx', 'openvino', 'coreml', 'tflite'])
  })
})

describe('buildPlusCatalog — what never reaches a card', () => {
  it('a Hailo-only or CPU-only combination yields no chip at all', () => {
    const view = buildPlusCatalog([
      model({
        id: 'h',
        name: 'yolov9t',
        supportedDetectors: ['hailo8l'],
        width: 640,
        height: 640,
      }),
      model({ id: 'c', name: 'yolov9s', supportedDetectors: ['cpu'] }),
      model({
        id: 'r',
        name: 'yolov9s',
        supportedDetectors: ['rknn'],
        width: 640,
        height: 640,
      }),
    ])
    expect(view.sources).toEqual([])
    expect(view.combos.size).toBe(0)
  })

  it('a release whose only YOLOv9 Small 320 is CPU still shows it from the neural build', () => {
    const view = buildPlusCatalog([
      model({ id: 'n', name: 'yolov9s' }),
      model({ id: 'c', name: 'yolov9s', supportedDetectors: ['cpu'] }),
    ])
    expect(view.combos.get('yolov9s-320')?.trainings[0]?.offers.map((o) => o.format)).toEqual([
      'onnx',
      'openvino',
      'coreml',
    ])
  })
})

describe('buildPlusCatalog — custom trainings stay separate', () => {
  it('two trainings of one combination are two trainings, newest first', () => {
    const view = buildPlusCatalog(narrowed('custom', '2025.3'))
    const t640 = view.combos.get('yolov9t-640')
    expect(t640?.trainings.map((t) => t.key)).toEqual(['2025-12-23', '2025-12-12'])
    expect(t640?.trainings.map((t) => t.builds[0]?.id)).toEqual(['8f647747', 'a7485f3d'])
  })

  it('a custom MobileDet release offers its EdgeTPU build and hides the CPU sibling', () => {
    const view = buildPlusCatalog(narrowed('custom', '2025.1'))
    expect(
      view.combos.get('mobiledet-320')?.trainings[0]?.offers.map((o) => o.plusModelId),
    ).toEqual(['73e1b2b2'])
    expect(view.combos.get('yolonas-320')?.trainings[0]?.offers.map((o) => o.format)).toEqual([
      'onnx',
      'openvino',
      'coreml',
    ])
  })

  it('base and custom never mix — the kind narrows before the cards are built', () => {
    const custom = buildPlusCatalog(narrowed('custom', '2025.3'))
    for (const combo of custom.combos.values()) {
      for (const t of combo.trainings) {
        expect(t.builds.every((m) => !m.isBaseModel)).toBe(true)
      }
    }
  })
})

describe('plusTrainingOffers', () => {
  it('an EdgeTPU-only training offers only TFLite', () => {
    expect(
      plusTrainingOffers([model({ id: 'e', name: 'yolov9s', supportedDetectors: ['edgetpu'] })]),
    ).toEqual([{ format: 'tflite', plusModelId: 'e', via: 'download', needsCoral: true }])
  })

  it('nothing runnable ⇒ no offers', () => {
    expect(
      plusTrainingOffers([model({ id: 'c', name: 'mobiledet', supportedDetectors: ['cpu'] })]),
    ).toEqual([])
  })
})
