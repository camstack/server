/**
 * The two catalogs Model Studio itself writes — the pinned plugin catalog YOLOv9
 * manifest and the plus catalog public catalog — are CamStack's offer, not the
 * operator's upload, so every entry declares its licence (D661).
 */
import { describe, expect, it } from 'vitest'
import {
  buildPlusCatalogCatalogDescriptor,
  PLUS_CATALOG_PUBLIC_CATALOG,
} from '../plus-catalog/plus-catalog-catalog.js'
import { PLUGIN_CATALOG_YOLO_MANIFEST } from '../plugin-catalog/plugin-catalog-yolo-manifest.js'

describe('Model Studio catalogs declare their licence', () => {
  it.each(
    PLUGIN_CATALOG_YOLO_MANIFEST.map((e) => [e.id, e.model] as const),
  )('plugin catalog %s: GPL-3.0 architecture, weights terms stated, third-party', (_id, m) => {
    expect(m.license?.weights).toBeTruthy()
    expect(m.license?.code).toBe('GPL-3.0')
    expect(m.license?.upstream?.url).toMatch(/^https:\/\//)
    expect(m.license?.url).toMatch(/^https:\/\//)
    expect(m.license?.hosting).toBe('third-party')
  })

  it.each(
    PLUS_CATALOG_PUBLIC_CATALOG.map((c) => [c.id] as const),
  )('plus catalog %s: the registered descriptor carries the licence', (id) => {
    const { entry } = buildPlusCatalogCatalogDescriptor(id)
    expect(entry.license?.weights).toBe('Apache-2.0')
    expect(entry.license?.hosting).toBe('third-party')
    expect(entry.license?.upstream?.url).toMatch(/^https:\/\//)
  })
})
