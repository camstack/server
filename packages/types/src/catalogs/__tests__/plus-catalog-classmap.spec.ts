/**
 * A plus catalog import used to carry no classMap, inherit `COCO_TO_MACRO` and lose
 * every label COCO does not name (deer, raccoon, school_bus, package, …).
 */
import { describe, expect, it } from 'vitest'
import {
  buildPlusCatalogClassMap,
  PLUS_CATALOG_TO_MACRO,
  PLUS_CATALOG_UNMAPPED_LABELS,
} from '../plus-catalog-classmap.js'
import { DetectionCatalogClassMapSchema } from '../../types/labels.js'

describe('buildPlusCatalogClassMap', () => {
  const plusLabels = ['person', 'deer', 'raccoon', 'school_bus', 'package', 'face', 'amazon']

  it('maps a plus catalog-only animal onto the animal macro', () => {
    expect(buildPlusCatalogClassMap(plusLabels).mapping.deer).toBe('animal')
    expect(buildPlusCatalogClassMap(plusLabels).mapping.raccoon).toBe('animal')
  })

  it('maps package to package and school_bus to vehicle', () => {
    const map = buildPlusCatalogClassMap(plusLabels)
    expect(map.mapping.package).toBe('package')
    expect(map.mapping.school_bus).toBe('vehicle')
  })

  it('leaves attribute labels out so they never spawn a second track', () => {
    const map = buildPlusCatalogClassMap(plusLabels)
    expect(map.mapping.face).toBeUndefined()
    expect(map.mapping.amazon).toBeUndefined()
    expect(map.preserveOriginal).toBe(false)
  })

  it('falls back to COCO for a plus catalog COCO-91 labelmap', () => {
    const map = buildPlusCatalogClassMap(['truck', 'sheep', 'suitcase', 'carrot'])
    expect(map.mapping).toEqual({ truck: 'vehicle', sheep: 'animal', suitcase: 'package' })
  })

  it('only carries the labels the model actually has, and passes the wire schema', () => {
    const map = buildPlusCatalogClassMap(['dog'])
    expect(map.mapping).toEqual({ dog: 'animal' })
    expect(DetectionCatalogClassMapSchema.parse(map)).toEqual(map)
  })

  it('never lists one label as both mapped and unmapped', () => {
    for (const label of Object.keys(PLUS_CATALOG_UNMAPPED_LABELS)) {
      expect(PLUS_CATALOG_TO_MACRO[label]).toBeUndefined()
    }
  })
})
