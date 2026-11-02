/**
 * The Google settings page holds no hub URL: it is the `publicEndpoint` role of the
 * Network page (D986 §5), so nothing here can show or edit one.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '@camstack/types'
import { ExportGoogleAddon } from '../export-google.addon.js'

function schema(): ConfigUISchema {
  const addon = new ExportGoogleAddon()
  const read = (addon as unknown as { globalSettingsSchema: () => ConfigUISchema })
    .globalSettingsSchema
  return read.call(addon)
}

describe('Google settings page', () => {
  it('stores no URL: no field, no button', () => {
    const fields = schema().sections.flatMap((s) => s.fields)
    const keys = fields.flatMap((f) => ('key' in f ? [f.key] : []))
    expect(keys.filter((k) => /url/i.test(k))).toEqual([])
    expect(fields.filter((f) => f.type === 'addon-action-button' || f.type === 'text')).toEqual([])
  })

  it('the connection settings sit in a section named Connection', () => {
    expect(schema().sections.map((s) => s.title)).toEqual(['Connection'])
  })
})
