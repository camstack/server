import { Characteristic } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'
import { securityUpdatesFor } from './security-system.js'

const C = Characteristic.SecuritySystemCurrentState
const T = Characteristic.SecuritySystemTargetState

const status = (state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  state,
  availableModes: ['home', 'away', 'night'],
  requiresCode: false,
  lastChangedAt: 1,
  ...extra,
})

describe('securityUpdatesFor — a cap status becomes characteristic writes', () => {
  it('writes both characteristics for a settled arm, and remembers the mode', () => {
    const out = securityUpdatesFor(status('armed_away'), null)
    expect(out.updates).toEqual([
      { characteristic: Characteristic.SecuritySystemCurrentState, value: C.AWAY_ARM },
      { characteristic: Characteristic.SecuritySystemTargetState, value: T.AWAY_ARM },
    ])
    expect(out.memo).toBe('armed_away')
  })

  it('keeps the remembered mode through a transition that does not carry one', () => {
    // `triggered` says nothing about what the panel was armed to; the memo is
    // the only thing that does, and dropping it here would blank the target.
    const out = securityUpdatesFor(status('triggered'), 'armed_night')
    expect(out.memo).toBe('armed_night')
    expect(out.updates).toEqual([
      { characteristic: Characteristic.SecuritySystemCurrentState, value: C.ALARM_TRIGGERED },
      { characteristic: Characteristic.SecuritySystemTargetState, value: T.NIGHT_ARM },
    ])
  })

  it('FORGETS the mode once the panel is disarmed', () => {
    // A memo that outlives the disarm makes the next `arming` claim a target
    // the operator never asked for.
    expect(securityUpdatesFor(status('disarmed'), 'armed_away').memo).toBeNull()
  })

  it('omits the target characteristic entirely when there is nothing true to write', () => {
    // `null` from `securityStateFor` means DO NOT WRITE — never a fallback to
    // DISARM, which would tell iOS somebody disarmed a sounding alarm.
    const out = securityUpdatesFor(status('triggered'), null)
    expect(out.updates).toEqual([
      { characteristic: Characteristic.SecuritySystemCurrentState, value: C.ALARM_TRIGGERED },
    ])
  })

  it('yields NO updates and keeps the memo when the payload is not a panel status', () => {
    // The cap's own schema is the only source of truth about the shape. A
    // payload that fails it must not move a characteristic, and must not
    // destroy what we knew either.
    expect(securityUpdatesFor({ state: 'nonsense' }, 'armed_home')).toEqual({
      updates: [],
      memo: 'armed_home',
      panel: null,
    })
    expect(securityUpdatesFor(null, 'armed_home').updates).toEqual([])
  })

  it('reports the panel’s own facts, and `null` when it could not be read', () => {
    // The `onSet` handler translates against these. A default of "no modes,
    // no PIN" on an unreadable status would arm a panel that asked for a code.
    expect(securityUpdatesFor(status('disarmed', { requiresCode: true }), null).panel).toEqual({
      availableModes: ['home', 'away', 'night'],
      requiresCode: true,
    })
    expect(securityUpdatesFor({ state: 'nonsense' }, null).panel).toBeNull()
  })

  it('reads a status that carries only the fields it needs', () => {
    // `.pick()` discipline: a provider omitting the clock must not silence the
    // panel.
    const out = securityUpdatesFor(
      { state: 'armed_home', availableModes: [], requiresCode: false },
      null,
    )
    expect(out.updates[0]).toEqual({
      characteristic: Characteristic.SecuritySystemCurrentState,
      value: C.STAY_ARM,
    })
  })

  it('PENDING uses status.targetMode when the in-process memo is empty', () => {
    // Missed the settled armed_night slice — without targetMode, HomeKit used
    // to show DISARMED during an entry delay.
    const out = securityUpdatesFor(status('pending', { targetMode: 'night' }), null)
    expect(out.memo).toBe('armed_night')
    expect(out.updates).toEqual([
      { characteristic: Characteristic.SecuritySystemCurrentState, value: C.NIGHT_ARM },
      { characteristic: Characteristic.SecuritySystemTargetState, value: T.NIGHT_ARM },
    ])
  })
})
