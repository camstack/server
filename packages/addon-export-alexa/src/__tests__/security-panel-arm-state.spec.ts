import type { AlarmArmMode } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  alarmArmModeForAlexa,
  alexaArmStateFor,
  burglaryAlarmFor,
  supportedArmStatesFor,
} from '../handlers/security-panel-arm-state.js'

const ALL: readonly AlarmArmMode[] = ['home', 'away', 'night', 'vacation', 'custom_bypass']

describe('alexaArmStateFor — the panel’s state in Alexa’s four words', () => {
  it('maps the settled states onto their own arm state', () => {
    expect(alexaArmStateFor('disarmed')).toBe('DISARMED')
    expect(alexaArmStateFor('armed_home')).toBe('ARMED_STAY')
    expect(alexaArmStateFor('armed_away')).toBe('ARMED_AWAY')
    expect(alexaArmStateFor('armed_night')).toBe('ARMED_NIGHT')
  })

  it('calls a vacation arm AWAY and a custom bypass STAY', () => {
    // Alexa has three arm states and the panel has five. Both readings are
    // TRUE and a fourth state is not on offer.
    expect(alexaArmStateFor('armed_vacation')).toBe('ARMED_AWAY')
    expect(alexaArmStateFor('armed_custom_bypass')).toBe('ARMED_STAY')
  })

  it('reports DISARMED while ARMING — the exit delay has not set the system', () => {
    // Same refusal as the HomeKit mapping: an operator told ARMED walks out on
    // a house that is not.
    expect(alexaArmStateFor('arming')).toBe('DISARMED')
  })

  it('reports DISARMED while DISARMING — the command is already given', () => {
    expect(alexaArmStateFor('disarming')).toBe('DISARMED')
  })

  it('keeps a PENDING panel ARMED — an entry delay is a break-in in progress', () => {
    // Without targetMode, AWAY is the floor. With it, the named mode wins.
    expect(alexaArmStateFor('pending')).toBe('ARMED_AWAY')
    expect(alexaArmStateFor('pending', 'night')).toBe('ARMED_NIGHT')
  })

  it('keeps a TRIGGERED panel ARMED too', () => {
    expect(alexaArmStateFor('triggered')).toBe('ARMED_AWAY')
    expect(alexaArmStateFor('triggered', 'home')).toBe('ARMED_STAY')
  })
})

describe('burglaryAlarmFor — the only place Alexa can say the siren is going', () => {
  it('raises the alarm exactly on `triggered`', () => {
    expect(burglaryAlarmFor('triggered')).toEqual({ value: 'ALARM' })
    for (const state of ['disarmed', 'armed_away', 'pending', 'arming'] as const) {
      expect(burglaryAlarmFor(state)).toEqual({ value: 'OK' })
    }
  })
})

describe('supportedArmStatesFor — what Alexa is allowed to ask for', () => {
  it('offers DISARMED plus one state per mode the panel accepts', () => {
    expect(supportedArmStatesFor(['home', 'away'])).toEqual([
      'ARMED_STAY',
      'ARMED_AWAY',
      'DISARMED',
    ])
  })

  it('collapses the two modes sharing an Alexa state without duplicating it', () => {
    expect(supportedArmStatesFor(['away', 'vacation'])).toEqual(['ARMED_AWAY', 'DISARMED'])
  })

  it('falls back to all three arms when the panel named no modes — empty is unknown', () => {
    expect(supportedArmStatesFor([])).toEqual([
      'ARMED_STAY',
      'ARMED_AWAY',
      'ARMED_NIGHT',
      'DISARMED',
    ])
  })
})

describe('alarmArmModeForAlexa — the mode the PANEL takes', () => {
  it('maps Alexa’s three arms onto the panel’s primary mode', () => {
    expect(alarmArmModeForAlexa('ARMED_STAY', ALL)).toBe('home')
    expect(alarmArmModeForAlexa('ARMED_AWAY', ALL)).toBe('away')
    expect(alarmArmModeForAlexa('ARMED_NIGHT', ALL)).toBe('night')
  })

  it('falls back to the second mode behind that state when the first is not offered', () => {
    expect(alarmArmModeForAlexa('ARMED_STAY', ['custom_bypass'])).toBe('custom_bypass')
    expect(alarmArmModeForAlexa('ARMED_AWAY', ['vacation'])).toBe('vacation')
  })

  it('refuses a state the panel accepts no mode for', () => {
    expect(alarmArmModeForAlexa('ARMED_NIGHT', ['away'])).toBeNull()
  })

  it('trusts the panel when it named no modes at all', () => {
    expect(alarmArmModeForAlexa('ARMED_NIGHT', [])).toBe('night')
  })

  it('returns null for DISARMED — that is the Disarm DIRECTIVE, not an arm', () => {
    expect(alarmArmModeForAlexa('DISARMED', ALL)).toBeNull()
  })
})
