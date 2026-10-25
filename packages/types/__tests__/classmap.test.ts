import { describe, it, expect } from 'vitest'
import { COCO_TO_MACRO, COCO_80_LABELS, MACRO_LABELS } from '../src/catalogs/coco-classmap.js'

describe('MACRO_LABELS', () => {
  it('includes the package macro (model-agnostic drop-detector class)', () => {
    expect(MACRO_LABELS.some((l) => l.id === 'package')).toBe(true)
  })

  it('carries person/vehicle/animal/package', () => {
    expect(MACRO_LABELS.map((l) => l.id)).toEqual(['person', 'vehicle', 'animal', 'package'])
  })
})

describe('COCO_TO_MACRO', () => {
  it('maps person to person', () => {
    expect(COCO_TO_MACRO.mapping['person']).toBe('person')
  })

  it('maps car to vehicle', () => {
    expect(COCO_TO_MACRO.mapping['car']).toBe('vehicle')
  })

  it('maps bird to animal', () => {
    expect(COCO_TO_MACRO.mapping['bird']).toBe('animal')
  })

  it('maps bicycle to vehicle', () => {
    expect(COCO_TO_MACRO.mapping['bicycle']).toBe('vehicle')
  })

  it('maps dog to animal', () => {
    expect(COCO_TO_MACRO.mapping['dog']).toBe('animal')
  })

  // Interim package vector (model-agnostic goal): the dedicated parcel
  // model emits `className: 'package'` natively; until it ships these
  // COCO luggage proxies stand in so the package-drop detector can be
  // exercised end-to-end. See package-zones-design §3.2 / §4.
  it('maps suitcase/backpack/handbag to package (interim vector)', () => {
    expect(COCO_TO_MACRO.mapping['suitcase']).toBe('package')
    expect(COCO_TO_MACRO.mapping['backpack']).toBe('package')
    expect(COCO_TO_MACRO.mapping['handbag']).toBe('package')
  })

  it('has preserveOriginal=false so the executor drops unmapped classes', () => {
    // The pipeline today only supports the 3 macro classes (person,
    // vehicle, animal). Any other COCO class (carrot, umbrella, spoon, …)
    // must be dropped upstream in `PipelineExecutor` (see the
    // `!preserveOriginal ? continue` branch in `executor.ts`) instead
    // of leaking through as a `macroClass: "carrot"` detection with
    // no child routing and no per-macro threshold applied. Flipping
    // this back to `true` must be accompanied by new handling in
    // `macroFilterVerdict`, otherwise it's a regression.
    expect(COCO_TO_MACRO.preserveOriginal).toBe(false)
  })

  it('does NOT map non-target COCO classes like carrot/umbrella/spoon', () => {
    // These used to leak through before the preserveOriginal=false flip.
    expect(COCO_TO_MACRO.mapping['carrot']).toBeUndefined()
    expect(COCO_TO_MACRO.mapping['umbrella']).toBeUndefined()
    expect(COCO_TO_MACRO.mapping['spoon']).toBeUndefined()
    expect(COCO_TO_MACRO.mapping['banana']).toBeUndefined()
    expect(COCO_TO_MACRO.mapping['potted plant']).toBeUndefined()
  })

  it('all mapped keys exist in COCO_80_LABELS', () => {
    const cocoIds = new Set(COCO_80_LABELS.map((l) => l.id))
    for (const key of Object.keys(COCO_TO_MACRO.mapping)) {
      expect(cocoIds.has(key), `Key "${key}" not found in COCO_80_LABELS`).toBe(true)
    }
  })

  it('only maps to valid macro categories', () => {
    const validMacros = new Set(['person', 'vehicle', 'animal', 'package'])
    for (const value of Object.values(COCO_TO_MACRO.mapping)) {
      expect(validMacros.has(value), `Value "${value}" is not a valid macro category`).toBe(true)
    }
  })
})

describe('COCO_80_LABELS', () => {
  it('has exactly 80 labels', () => {
    expect(COCO_80_LABELS.length).toBe(80)
  })

  it('all labels have an id and name', () => {
    for (const label of COCO_80_LABELS) {
      expect(label.id).toBeTruthy()
      expect(label.name).toBeTruthy()
    }
  })

  it('first label is person', () => {
    expect(COCO_80_LABELS[0]?.id).toBe('person')
  })

  it('last label is toothbrush', () => {
    expect(COCO_80_LABELS[79]?.id).toBe('toothbrush')
  })
})
