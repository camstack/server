/**
 * Every detection-pipeline catalog entry declares its licence as a structured
 * record (D661). The generated licence surfaces (admin page, THIRD_PARTY_MODELS.md,
 * the HF model table) are built from these records, so an entry without one is
 * a model the product ships without saying on what terms.
 */
import type { ModelCatalogEntry } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import * as catalogs from '../registry/model-catalogs.js'

function isEntryArray(value: unknown): value is readonly ModelCatalogEntry[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'object' && v !== null && 'id' in v && 'formats' in v)
  )
}

const ENTRIES: readonly ModelCatalogEntry[] = Object.values(catalogs).filter(isEntryArray).flat()

describe('every detection-pipeline catalog entry declares its licence', () => {
  it('found the catalogs (sanity: not an empty walk)', () => {
    expect(ENTRIES.length).toBeGreaterThan(60)
  })

  it.each(
    ENTRIES.map((e) => [e.id, e] as const),
  )('%s has weights, upstream, url, hosting', (_id, e) => {
    expect(e.license?.weights).toBeTruthy()
    expect(e.license?.upstream?.url).toMatch(/^https:\/\//)
    expect(e.license?.url).toMatch(/^https:\/\//)
    expect(e.license?.hosting).toBeDefined()
  })

  it('every Ultralytics-derived entry is AGPL-3.0', () => {
    const ultra = ENTRIES.filter((e) => /^yolo(26|v9|v8)/.test(e.id) && !e.id.endsWith('-edgetpu'))
    expect(ultra.length).toBeGreaterThan(40)
    for (const e of ultra) expect(e.license?.weights, e.id).toBe('AGPL-3.0')
  })

  it('the Coral YOLOv9-s builds are GPL-3.0 (WongKinYiu-derived, not Ultralytics)', () => {
    const coral = ENTRIES.filter((e) => /^yolov9.*-edgetpu$/.test(e.id))
    expect(coral.map((e) => e.id)).toEqual(['yolov9s-320-edgetpu', 'yolov9s-512-edgetpu'])
    for (const e of coral) expect(e.license?.weights, e.id).toBe('GPL-3.0')
  })

  it('the non-commercial entries say so', () => {
    for (const id of ['vehicle-type-v1']) {
      expect(ENTRIES.find((e) => e.id === id)?.license?.nonCommercial, id).toBe(true)
    }
  })

  it('a precision / resolution variant states what CamStack changed', () => {
    const int8 = ENTRIES.find((e) => e.id === 'yolo26n-int8')
    expect(int8?.license?.modifications).toContain('INT8')
    const reduced = ENTRIES.find((e) => e.id === 'yolov9t-320')
    expect(reduced?.license?.modifications).toContain('320')
  })
})
