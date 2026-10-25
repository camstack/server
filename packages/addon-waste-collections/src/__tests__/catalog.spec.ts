/**
 * Discriminating coverage: every vendored `source/*.py` (except `_…`) must
 * appear in `catalog.json`, and every catalog entry must name a real module.
 * Country → service tree must include Germany abfallnavi + Italy junker.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { buildCatalog, listVendorModules } from '../../scripts/gen-catalog.js'
import type { WasteCatalog } from '../../scripts/gen-catalog.js'

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const CATALOG_PATH = join(PKG_ROOT, 'src/catalog.json')

describe('waste catalog coverage', () => {
  it('catalog.json exists and matches every vendored source module', () => {
    expect(existsSync(CATALOG_PATH), 'src/catalog.json missing — run gen-catalog').toBe(true)
    const onDisk = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as WasteCatalog
    const vendor = listVendorModules()
    expect(vendor.length).toBeGreaterThan(100)
    expect(onDisk.entries.map((e) => e.module).sort()).toEqual([...vendor])

    const rebuilt = buildCatalog()
    expect(onDisk.sourceHash).toBe(rebuilt.sourceHash)
    expect(onDisk.entries.length).toBe(rebuilt.entries.length)
    expect(onDisk.services.length).toBe(rebuilt.services.length)
    expect(onDisk.countries.length).toBe(rebuilt.countries.length)
  })

  it('includes generic ICS and at least one non-European module', () => {
    const onDisk = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as WasteCatalog
    const modules = new Set(onDisk.entries.map((e) => e.module))
    expect(modules.has('ics')).toBe(true)
    expect(modules.has('static')).toBe(true)
    expect(onDisk.entries.some((e) => e.countries.includes('Australia'))).toBe(true)
  })

  it('exposes country → service with inferred fields (Germany ZEW / Italy)', () => {
    const onDisk = JSON.parse(readFileSync(CATALOG_PATH, 'utf8')) as WasteCatalog
    expect(onDisk.countries.some((c) => c.id === 'germany')).toBe(true)
    expect(onDisk.countries.some((c) => c.id === 'italy')).toBe(true)

    const zew = onDisk.services.find(
      (s) =>
        s.countryId === 'germany' &&
        s.module === 'abfallnavi_de' &&
        s.defaultArgs['service'] === 'zew2',
    )
    expect(zew).toBeTruthy()
    expect(zew!.fields.some((f) => f.key === 'ort' && f.required)).toBe(true)
    expect(zew!.fields.some((f) => f.key === 'service')).toBe(false)

    const italy = onDisk.services.filter((s) => s.countryId === 'italy')
    expect(italy.length).toBeGreaterThan(50)
    expect(italy.some((s) => s.module === 'junker_app')).toBe(true)
  })
})
