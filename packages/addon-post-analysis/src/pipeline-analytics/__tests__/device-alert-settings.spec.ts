/**
 * THREE cluster settings, and deliberately no fourth.
 *
 * The operator's D-2 and D-4: the battery threshold, the re-notify interval and
 * the recovery switch are one value each for the whole installation — not
 * fields of a rule, and not a second settings home. They live beside the
 * addon's other cluster-wide behavioural settings
 * (`pipeline-analytics/settings-schema.ts`), which is the one place this addon
 * already keeps knobs of exactly this shape.
 *
 * The hysteresis is NOT here. It is a constant in `alerts/battery-band.ts`,
 * because a fourth knob whose only job is to stop the first one misbehaving is
 * a knob nobody can size.
 */
import { describe, expect, it } from 'vitest'
import { DEVICE_ALERT_DEFAULTS, DeviceAlertSettingsSchema } from '../device-alert-settings.js'

describe('the defaults are the ones an untouched install runs on', () => {
  it('parses an empty object into every shipped default', () => {
    expect(DeviceAlertSettingsSchema.parse({})).toEqual({
      batteryLowPercent: 20,
      alertRenotifyMinutes: 720,
      alertNotifyRecovery: true,
    })
  })

  it('carries no consumable threshold — that is each RULE’s since D642', () => {
    expect(
      Object.keys(DeviceAlertSettingsSchema.parse({ consumableLowPercent: 30 })),
    ).not.toContain('consumableLowPercent')
  })

  it('defaults the recovery ON — the operator asked for default true', () => {
    expect(DEVICE_ALERT_DEFAULTS.alertNotifyRecovery).toBe(true)
  })

  it('ships the conventional 20% band, which is also what HomeKit uses', () => {
    // `addon-export-hap/src/mappers/builders/battery.ts` carries
    // LOW_BATTERY_THRESHOLD_PCT = 20 for the HomeKit characteristic. Agreeing
    // by default means the phone and the hub do not contradict each other out
    // of the box; the operator may still diverge, and that is their choice.
    expect(DEVICE_ALERT_DEFAULTS.batteryLowPercent).toBe(20)
  })
})

describe('the reminder interval is bounded at both ends', () => {
  it('accepts 0 — "say it once and never again"', () => {
    expect(DeviceAlertSettingsSchema.parse({ alertRenotifyMinutes: 0 }).alertRenotifyMinutes).toBe(
      0,
    )
  })

  it('refuses an interval under 15 minutes — that is a flood, not a reminder', () => {
    expect(() => DeviceAlertSettingsSchema.parse({ alertRenotifyMinutes: 5 })).toThrow()
  })

  it('refuses an interval over a week — past that it is off, and 0 says so', () => {
    expect(() => DeviceAlertSettingsSchema.parse({ alertRenotifyMinutes: 8 * 24 * 60 })).toThrow()
  })

  it('accepts the bounds themselves', () => {
    expect(DeviceAlertSettingsSchema.parse({ alertRenotifyMinutes: 15 })).toBeTruthy()
    expect(DeviceAlertSettingsSchema.parse({ alertRenotifyMinutes: 7 * 24 * 60 })).toBeTruthy()
  })
})

describe('the threshold is bounded to a band that can actually fire', () => {
  it('refuses 0 — nothing measures below it, so the rule could never fire', () => {
    expect(() => DeviceAlertSettingsSchema.parse({ batteryLowPercent: 0 })).toThrow()
  })

  it('refuses 100 — every healthy device would be low forever', () => {
    expect(() => DeviceAlertSettingsSchema.parse({ batteryLowPercent: 100 })).toThrow()
  })

  it('accepts the threshold the operator can actually reach on this fleet', () => {
    // 3602 "Termostato frigorifero" reads 23%; 30 catches it, 10 does not.
    expect(DeviceAlertSettingsSchema.parse({ batteryLowPercent: 30 }).batteryLowPercent).toBe(30)
    expect(DeviceAlertSettingsSchema.parse({ batteryLowPercent: 10 }).batteryLowPercent).toBe(10)
  })

  it('refuses a fractional percentage — a battery band is not a measurement', () => {
    expect(() => DeviceAlertSettingsSchema.parse({ batteryLowPercent: 20.5 })).toThrow()
  })
})
