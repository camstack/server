import { describe, it, expect } from 'vitest'
import { TrackingSettingsSchema } from '../tracking-settings.js'
import { buildDetectionSettingsSections } from '../settings-schema-sections.js'

/**
 * A tracking knob the operator cannot reach is a knob that silently does
 * nothing.
 *
 * `zoneMembershipMinOverlap` shipped on 2026-07-31 with no field in this form.
 * With no surface to set it from, it was written straight into
 * `addon-device-settings` through `addonSettingsRaw.updateDevice` — a DIFFERENT
 * sqlite table from the `<addonId>:addon-devices` collection a forked addon
 * reads. The API reported 0.1, the running pipeline read 0, and a night of
 * "the bar is applied, now collect the data" rested on a value that was never
 * in effect. Writing the guard immediately surfaced a second one
 * (`rescueCentroidFactor`, retired with the rest of the old tracker by D683).
 *
 * So: every field of {@link TrackingSettingsSchema} needs a field in the
 * detection settings form. The two legacy frame-count budgets
 * (`maxMissedFrames`, `occlusionMaxMissedFrames`) that used to be exempted
 * here are gone from the schema outright (D683) — there is no exemption list
 * left to maintain.
 */
describe('tracking settings — form coverage', () => {
  it('exposes every tracking knob in the detection settings form', () => {
    const formKeys = new Set(
      buildDetectionSettingsSections().flatMap((section) => section.fields.map((f) => f.key)),
    )
    const missing = Object.keys(TrackingSettingsSchema.shape).filter((key) => !formKeys.has(key))
    expect(missing).toEqual([])
  })
})
