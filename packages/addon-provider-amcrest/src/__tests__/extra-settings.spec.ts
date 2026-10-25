import { describe, it, expect } from 'vitest'
import {
  AMCREST_EXTRAS_CONFIG_NAMES,
  buildExtrasSections,
  extrasPatchToCgiParams,
  parseExtrasSnapshot,
} from '../extra-settings.js'

/** A verbatim slice of what the live IP4M-1041B returns for the four
 *  extras config tables (multi-name getConfig, 2026-09-04). */
function liveTable(): Map<string, string> {
  return new Map<string, string>([
    ['Lighting[0][0].Mode', 'Auto'],
    ['Lighting[0][0].MiddleLight[0].Light', '50'],
    ['Lighting[0][0].Sensitive', '3'],
    ['LightGlobal[0].Enable', 'true'],
    ['NTP.Enable', 'false'],
    ['NTP.Address', 'time.nist.gov'],
    ['NTP.Port', '123'],
    ['NTP.UpdatePeriod', '10'],
    ['NTP.TimeZone', '26'],
    ['AutoMaintain.AutoRebootEnable', 'false'],
    ['AutoMaintain.AutoRebootDay', '5'],
    ['AutoMaintain.AutoRebootHour', '2'],
    ['AutoMaintain.AutoRebootMinute', '30'],
  ])
}

describe('parseExtrasSnapshot', () => {
  it('projects the four live config tables into the snapshot', () => {
    const snap = parseExtrasSnapshot(liveTable(), 1_000)
    expect(snap).toEqual({
      irLightMode: 'Auto',
      irLightBrightness: 50,
      statusLedEnabled: true,
      ntpEnabled: false,
      ntpServer: 'time.nist.gov',
      ntpPort: 123,
      ntpUpdatePeriodMin: 10,
      ntpTimeZoneIndex: 26,
      autoRebootEnabled: false,
      autoRebootDay: 5,
      autoRebootHour: 2,
      autoRebootMinute: 30,
      fetchedAt: 1_000,
    })
  })

  it('leaves fields absent when the camera omits them — unknown never fabricates', () => {
    const snap = parseExtrasSnapshot(new Map([['NTP.Enable', 'true']]), 5)
    expect(snap.ntpEnabled).toBe(true)
    expect(snap.irLightMode).toBeUndefined()
    expect(snap.statusLedEnabled).toBeUndefined()
    expect(snap.autoRebootDay).toBeUndefined()
  })

  it('normalizes an unexpected stored IR mode token to undefined (field is unvalidated on-camera)', () => {
    const t = liveTable()
    t.set('Lighting[0][0].Mode', 'TotallyBogusMode')
    expect(parseExtrasSnapshot(t, 1).irLightMode).toBeUndefined()
  })
})

describe('buildExtrasSections', () => {
  it('renders nothing before the first successful camera read — not-yet-known must not look like known', () => {
    expect(buildExtrasSections(undefined)).toEqual([])
  })

  it('renders the ir-lights / time-ntp / auto-reboot sections from a snapshot', () => {
    const sections = buildExtrasSections(parseExtrasSnapshot(liveTable(), 1))
    const ids = sections.map((s) => s.id)
    expect(ids).toEqual(['ir-lights', 'time-ntp', 'auto-reboot'])
    // Uniform taxonomy with the Reolink driver.
    expect(sections.find((s) => s.id === 'ir-lights')?.tab).toBe('image')
    expect(sections.find((s) => s.id === 'time-ntp')?.tab).toBe('network')
    expect(sections.find((s) => s.id === 'auto-reboot')?.tab).toBe('advanced')
  })

  it('seeds defaults from the snapshot values', () => {
    const sections = buildExtrasSections(parseExtrasSnapshot(liveTable(), 1))
    const fieldDefault = (sectionId: string, key: string): unknown => {
      const field = sections
        .find((s) => s.id === sectionId)
        ?.fields.find((f) => 'key' in f && f.key === key)
      return field !== undefined && 'default' in field ? field.default : undefined
    }
    expect(fieldDefault('ir-lights', 'irLightMode')).toBe('Auto')
    expect(fieldDefault('time-ntp', 'ntpServer')).toBe('time.nist.gov')
    expect(fieldDefault('time-ntp', 'ntpTimeZoneIndex')).toBe(26)
  })
})

