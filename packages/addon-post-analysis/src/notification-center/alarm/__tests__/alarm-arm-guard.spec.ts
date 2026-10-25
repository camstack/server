/**
 * ARMING WITH A DOOR OPEN — the refusal, and the explicit Arm anyway that
 * follows it (D630).
 *
 * Every test here is about one of the two ways this feature can be worse than
 * not having it:
 *
 *  - a refusal the operator cannot get past (an alarm that cannot be armed
 *    because a sensor is broken is an alarm that is off), and
 *  - an Arm anyway that excludes more than the operator was shown — a device
 *    that opened AFTER the refusal is refused again, never silently excluded.
 */

import { describe, expect, it } from 'vitest'
import { alarmCoveredDevices, decideArm, type NcAlarmArmGatingRule } from '../alarm-arm-guard.js'

const PANEL = 1023

function rule(input: {
  enabled?: boolean
  gate?: { deviceId: number; states: readonly string[] }
  devices?: readonly number[]
  exclude?: readonly number[]
}): NcAlarmArmGatingRule {
  return {
    enabled: input.enabled ?? true,
    conditions: {
      ...(input.gate !== undefined
        ? { deviceState: { deviceId: input.gate.deviceId, states: [...input.gate.states] } }
        : {}),
      ...(input.devices !== undefined ? { devices: [...input.devices] } : {}),
      ...(input.exclude !== undefined ? { devicesExclude: [...input.exclude] } : {}),
    },
  }
}

const CONTACTS = [3243, 3272] as const

describe('alarmCoveredDevices — a rule that excludes devices (D641)', () => {
  it('a named rule covers its list MINUS its own exclusions', () => {
    const rules = [
      rule({
        gate: { deviceId: PANEL, states: ['armed_away'] },
        devices: [...CONTACTS],
        exclude: [3272],
      }),
    ]
    expect(alarmCoveredDevices(rules, PANEL, 'away')).toEqual([3243])
  })

  it('an unscoped rule that only excludes still contributes nothing', () => {
    const rules = [rule({ gate: { deviceId: PANEL, states: ['armed_away'] }, exclude: [3272] })]
    expect(alarmCoveredDevices(rules, PANEL, 'away')).toEqual([])
  })
})

describe('alarmCoveredDevices — D630', () => {
  it('covers every device an armed_<mode> rule names, whatever its kind', () => {
    // No `sensorKinds`: a window, a cover, a lock or a garage door is covered
    // because the mode's rule names it, not because it is a contact.
    const rules = [
      rule({ gate: { deviceId: PANEL, states: ['armed_away'] }, devices: [102, 3243, 4001] }),
    ]
    expect(alarmCoveredDevices(rules, PANEL, 'away')).toEqual([102, 3243, 4001])
    expect(alarmCoveredDevices(rules, PANEL, 'home')).toEqual([])
  })

  it('ignores a rule gated on a different PANEL', () => {
    const rules = [rule({ gate: { deviceId: 7, states: ['armed_home'] }, devices: [...CONTACTS] })]
    expect(alarmCoveredDevices(rules, PANEL, 'home')).toEqual([])
  })

  it('a DISABLED rule contributes nothing', () => {
    const rules = [
      rule({
        enabled: false,
        gate: { deviceId: PANEL, states: ['armed_away'] },
        devices: [102, 3243],
      }),
    ]
    expect(alarmCoveredDevices(rules, PANEL, 'away')).toEqual([])
  })

  it('an UNSCOPED rule contributes nothing', () => {
    // A rule with no device scope covers every device on the hub; a refusal
    // naming devices the operator never wrote down is one they cannot act on.
    const rules = [rule({ gate: { deviceId: PANEL, states: ['armed_away'] } })]
    expect(alarmCoveredDevices(rules, PANEL, 'away')).toEqual([])
    const empty = [rule({ gate: { deviceId: PANEL, states: ['armed_away'] }, devices: [] })]
    expect(alarmCoveredDevices(empty, PANEL, 'away')).toEqual([])
  })

  it('de-duplicates and sorts across rules', () => {
    const rules = [
      rule({ gate: { deviceId: PANEL, states: ['armed_home'] }, devices: [3272, 3243] }),
      rule({
        gate: { deviceId: PANEL, states: ['armed_home', 'armed_night'] },
        devices: [3243, 3260],
      }),
    ]
    expect(alarmCoveredDevices(rules, PANEL, 'home')).toEqual([3243, 3260, 3272])
  })
})

describe('decideArm — D630', () => {
  const porch = { deviceId: 3243, name: 'Porch', state: 'open', controllable: false }
  const garage = { deviceId: 4001, name: 'Garage', state: 'stopped', controllable: false }
  const shutter = {
    deviceId: 5001,
    name: 'Shutter',
    state: 'open',
    controllable: true,
    cap: 'cover' as const,
  }

  it('arms clean when nothing is open', () => {
    expect(decideArm({ mode: 'away', open: [], nonBlocking: [] })).toEqual({
      kind: 'arm',
      excluded: [],
    })
  })

  it('refuses on an open covered device', () => {
    expect(decideArm({ mode: 'away', open: [porch], nonBlocking: [] })).toEqual({
      kind: 'refused',
      blocking: [porch],
    })
  })

  it('a non-blocking device arms, excluded', () => {
    expect(decideArm({ mode: 'away', open: [porch], nonBlocking: [3243] })).toEqual({
      kind: 'arm',
      excluded: [porch],
    })
  })

  it('Arm anyway excludes exactly what was acknowledged', () => {
    expect(
      decideArm({ mode: 'away', open: [porch], nonBlocking: [], acknowledged: [3243] }),
    ).toEqual({ kind: 'arm', excluded: [porch] })
  })

  it('Arm anyway refuses again when something ELSE opened since the refusal', () => {
    expect(
      decideArm({ mode: 'away', open: [porch, garage], nonBlocking: [], acknowledged: [3243] }),
    ).toEqual({ kind: 'refused', blocking: [garage] })
  })

  it('a plain press repeated is still refused (no second-press bypass)', () => {
    const first = decideArm({ mode: 'away', open: [porch], nonBlocking: [] })
    const second = decideArm({ mode: 'away', open: [porch], nonBlocking: [] })
    expect(second).toEqual(first)
    expect(second.kind).toBe('refused')
  })

  it('a controllable open device does NOT block by default', () => {
    expect(decideArm({ mode: 'away', open: [shutter], nonBlocking: [] })).toEqual({
      kind: 'arm',
      excluded: [shutter],
    })
  })

  it('a controllable on the blocking list refuses', () => {
    expect(decideArm({ mode: 'away', open: [shutter], nonBlocking: [], blocking: [5001] })).toEqual(
      { kind: 'refused', blocking: [shutter] },
    )
  })
})
