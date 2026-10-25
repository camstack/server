import { describe, it, expect } from 'vitest'
import type { ClimateControlStatus, CoverStatus } from '@camstack/types'
import {
  decodeClimate,
  decodeCover,
  decodeLock,
  fromHmControlMode,
  levelToPercent,
  toHmClimateMode,
} from '../homematic-decode.js'

const COVER: CoverStatus = { state: 'closed', position: null, tiltPosition: null, lastChangedAt: 0 }
const CLIMATE: ClimateControlStatus = {
  mode: 'auto',
  availableModes: ['off', 'heat', 'auto'],
  fanMode: '',
  availableFanModes: [],
  preset: '',
  availablePresets: ['boost'],
  target: null,
  targetHigh: null,
  targetLow: null,
  targetHumidity: null,
  currentTemp: null,
  currentHumidity: null,
  swingVertical: null,
  swingHorizontal: null,
  lastFetchedAt: 0,
}

describe('levelToPercent', () => {
  it('scales 0..1 to 0..100 and clamps out-of-range', () => {
    expect(levelToPercent(0)).toBe(0)
    expect(levelToPercent(0.5)).toBe(50)
    expect(levelToPercent(1)).toBe(100)
    expect(levelToPercent(1.5)).toBe(100)
    expect(levelToPercent(-0.2)).toBe(0)
  })
})

describe('toHmClimateMode', () => {
  it('maps HvacMode to the library mode union', () => {
    expect(toHmClimateMode('off')).toBe('off')
    expect(toHmClimateMode('auto')).toBe('auto')
    expect(toHmClimateMode('heat_cool')).toBe('auto')
    expect(toHmClimateMode('heat')).toBe('heat')
    expect(toHmClimateMode('cool')).toBe('heat')
  })
})

describe('fromHmControlMode', () => {
  it('maps the CONTROL_MODE wire index (fallback, unresolved value list) to HvacMode', () => {
    expect(fromHmControlMode(0)).toBe('auto')
    expect(fromHmControlMode(1)).toBe('heat')
    expect(fromHmControlMode(2)).toBe('heat')
    expect(fromHmControlMode(99)).toBeNull()
  })

  // nodehomematic converts CONTROL_MODE's ENUM to the resolved value-list
  // member (`'AUTO-MODE'` etc), same as LOCK_STATE / ACTIVITY_STATE — a
  // decoder that only accepted the numeric index never decoded it at all.
  it('maps the CONVERTED CONTROL_MODE string the library actually delivers', () => {
    expect(fromHmControlMode('AUTO-MODE')).toBe('auto')
    expect(fromHmControlMode('auto-mode')).toBe('auto')
    expect(fromHmControlMode('MANU-MODE')).toBe('heat')
    expect(fromHmControlMode('PARTY-MODE')).toBe('heat')
    expect(fromHmControlMode('BOOST-MODE')).toBe('heat')
    expect(fromHmControlMode('nope')).toBeNull()
  })
})

