/**
 * `trackingTape` is per-camera only (D681, final review L3): it arms
 * continuous track-history recording on the camera it is set on
 * (43–72 MB/day). `buildDetectionSettingsSections()` is the ONE shared base
 * both the global settings page and the per-device contribution build from
 * (`index.ts`'s `globalSettingsSchema()`), so a field declared there reaches
 * both surfaces unless something strips it for one of them — exactly the
 * problem `GLOBAL_ONLY_FIELDS` / `stripGlobalOnlyFields` already solve in the
 * opposite direction (a field that must show on the global page only, never
 * per-device).
 *
 * `stripDeviceOnlyFields` is the mirror: it drops `trackingTape` from the
 * sections `getGlobalSettings` hands to the GLOBAL page, so one global click
 * can never arm every camera on the cluster. `getDeviceSettingsContribution`
 * never calls it, so the per-device form keeps the field.
 *
 * Disarm: return the sections unfiltered from `stripDeviceOnlyFields` — "the
 * global form lacks trackingTape" fails.
 */
import { describe, expect, it } from 'vitest'
import { buildDetectionSettingsSections } from '../settings-schema-sections.js'
import { stripDeviceOnlyFields } from '../settings-schema.js'

function fieldKeys(sections: ReturnType<typeof buildDetectionSettingsSections>): readonly string[] {
  return sections
    .flatMap((s) => s.fields.map((f) => f.key))
    .filter((k): k is string => k !== undefined)
}

describe('trackingTape — per-camera only (D681, final review L3)', () => {
  it('the raw sections (what the per-device form builds from) still have it', () => {
    expect(fieldKeys(buildDetectionSettingsSections())).toContain('trackingTape')
  })

  it('stripDeviceOnlyFields removes it — what the global settings page renders', () => {
    const stripped = stripDeviceOnlyFields(buildDetectionSettingsSections())
    expect(fieldKeys(stripped)).not.toContain('trackingTape')
  })

  it('touches only the tracking section — every other field and section survives untouched', () => {
    const before = buildDetectionSettingsSections()
    const after = stripDeviceOnlyFields(before)
    expect(after.map((s) => s.id)).toEqual(before.map((s) => s.id))
    for (const section of after) {
      if (section.id === 'tracking') continue
      const original = before.find((s) => s.id === section.id)
      expect(section.fields.map((f) => f.key)).toEqual(original?.fields.map((f) => f.key))
    }
    // The tracking section itself loses exactly one field.
    const trackingBefore = before.find((s) => s.id === 'tracking')
    const trackingAfter = after.find((s) => s.id === 'tracking')
    expect(trackingBefore?.fields.length).toBe((trackingAfter?.fields.length ?? 0) + 1)
  })

  it('does not mutate the input sections', () => {
    const before = buildDetectionSettingsSections()
    const trackingSection = before.find((s) => s.id === 'tracking')
    const originalFieldCount = trackingSection?.fields.length
    stripDeviceOnlyFields(before)
    expect(trackingSection?.fields.length).toBe(originalFieldCount)
  })
})
