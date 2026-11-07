import { type Composition, DeviceType, runningOptOutFeature } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  followSwitchRowListed,
  isFollowSwitchRow,
  readFollowSwitch,
  saveFollowSwitch,
} from '../follow-switch'

const PLUG = { addonId: 'provider-mqtt-ha', stableId: 'plug-1' }

function heater(extra: Composition['features'] = []): Composition {
  return {
    target: { kind: 'new', type: DeviceType.Heater },
    features: [
      {
        kind: 'fields',
        cap: 'switch',
        fields: {
          on: { kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'on' },
          lastChangedAt: {
            kind: 'from',
            source: PLUG,
            cap: 'switch',
            fieldPath: 'lastChangedAt',
          },
        },
        commands: {
          setState: {
            kind: 'forward',
            source: PLUG,
            cap: 'switch',
            method: 'setState',
          },
        },
      },
      ...extra,
    ],
  }
}

const AUTHORED: Composition['features'] = [
  {
    kind: 'fields',
    cap: 'running-state',
    fields: {
      running: { kind: 'from', source: PLUG, cap: 'switch', fieldPath: 'on' },
    },
  },
]

describe('the follow-the-switch toggle', () => {
  it('is only the running row', () => {
    expect(isFollowSwitchRow('running-state', 'running')).toBe(true)
    expect(isFollowSwitchRow('power-meter', 'power')).toBe(false)
  })

  it('follows by default when nothing is stored for running', () => {
    expect(readFollowSwitch(heater())).toEqual({
      offered: true,
      following: true,
      discardsRule: false,
    })
  })

  it('is not offered without a composition or without an actuator switch', () => {
    expect(readFollowSwitch(null)).toEqual({ offered: false })
    expect(readFollowSwitch({ target: heater().target, features: [] })).toEqual({ offered: false })
  })

  it('is off, and warns before it discards, when the operator wrote a rule', () => {
    expect(readFollowSwitch(heater(AUTHORED))).toEqual({
      offered: true,
      following: false,
      discardsRule: true,
    })
  })

  it('is off without a warning for the stored opt-out', () => {
    const optOut = heater([runningOptOutFeature()])
    expect(readFollowSwitch(optOut)).toEqual({
      offered: true,
      following: false,
      discardsRule: false,
    })
  })

  it('OFF stores the opt-out and ON removes whatever is stored', () => {
    const off = saveFollowSwitch(heater(), false)
    expect(off?.features.map((f) => f.cap)).toEqual(['switch', 'running-state'])
    expect(off === null ? null : readFollowSwitch(off)).toMatchObject({
      following: false,
    })
    const on = saveFollowSwitch(heater(AUTHORED), true)
    expect(on?.features.map((f) => f.cap)).toEqual(['switch'])
  })

  it('does not offer the toggle for a supply switch (an appliance on a plug)', () => {
    const supply = heater([
      {
        kind: 'fields',
        cap: 'power-source',
        fields: {
          switchOn: {
            kind: 'from',
            source: PLUG,
            cap: 'switch',
            fieldPath: 'on',
          },
        },
      },
    ])
    expect(readFollowSwitch(supply)).toEqual({ offered: false })
  })

  it('lists the running row with nothing stored, and keeps it listed after the opt-out', () => {
    expect(followSwitchRowListed('running-state', 'running', heater())).toBe(true)
    expect(
      followSwitchRowListed('running-state', 'running', heater([runningOptOutFeature()])),
    ).toBe(true)
    expect(followSwitchRowListed('running-state', 'running', null)).toBe(false)
    expect(followSwitchRowListed('power-meter', 'power', heater())).toBe(false)
  })
})
