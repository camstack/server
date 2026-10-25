/**
 * The tape switch (D681, decision 9) is modelled on `keepSourceFrames` (D644):
 * a boolean per camera, OFF by default, and it IS the setting — no second
 * store says which cameras record (D62). Every tracking field is overridable
 * per camera, so the per-camera form is derived from the same section.
 *
 * Disarm: make the resolver return `TRACKING_DEFAULTS.trackingTape` without
 * reading `raw` — the per-camera test must fail.
 */
import { describe, expect, it } from 'vitest'
import { buildDetectionSettingsSections } from '../settings-schema-sections.js'
import { resolveTrackingSettings, TRACKING_DEFAULTS } from '../tracking-settings.js'

describe('trackingTape switch', () => {
  it('is off by default', () => {
    expect(TRACKING_DEFAULTS.trackingTape).toBe(false)
    expect(resolveTrackingSettings({}).trackingTape).toBe(false)
  })

  it('reads a camera that turned it on', () => {
    expect(resolveTrackingSettings({ trackingTape: true }).trackingTape).toBe(true)
  })

  it('falls back to off on a malformed value', () => {
    expect(resolveTrackingSettings({ trackingTape: 'yes' }).trackingTape).toBe(false)
  })

  it('is offered in the Tracking section, with its retention in the label', () => {
    const tracking = buildDetectionSettingsSections().find((s) => s.id === 'tracking')
    const field = tracking?.fields.find((f) => 'key' in f && f.key === 'trackingTape')
    expect(field).toMatchObject({ type: 'boolean', key: 'trackingTape', default: false })
    expect(JSON.stringify(field)).toContain('1 day')
  })
})
