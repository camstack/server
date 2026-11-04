/**
 * The device form flattens field keys across exporters AND skills: a key that belongs to one
 * skill must carry its id, or two skills would share a switch.
 */
import { describe, expect, it } from 'vitest'
import { deviceSettingKey, isDeviceSettingKeyOf } from '../device-keys.js'

describe('per-skill device keys', () => {
  it('differs per skill and per device', () => {
    const a = deviceSettingKey('export-alexa', 7, 'enabled')
    const b = deviceSettingKey('alexa-skill-2', 7, 'enabled')
    expect(a).not.toBe(b)
    expect(deviceSettingKey('export-alexa', 8, 'enabled')).not.toBe(a)
  })

  it('is recognised by its own skill and device only', () => {
    const key = deviceSettingKey('alexa-skill-2', 7, 'streamPreference')
    expect(isDeviceSettingKeyOf(key, 'alexa-skill-2', 7)).toBe(true)
    expect(isDeviceSettingKeyOf(key, 'export-alexa', 7)).toBe(false)
    expect(isDeviceSettingKeyOf(key, 'alexa-skill-2', 8)).toBe(false)
    expect(isDeviceSettingKeyOf('google:alexa-skill-2:7:enabled', 'alexa-skill-2', 7)).toBe(false)
  })
})
