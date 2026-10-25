import { Characteristic } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'
import { alarmArmModeFor, securityStateFor } from './security-state.js'

const C = Characteristic.SecuritySystemCurrentState
const T = Characteristic.SecuritySystemTargetState

describe('securityStateFor — the panel’s state as HomeKit models it', () => {
  it('maps the three settled arm modes onto their own pair', () => {
    expect(securityStateFor('armed_home', null)).toEqual({
      current: C.STAY_ARM,
      target: T.STAY_ARM,
    })
    expect(securityStateFor('armed_away', null)).toEqual({
      current: C.AWAY_ARM,
      target: T.AWAY_ARM,
    })
    expect(securityStateFor('armed_night', null)).toEqual({
      current: C.NIGHT_ARM,
      target: T.NIGHT_ARM,
    })
    expect(securityStateFor('disarmed', null)).toEqual({ current: C.DISARMED, target: T.DISARM })
  })

  it('calls a vacation arm AWAY — the closest true statement HomeKit can make', () => {
    // HomeKit has three arm modes and the panel has five. Vacation is an away
    // arm with the house empty for longer; reporting it as AWAY is true, and
    // inventing a fourth mode is not available.
    expect(securityStateFor('armed_vacation', null)).toEqual({
      current: C.AWAY_ARM,
      target: T.AWAY_ARM,
    })
  })

  it('calls a custom bypass STAY — armed with something deliberately excluded', () => {
    expect(securityStateFor('armed_custom_bypass', null)).toEqual({
      current: C.STAY_ARM,
      target: T.STAY_ARM,
    })
  })

  it('a TRIGGERED panel says so, and keeps the target it was armed to', () => {
    // The target must not fall back to DISARM: iOS would render the system as
    // being disarmed by somebody while the siren is sounding.
    expect(securityStateFor('triggered', 'armed_away')).toEqual({
      current: C.ALARM_TRIGGERED,
      target: T.AWAY_ARM,
    })
  })

  it('a triggered panel with no remembered mode leaves the target ALONE', () => {
    // `null` means "do not write this characteristic". Guessing AWAY here would
    // tell iOS the operator asked for away-arm, which nobody did.
    expect(securityStateFor('triggered', null)).toEqual({
      current: C.ALARM_TRIGGERED,
      target: null,
    })
  })

  it('while ARMING, the panel is not yet armed — current stays DISARMED', () => {
    // The lock builder's rule, applied here: claiming ARMED while the exit
    // delay runs is how an operator walks out on a system that is not set.
    expect(securityStateFor('arming', 'armed_away')).toEqual({
      current: C.DISARMED,
      target: T.AWAY_ARM,
    })
    expect(securityStateFor('arming', null)).toEqual({ current: C.DISARMED, target: null })
  })

  it('while DISARMING, it is still armed and the target is DISARM', () => {
    expect(securityStateFor('disarming', 'armed_home')).toEqual({
      current: C.STAY_ARM,
      target: T.DISARM,
    })
  })

  it('PENDING is an entry delay: still armed, still meant to be armed', () => {
    // Entry delay — somebody opened the door and the panel is counting down
    // before it triggers. Reporting DISARMED here would hide a break-in.
    expect(securityStateFor('pending', 'armed_night')).toEqual({
      current: C.NIGHT_ARM,
      target: T.NIGHT_ARM,
    })
  })

  it('PENDING with no memory stays ARMED (AWAY) — never DISARMED', () => {
    // Hiding an entry delay as DISARMED was how HomeKit missed a night-arm
    // break-in when the accessory never saw the settled armed_* slice.
    expect(securityStateFor('pending', null)).toEqual({
      current: C.AWAY_ARM,
      target: T.AWAY_ARM,
    })
  })
})

describe('alarmArmModeFor — what HomeKit asked the panel to do', () => {
  it('maps each HomeKit target onto the cap’s arm mode', () => {
    expect(alarmArmModeFor(T.STAY_ARM)).toBe('home')
    expect(alarmArmModeFor(T.AWAY_ARM)).toBe('away')
    expect(alarmArmModeFor(T.NIGHT_ARM)).toBe('night')
  })

  it('DISARM is not an arm mode — it is null, and the caller disarms', () => {
    expect(alarmArmModeFor(T.DISARM)).toBeNull()
  })

  it('refuses a value outside the four HomeKit targets', () => {
    expect(alarmArmModeFor(99)).toBeNull()
  })
})