describe('decodeCover', () => {
  it('decodes LEVEL into position + open/closed state', () => {
    expect(decodeCover(COVER, 'LEVEL', 0.42, 10)).toEqual({
      ...COVER,
      position: 42,
      state: 'open',
      lastChangedAt: 10,
    })
    expect(decodeCover(COVER, 'LEVEL', 0, 10)?.state).toBe('closed')
  })

  it('decodes ACTIVITY_STATE into a transient lifecycle state', () => {
    expect(decodeCover(COVER, 'ACTIVITY_STATE', 1, 10)?.state).toBe('opening')
    expect(decodeCover(COVER, 'ACTIVITY_STATE', 2, 10)?.state).toBe('closing')
  })

  it('a LEVEL update during a move does not END the move', () => {
    // THE defect. Homematic streams LEVEL continuously while the motor runs,
    // and this branch used to derive `open`/`closed` from it unconditionally —
    // so every position report wiped the `closing` that ACTIVITY_STATE had
    // just set. The transient was destroyed by the very messages that prove
    // the cover is moving, and no surface ever saw one. The operator pressed
    // "down" and read "no effect".
    //
    // Each branch was already tested in ISOLATION, from a fresh status. Only
    // the SEQUENCE shows it.
    const moving = decodeCover(COVER, 'ACTIVITY_STATE', 2, 10)
    expect(moving?.state).toBe('closing')
    const midMove = decodeCover(moving!, 'LEVEL', 0.5, 11)
    expect(midMove?.state).toBe('closing')
    expect(midMove?.position).toBe(50)
    expect(decodeCover(midMove!, 'LEVEL', 0.1, 12)?.state).toBe('closing')
  })

  it('ACTIVITY_STATE inactive is what ENDS a move, resolved from the position', () => {
    // The other half. `0` used to answer `previous.state`, so a cover that
    // finished closing stayed `closing` for ever — and with the branch above
    // fixed, nothing else would ever have cleared it.
    const closing = decodeCover(COVER, 'ACTIVITY_STATE', 2, 10)!
    const atBottom = decodeCover(closing, 'LEVEL', 0, 11)!
    expect(atBottom.state).toBe('closing')
    expect(decodeCover(atBottom, 'ACTIVITY_STATE', 0, 12)?.state).toBe('closed')

    const opening = decodeCover(COVER, 'ACTIVITY_STATE', 1, 20)!
    const atTop = decodeCover(opening, 'LEVEL', 1, 21)!
    expect(decodeCover(atTop, 'ACTIVITY_STATE', 0, 22)?.state).toBe('open')
  })

  it('a LEVEL update at REST still reports open / closed', () => {
    // The original behaviour, which must survive: nothing is moving, so the
    // position IS the state.
    const resting = { ...COVER, state: 'open' as const, position: 100 }
    expect(decodeCover(resting, 'LEVEL', 0, 10)?.state).toBe('closed')
    expect(decodeCover({ ...COVER, state: 'closed' as const }, 'LEVEL', 0.8, 10)?.state).toBe(
      'open',
    )
  })

  it('reads travel as the CONVERTED string the library actually sends', () => {
    // `nodehomematic`'s `ValueChangedEvent.value` is documented as "New
    // converted value", and its inbound ENUM converter maps the CCU's index
    // onto the value-list member. This decoder tested `typeof value ===
    // 'number'`, which a converted ENUM never is — so the branch never fired
    // and no cover ever reported a move. The operator pressed "down" and saw
    // nothing change.
    expect(decodeCover(COVER, 'ACTIVITY_STATE', 'UP', 10)?.state).toBe('opening')
    expect(decodeCover(COVER, 'ACTIVITY_STATE', 'DOWN', 10)?.state).toBe('closing')
    // Matched by NAME, never by index: the two value lists are ordered
    // differently, so an index mapping is a guess about a list this code
    // never sees.
    expect(decodeCover(COVER, 'ACTIVITY_STATE', 'up', 10)?.state).toBe('opening')
  })

  it('reads the RF parameter too, not only the HmIP one', () => {
    // HmIP reports travel on ACTIVITY_STATE, classic RF on DIRECTION;
    // `nodehomematic` maps both onto its own `Field.DIRECTION`. Listening for
    // one left every cover of the other family with no travel at all.
    expect(decodeCover(COVER, 'DIRECTION', 'UP', 10)?.state).toBe('opening')
    expect(decodeCover(COVER, 'DIRECTION', 'DOWN', 10)?.state).toBe('closing')
  })

  it('an idle travel value ends the move, by any of its names', () => {
    const closing = decodeCover(COVER, 'ACTIVITY_STATE', 'DOWN', 10)!
    const atBottom = decodeCover(closing, 'LEVEL', 0, 11)!
    // `STABLE` first: it is what THIS CCU sends. Measured on channel 4 of
    // 00111BE992A8E5 — ACTIVITY_STATE VALUE_LIST = UNKNOWN|UP|DOWN|STABLE.
    // Without it the move never ended and the button pulsed for ever.
    for (const idle of ['STABLE', 'INACTIVE', 'NONE', 'STOP']) {
      expect(decodeCover(atBottom, 'DIRECTION', idle, 12)?.state).toBe('closed')
    }
  })

  it('UNKNOWN is not "stopped" — it changes nothing', () => {
    // HmIP's DEFAULT member. Ending a move because the CCU has no opinion
    // would drop the pulse mid-travel.
    const closing = decodeCover(COVER, 'ACTIVITY_STATE', 'DOWN', 10)!
    expect(decodeCover(closing, 'ACTIVITY_STATE', 'UNKNOWN', 11)).toBeNull()
  })

  it('a travel value this build cannot read changes NOTHING', () => {
    // Never a guess. An unknown member must not resolve the transient, or an
    // unfamiliar CCU would silently end every move on its first report.
    const closing = decodeCover(COVER, 'ACTIVITY_STATE', 'DOWN', 10)!
    expect(decodeCover(closing, 'ACTIVITY_STATE', 'WOBBLE', 11)).toBeNull()
    expect(decodeCover(closing, 'ACTIVITY_STATE', true, 11)).toBeNull()
  })

  it('LEVEL_STATUS is a HEALTH enum, never a position', () => {
    // Read off the live CCU: VALUE_LIST = NORMAL|UNKNOWN|OVERFLOW|UNDERFLOW|
    // ERROR, CONTROL = SHUTTER_VIRTUAL_RECEIVER.LEVEL — the status OF the
    // level. It used to share the position branch, where `ERROR` as an
    // unresolved index would have published a 400 % position.
    expect(decodeCover(COVER, 'LEVEL_STATUS', 4, 10)).toBeNull()
    expect(decodeCover(COVER, 'LEVEL_STATUS', 'ERROR', 10)).toBeNull()
  })

  it('returns null for irrelevant parameters', () => {
    expect(decodeCover(COVER, 'UNREACH', true, 10)).toBeNull()
  })
})

