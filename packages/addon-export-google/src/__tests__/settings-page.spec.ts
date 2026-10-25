/**
 * The exporter page pattern on the Google export: the address detection is an
 * admin-only `addon-action-button` that says what it did.
 */
import { describe, expect, it } from 'vitest'
import type { ConfigUISchema } from '@camstack/types'
import { exportGoogleActions } from '../custom-actions.js'
import { ExportGoogleAddon } from '../export-google.addon.js'
import { describeDetectResult } from '../public-hub-url.js'

function schema(): ConfigUISchema {
  const addon = new ExportGoogleAddon()
  const read = (addon as unknown as { globalSettingsSchema: () => ConfigUISchema })
    .globalSettingsSchema
  return read.call(addon)
}

describe('Google settings page', () => {
  it('every action is admin-only', () => {
    for (const [name, spec] of Object.entries(exportGoogleActions)) {
      expect({ name, auth: spec.auth }).toEqual({ name, auth: 'admin' })
    }
  })

  it('detection is an addon-action-button that reports its outcome', () => {
    const fields = schema().sections.flatMap((s) => s.fields)
    expect(fields.filter((f) => f.type === 'button')).toEqual([])
    const detect = fields.find((f) => 'key' in f && f.key === '__detect-public-hub-url')
    expect(detect?.type).toBe('addon-action-button')
    if (detect?.type !== 'addon-action-button') return
    expect(detect.action).toBe('detectPublicHubUrl')
    expect(detect.successMessage).toBe('{summary}')
  })

  it('the connection settings sit in a section named Connection', () => {
    expect(schema().sections.map((s) => s.title)).toEqual(['Connection'])
  })
})

describe('describeDetectResult', () => {
  it('says it filled the empty field', () => {
    expect(
      describeDetectResult({
        publicHubUrl: 'https://a',
        detectedPublicHubUrl: 'https://a',
        filled: true,
      }),
    ).toBe('Filled in https://a.')
  })

  it('says the value you set was kept, and names what was detected', () => {
    expect(
      describeDetectResult({
        publicHubUrl: 'https://mine',
        detectedPublicHubUrl: 'https://a',
        filled: false,
      }),
    ).toBe('Detected https://a; your value https://mine was kept.')
  })

  it('says when nothing was detected', () => {
    expect(
      describeDetectResult({ publicHubUrl: '', detectedPublicHubUrl: '', filled: false }),
    ).toBe('No public HTTPS address detected. Set up remote access first.')
  })
})
