/**
 * Waste source custom-action catalog + no editable-array settings.
 */
import { describe, expect, it } from 'vitest'
import { wasteCollectionsActions } from '../custom-actions.js'
import { WasteCollectionsAddon } from '../waste-collections.addon.js'
import { findCatalogService, serviceDisplayLabel, serviceFormSchema } from '../waste-catalog.js'

describe('wasteCollectionsActions catalog', () => {
  it('keeps only the fetch action and the two lists that feed the instance form', () => {
    expect(Object.keys(wasteCollectionsActions).sort()).toEqual(
      ['fetchNow', 'listCountries', 'listServices'].sort(),
    )
  })
})

describe('WasteCollectionsAddon globalSettingsSchema', () => {
  it('has no editable-array providers/sources field', () => {
    const addon = new WasteCollectionsAddon()
    const schema = (
      addon as unknown as {
        globalSettingsSchema: () => {
          sections: { fields: { type: string; key?: string }[] }[]
        }
      }
    ).globalSettingsSchema()
    const fields = schema.sections.flatMap((s) => s.fields)
    expect(fields.some((f) => f.type === 'editable-array')).toBe(false)
    expect(fields.some((f) => f.key === 'fetchHour')).toBe(false)
  })
})

describe('serviceFormSchema', () => {
  it('builds ConfigUISchema without module/argsJson free-text', () => {
    const zew = findCatalogService('abfallnavi_de--zew2')
    expect(zew).toBeTruthy()
    const schema = serviceFormSchema(zew!)
    const keys = schema.sections.flatMap((s) => s.fields.map((f) => ('key' in f ? f.key : '')))
    expect(keys).toContain('label')
    expect(keys).toContain('ort')
    expect(keys).not.toContain('module')
    expect(keys).not.toContain('argsJson')
    expect(keys).not.toContain('service')
  })

  it('appends the service code in parentheses for AbfallNavi ZEW', () => {
    const zew = findCatalogService('abfallnavi_de--zew2')
    expect(zew).toBeTruthy()
    expect(serviceDisplayLabel(zew!)).toMatch(/\(zew2\)$/)
  })
})