describe('decodeLock', () => {
  it('decodes LOCK_STATE into locked / unlocked', () => {
    expect(decodeLock('LOCK_STATE', 1, 5)).toEqual({ state: 'locked', lastChangedAt: 5 })
    expect(decodeLock('LOCK_STATE', 2, 5)).toEqual({ state: 'unlocked', lastChangedAt: 5 })
  })

  it('returns null for unknown parameters', () => {
    expect(decodeLock('ERROR_JAMMED', true, 5)).toBeNull()
  })

  it('decodes the CONVERTED enum member the library actually delivers', () => {
    expect(decodeLock('LOCK_STATE', 'LOCKED', 5)).toEqual({
      state: 'locked',
      lastChangedAt: 5,
    })
    expect(decodeLock('LOCK_STATE', 'UNLOCKED', 5)).toEqual({
      state: 'unlocked',
      lastChangedAt: 5,
    })
  })

  // `decodeLock` no longer takes the previous slice at all — an unknown
  // reading is `null` unconditionally, regardless of whether the caller's
  // previous state was a placeholder or a real reading. The caller (not
  // this pure decoder) is what leaves a placeholder a placeholder and a
  // real reading untouched; that behaviour is covered device-level in
  // `hm-seed-change-stamp.spec.ts`.
  it('an unknown LOCK_STATE writes nothing', () => {
    expect(decodeLock('LOCK_STATE', 0, 5)).toBeNull()
    expect(decodeLock('LOCK_STATE', 'UNKNOWN', 5)).toBeNull()
  })
})

describe('decodeClimate', () => {
  it('decodes SET_POINT_TEMPERATURE into target', () => {
    expect(decodeClimate(CLIMATE, 'SET_POINT_TEMPERATURE', 21.5, 7)?.target).toBe(21.5)
  })

  it('decodes ACTUAL_TEMPERATURE into currentTemp', () => {
    expect(decodeClimate(CLIMATE, 'ACTUAL_TEMPERATURE', 19.2, 7)?.currentTemp).toBe(19.2)
  })

  it('decodes HUMIDITY into currentHumidity', () => {
    expect(decodeClimate(CLIMATE, 'HUMIDITY', 48, 7)?.currentHumidity).toBe(48)
  })

  it('decodes CONTROL_MODE into mode', () => {
    expect(decodeClimate(CLIMATE, 'CONTROL_MODE', 1, 7)?.mode).toBe('heat')
    expect(decodeClimate(CLIMATE, 'CONTROL_MODE', 0, 7)?.mode).toBe('auto')
  })

  it('decodes BOOST_MODE into the preset', () => {
    expect(decodeClimate(CLIMATE, 'BOOST_MODE', true, 7)?.preset).toBe('boost')
    expect(decodeClimate(CLIMATE, 'BOOST_MODE', false, 7)?.preset).toBe('')
  })

  it('returns null for irrelevant parameters', () => {
    expect(decodeClimate(CLIMATE, 'RSSI_DEVICE', -50, 7)).toBeNull()
  })
})
