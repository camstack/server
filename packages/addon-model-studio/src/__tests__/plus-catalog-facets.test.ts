/**
 * D214 addendum — the account catalog's REAL discriminants, against a faithful
 * sample of an actual `/v1/model/list` response (25 entries, every shape the
 * API produces; camera keys anonymized, nothing else touched).
 *
 * Cascade: kind → release → architecture → weight → dimensions. Which engine
 * can run a build (`plusImportLane`) is NOT a selector level: the catalog
 * shows every runnable build at once.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  detectorSupport,
  parseModelName,
  plusFacets,
  plusImportLane,
  toPlusModelSummaries,
  verifiedImageCount,
  type PlusModelSummary,
} from '../plus-catalog/plus-catalog-api.js'

const FIXTURE = fileURLToPath(new URL('./testdata/plus-catalog-model-list.json', import.meta.url))
const raw: unknown = JSON.parse(readFileSync(FIXTURE, 'utf8'))
const ALL: readonly PlusModelSummary[] = toPlusModelSummaries(raw)

describe('the real /v1/model/list sample', () => {
  it('parses every entry, tolerating all three verifiedCounts shapes', () => {
    expect(ALL).toHaveLength(25)
    expect(ALL.every((m) => typeof m.verifiedImages === 'number')).toBe(true)
    const legacy = ALL.find((m) => m.id === 'cac19630')
    expect(legacy?.verifiedImages).toBe(199)
    const perCamera = ALL.find((m) => m.id === 'bb607740')
    expect(perCamera?.verifiedImages).toBe(21 + 21 + 21 + 33 + 33 + 33)
    const base = ALL.find((m) => m.isBaseModel)
    expect(base?.verifiedImages).toBe(0)
  })

  it('verifiedImageCount handles the three shapes directly', () => {
    expect(verifiedImageCount(-1)).toBe(0)
    expect(verifiedImageCount({ '11': 199 })).toBe(199)
    expect(verifiedImageCount({ yard: { person: 2, deer: 3 } })).toBe(5)
    expect(verifiedImageCount(undefined)).toBe(0)
    expect(verifiedImageCount('garbage')).toBe(0)
  })
})

describe('parseModelName — architecture + weight (our own t/s/m vocabulary)', () => {
  it('splits yolov9t / yolov9s into architecture + weight', () => {
    expect(parseModelName('yolov9t')).toEqual({
      architecture: 'yolov9',
      weight: 't',
      weightLabel: 'Tiny',
    })
    expect(parseModelName('yolov9s')).toEqual({
      architecture: 'yolov9',
      weight: 's',
      weightLabel: 'Small',
    })
  })

  it('leaves weightless architectures whole', () => {
    expect(parseModelName('yolonas')).toEqual({
      architecture: 'yolonas',
      weight: '',
      weightLabel: '',
    })
    expect(parseModelName('mobiledet')).toEqual({
      architecture: 'mobiledet',
      weight: '',
      weightLabel: '',
    })
  })
})

describe('detectorSupport — what our cluster can actually load', () => {
  it('classifies the detectors the data really carries', () => {
    expect(detectorSupport('onnx').kind).toBe('supported')
    expect(detectorSupport('openvino').kind).toBe('supported')
    expect(detectorSupport('edgetpu').kind).toBe('coral-only')
    for (const foreign of ['cpu', 'hailo8l', 'rknn', 'rocm', 'zmq']) {
      const verdict = detectorSupport(foreign)
      expect(verdict.kind).toBe('unsupported')
      expect(verdict.reason.length).toBeGreaterThan(0)
    }
  })
})

describe('plusImportLane — which CamStack engine can run a build', () => {
  const lane = (id: string) => {
    const m = ALL.find((x) => x.id === id)
    if (m === undefined) throw new Error(`fixture has no ${id}`)
    return plusImportLane(m)
  }

  it('onnx∩openvino builds are neural (one ONNX artifact)', () => {
    expect(lane('c1354d18')).toBe('neural')
    expect(lane('ed95518d')).toBe('neural')
  })

  it('EdgeTPU builds are coral, for MobileDet AND for YOLOv9', () => {
    expect(lane('e39924321')).toBe('coral')
    expect(lane('be9c11b4')).toBe('coral')
  })

  it('a CPU tflite build has no engine here — even a MobileDet whose type is ssd', () => {
    expect(lane('2a357116')).toBeNull()
    expect(lane('3e5616c1')).toBeNull()
  })

  it('Hailo builds have no engine here', () => {
    expect(lane('f3352dbe')).toBeNull()
  })

  it('a ROCm/RKNN/ZMQ-only build has no engine here', () => {
    expect(plusImportLane({ type: 'yolo-generic', supportedDetectors: ['rocm'] })).toBeNull()
    expect(
      plusImportLane({
        type: 'yolo-generic',
        supportedDetectors: ['rknn', 'zmq'],
      }),
    ).toBeNull()
  })

  it('only a row with NO detector list falls back to its type', () => {
    expect(plusImportLane({ type: 'ssd', supportedDetectors: [] })).toBe('coral')
    expect(plusImportLane({ type: 'yolonas', supportedDetectors: [] })).toBe('neural')
  })
})

describe('plusFacets — cascading levels over the real data', () => {
  it('level 2 offers RELEASES, never architectures', () => {
    const f = plusFacets(ALL, { kind: 'base' })
    expect(f.release.map((o) => o.value)).toEqual(['2026.1', '2026.0', '2025.3', '2025.2'])
    expect(f.release.every((o) => /^\d{4}\.\d+$/.test(o.value))).toBe(true)
  })

  it('kind counts match the sample (15 base / 10 custom)', () => {
    const f = plusFacets(ALL, {})
    expect(f.kind).toEqual([
      { value: 'custom', label: 'My trainings', count: 10 },
      { value: 'base', label: 'Official base', count: 15 },
    ])
  })

  it('architecture → weight → dimensions cascade: yolov9 exposes its weights, yolonas none', () => {
    const y9 = plusFacets(ALL, {
      kind: 'base',
      release: '2026.1',
      architecture: 'yolov9',
    })
    expect(y9.weight.map((o) => o.value).toSorted()).toEqual(['s', 't'])
    expect(y9.weight.find((o) => o.value === 't')?.label).toBe('Tiny')

    const nas = plusFacets(ALL, {
      kind: 'base',
      release: '2026.1',
      architecture: 'yolonas',
    })
    expect(nas.weight).toEqual([])
    expect(nas.dimensions.map((o) => o.value)).toEqual(['320x320', '640x640'])
  })

  it('an IMPOSSIBLE combination is unreachable — it yields no entries and no downstream offers', () => {
    const f = plusFacets(ALL, {
      kind: 'base',
      release: '2026.1',
      detector: 'edgetpu',
      architecture: 'yolonas',
    })
    expect(f.entries).toEqual([])
    expect(f.dimensions).toEqual([])
    const offered = plusFacets(ALL, {
      kind: 'base',
      release: '2026.1',
      detector: 'edgetpu',
    })
    expect(offered.architecture.map((o) => o.value)).not.toContain('yolonas')
  })

  it('a full selection resolves the concrete trainings, newest first', () => {
    const f = plusFacets(ALL, {
      kind: 'custom',
      release: '2025.3',
      architecture: 'yolov9',
      weight: 't',
      dimensions: '640x640',
    })
    expect(f.entries.map((m) => m.id)).toEqual(['8f647747', 'a7485f3d'])
  })

  it('a detector selection filters on the detector list', () => {
    const f = plusFacets(ALL, {
      kind: 'base',
      release: '2026.1',
      detector: 'edgetpu',
    })
    expect(f.entries.length).toBeGreaterThan(0)
    expect(f.entries.every((m) => m.supportedDetectors.includes('edgetpu'))).toBe(true)
  })
})