describe('extrasPatchToCgiParams', () => {
  it('maps every settings key onto its verified Dahua config path', () => {
    const { params, handled } = extrasPatchToCgiParams({
      irLightMode: 'Manual',
      irLightBrightness: 80,
      statusLedEnabled: false,
      ntpEnabled: true,
      ntpServer: 'pool.ntp.org',
      ntpPort: 123,
      ntpUpdatePeriodMin: 30,
      ntpTimeZoneIndex: 5,
      autoRebootEnabled: true,
      autoRebootDay: 7,
      autoRebootHour: 3,
      autoRebootMinute: 15,
    })
    expect(params).toEqual({
      'Lighting[0][0].Mode': 'Manual',
      'Lighting[0][0].MiddleLight[0].Light': 80,
      'LightGlobal[0].Enable': 'false',
      'NTP.Enable': 'true',
      'NTP.Address': 'pool.ntp.org',
      'NTP.Port': 123,
      'NTP.UpdatePeriod': 30,
      'NTP.TimeZone': 5,
      'AutoMaintain.AutoRebootEnable': 'true',
      'AutoMaintain.AutoRebootDay': 7,
      'AutoMaintain.AutoRebootHour': 3,
      'AutoMaintain.AutoRebootMinute': 15,
    })
    expect([...handled].toSorted()).toEqual(
      [
        'irLightMode',
        'irLightBrightness',
        'statusLedEnabled',
        'ntpEnabled',
        'ntpServer',
        'ntpPort',
        'ntpUpdatePeriodMin',
        'ntpTimeZoneIndex',
        'autoRebootEnabled',
        'autoRebootDay',
        'autoRebootHour',
        'autoRebootMinute',
      ].toSorted(),
    )
  })

  it('ignores keys that are not extras (they belong to the config store)', () => {
    const { params, handled } = extrasPatchToCgiParams({
      host: '10.0.0.2',
      password: 'x',
    })
    expect(Object.keys(params)).toHaveLength(0)
    expect(handled).toHaveLength(0)
  })

  it('refuses an IR mode outside the verified enum — the firmware stores ANY string, so the provider must be the validator', () => {
    const { params } = extrasPatchToCgiParams({ irLightMode: 'ZoomPrio' })
    expect(params['Lighting[0][0].Mode']).toBeUndefined()
  })

  it('clamps numeric fields to their verified writable windows', () => {
    const { params } = extrasPatchToCgiParams({
      irLightBrightness: 999, // firmware stores 999 verbatim — clamp to 100
      ntpTimeZoneIndex: 60, // firmware rejects >33 with HTTP 400
      autoRebootDay: 9, // firmware rejects 8+
      autoRebootHour: 99,
      autoRebootMinute: -3,
      ntpPort: 0,
    })
    expect(params['Lighting[0][0].MiddleLight[0].Light']).toBe(100)
    expect(params['NTP.TimeZone']).toBe(33)
    expect(params['AutoMaintain.AutoRebootDay']).toBe(7)
    expect(params['AutoMaintain.AutoRebootHour']).toBe(23)
    expect(params['AutoMaintain.AutoRebootMinute']).toBe(0)
    expect(params['NTP.Port']).toBe(1)
  })

  it('drops wrongly-typed values instead of writing garbage', () => {
    const { params } = extrasPatchToCgiParams({
      irLightBrightness: 'high',
      ntpEnabled: 'yes',
      ntpServer: 42,
    })
    expect(Object.keys(params)).toHaveLength(0)
  })
})

describe('AMCREST_EXTRAS_CONFIG_NAMES', () => {
  it('lists exactly the four tables the snapshot reads', () => {
    expect([...AMCREST_EXTRAS_CONFIG_NAMES]).toEqual([
      'Lighting',
      'LightGlobal',
      'NTP',
      'AutoMaintain',
    ])
  })
})
