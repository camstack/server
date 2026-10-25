import { describe, it, expect } from 'vitest'
import {
  NC_ALARM_SYSTEM_EVENT_KINDS,
  NcAlarmSettingsSchema,
  NcAlarmSettingsPatchSchema,
  NcAlarmSensorsInputSchema,
  NC_ALARM_SENSORS_MAX,
  NC_CONDITION_CATALOG,
} from '../notification-rules.cap.js'
import { EVENT_KIND_BY_CAP, EVENTFUL_CAP_NAMES } from '../sensor-event-kinds.js'

describe('alarm kinds', () => {
  it('lists every alarm kind in lifecycle order', () => {
    expect(NC_ALARM_SYSTEM_EVENT_KINDS).toEqual([
      'alarm-arm-refused',
      'alarm-check-failed',
      'alarm-arming',
      'alarm-armed',
      'alarm-pending',
      'alarm-triggered',
      'alarm-rearmed',
      'alarm-sensor-bypass',
      'alarm-disarmed',
    ])
  })

  it('offers every alarm kind in the systemEvent condition catalog', () => {
    const d = NC_CONDITION_CATALOG.find((c) => c.id === 'systemEvent')
    const values = new Set((d?.options ?? []).map((o) => o.value))
    for (const k of NC_ALARM_SYSTEM_EVENT_KINDS) expect(values.has(k)).toBe(true)
  })
})

describe('NcAlarmSettingsSchema', () => {
  it('parses a pre-D630 blob (announceArm, no nonBlocking)', () => {
    const s = NcAlarmSettingsSchema.parse({
      exitDelaySec: 30,
      entryDelaySec: 20,
      triggeredDurationSec: 0,
      announceArm: false,
      announceTargets: [],
    })
    expect(s.nonBlocking).toEqual([])
  })
})

describe('NcAlarmSettingsPatchSchema', () => {
  // A patch that does not name `nonBlocking` must not carry one: a default
  // materialised here would wipe every mode's list on an unrelated edit.
  it('leaves nonBlocking absent when the patch does not name it', () => {
    expect(NcAlarmSettingsPatchSchema.parse({ entryDelaySec: 10 }).nonBlocking).toBeUndefined()
  })

  it('carries nonBlocking when the patch names it', () => {
    const lists = [{ mode: 'home' as const, deviceIds: [4131] }]
    expect(NcAlarmSettingsPatchSchema.parse({ nonBlocking: lists }).nonBlocking).toEqual(lists)
  })

  it('refuses two lists for one mode, in a patch and in settings', () => {
    const twice = [
      { mode: 'home' as const, deviceIds: [1] },
      { mode: 'home' as const, deviceIds: [2] },
    ]
    expect(NcAlarmSettingsPatchSchema.safeParse({ nonBlocking: twice }).success).toBe(false)
    expect(
      NcAlarmSettingsSchema.safeParse({
        exitDelaySec: 0,
        entryDelaySec: 0,
        triggeredDurationSec: 0,
        announceTargets: [],
        nonBlocking: twice,
      }).success,
    ).toBe(false)
  })
})

describe('a cover is eventful', () => {
  it('maps the cover cap to the cover kind', () => {
    expect(EVENT_KIND_BY_CAP['cover']?.kind).toBe('cover')
    expect(EVENTFUL_CAP_NAMES).toContain('cover')
  })
})

const STORED_BEFORE_D697 = {
  exitDelaySec: 30,
  entryDelaySec: 20,
  triggeredDurationSec: 0,
  announceTargets: [],
  nonBlocking: [{ mode: 'away', deviceIds: [7] }],
}

describe('NcAlarmSettingsSchema — per-mode delays (D697)', () => {
  it('parses a blob stored before D697 as "every mode inherits"', () => {
    expect(NcAlarmSettingsSchema.parse(STORED_BEFORE_D697).modeDelays).toEqual([])
  })
  it('accepts a partial override and refuses two entries for one mode', () => {
    const ok = { ...STORED_BEFORE_D697, modeDelays: [{ mode: 'home', exitDelaySec: 0 }] }
    expect(NcAlarmSettingsSchema.parse(ok).modeDelays).toEqual([{ mode: 'home', exitDelaySec: 0 }])
    const twice = {
      ...STORED_BEFORE_D697,
      modeDelays: [
        { mode: 'home', exitDelaySec: 0 },
        { mode: 'home', entryDelaySec: 5 },
      ],
    }
    expect(NcAlarmSettingsSchema.safeParse(twice).success).toBe(false)
  })
  it('bounds an override like the global field', () => {
    const tooLong = {
      ...STORED_BEFORE_D697,
      modeDelays: [{ mode: 'away', triggeredDurationSec: 3601 }],
    }
    expect(NcAlarmSettingsSchema.safeParse(tooLong).success).toBe(false)
  })
})

describe('NcAlarmSettingsPatchSchema — no default ever wipes a list', () => {
  it('a delay-only patch carries neither nonBlocking nor modeDelays', () => {
    const parsed = NcAlarmSettingsPatchSchema.parse({ exitDelaySec: 10 })
    expect('nonBlocking' in parsed).toBe(false)
    expect('modeDelays' in parsed).toBe(false)
    expect('nonBlockingEdit' in parsed).toBe(false)
  })
  it('accepts null as "inherit again" in a mode edit', () => {
    const parsed = NcAlarmSettingsPatchSchema.parse({
      modeDelays: [{ mode: 'away', exitDelaySec: null }],
    })
    expect(parsed.modeDelays).toEqual([{ mode: 'away', exitDelaySec: null }])
  })
  it('refuses the whole lists and one edit together', () => {
    const both = {
      nonBlocking: [],
      nonBlockingEdit: { mode: 'away', deviceId: 7, nonBlocking: true },
    }
    expect(NcAlarmSettingsPatchSchema.safeParse(both).success).toBe(false)
  })
  it('refuses a non-positive device id in a membership edit', () => {
    const zero = { nonBlockingEdit: { mode: 'away', deviceId: 0, nonBlocking: true } }
    expect(NcAlarmSettingsPatchSchema.safeParse(zero).success).toBe(false)
  })
})

describe('NcAlarmSensorsInputSchema', () => {
  it('bounds the ids', () => {
    const ids = Array.from({ length: NC_ALARM_SENSORS_MAX + 1 }, (_, i) => i + 1)
    expect(NcAlarmSensorsInputSchema.safeParse({ deviceIds: ids }).success).toBe(false)
  })
})
