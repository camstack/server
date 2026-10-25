/**
 * The alarm's state machine.
 *
 * `alarm-panel` has always DECLARED `arming` / `pending` / `disarming`; the only
 * provider was Home Assistant mirroring someone else's panel, so those states
 * were passed through and never produced. Producing them is the whole
 * difference between a panel and a boolean, and every test here is about one of
 * the two delays or about the transition that cancels them.
 *
 * The states are computed from INSTANTS, not from timers. A missed tick delays
 * the notification about a change; it can never leave the panel wedged in
 * `arming` — the same property that makes a snooze expire by comparison.
 */
import { describe, expect, it } from 'vitest'
import {
  type AlarmDelays,
  arm,
  DISARMED,
  disarm,
  exitDelayAt,
  isArmed,
  pendingAt,
  settle,
  stateAt,
  trigger,
} from '../alarm-state-machine.js'

const T0 = 1_800_000_000_000
const SEC = 1000
const delays: AlarmDelays = {
  exitDelaySec: 30,
  entryDelaySec: 20,
  triggeredDurationSec: 0,
  postTriggeredAction: 'doNothing',
}
const instant: AlarmDelays = {
  exitDelaySec: 0,
  entryDelaySec: 0,
  triggeredDurationSec: 0,
  postTriggeredAction: 'doNothing',
}

describe('arming — the exit delay', () => {
  it('reports `arming` until the delay passes, then the armed mode', () => {
    // Without this you cannot arm the alarm and then leave the house.
    const m = arm('away', delays, T0)
    expect(stateAt(m, T0)).toBe('arming')
    expect(stateAt(m, T0 + 29 * SEC)).toBe('arming')
    expect(stateAt(m, T0 + 30 * SEC)).toBe('armed_away')
  })

  it('arms immediately when the mode has no exit delay', () => {
    // `home` legitimately has none — nobody is leaving.
    expect(stateAt(arm('home', instant, T0), T0)).toBe('armed_home')
  })

  it('needs nothing to have RUN for the delay to end', () => {
    // The value is unchanged; only the clock moved.
    const m = arm('away', delays, T0)
    expect(stateAt(m, T0 + 3600 * SEC)).toBe('armed_away')
  })

  /**
   * What the arming NOTIFICATION is built from. `arming` is a bare word — it
   * names neither the mode nor the instant — so the answer to "armed into what,
   * in how long" has to come from the machine, and it has to stop being an
   * answer the moment the delay is over.
   */
  describe('exitDelayAt', () => {
    it('answers the target and the instant while the delay runs', () => {
      const m = arm('away', delays, T0)
      expect(exitDelayAt(m, T0)).toEqual({ target: 'armed_away', armedAt: T0 + 30 * SEC })
    })

    it('answers NOTHING once the mode has taken effect', () => {
      // The panel keeps `armedAt` until it is settled. Reading it as a running
      // delay would announce a countdown for a panel that is already armed.
      const m = arm('away', delays, T0)
      expect(exitDelayAt(m, T0 + 30 * SEC)).toBeUndefined()
    })

    it('answers nothing for a mode armed with no exit delay at all', () => {
      expect(exitDelayAt(arm('home', instant, T0), T0)).toBeUndefined()
    })

    it('answers nothing while a DIFFERENT countdown runs', () => {
      // A trigger during the exit delay would leave `armedAt` set and the state
      // `pending`; the operator is not arming, they are about to be alarmed.
      const armed = arm('away', instant, T0)
      const pending = trigger(armed, delays, T0 + SEC)
      expect(exitDelayAt(pending, T0 + SEC)).toBeUndefined()
    })

    it('answers nothing for a disarmed panel', () => {
      expect(exitDelayAt(DISARMED, T0)).toBeUndefined()
    })
  })
})

describe('pendingAt — the entry delay in flight', () => {
  it('answers the target and the instant the siren sounds while pending', () => {
    const pending = trigger(arm('away', instant, T0), delays, T0 + SEC)
    expect(pendingAt(pending, T0 + 2 * SEC)).toEqual({
      target: 'armed_away',
      triggerAt: T0 + 21 * SEC,
    })
  })

  it('answers nothing once the siren sounds, or when nothing is pending', () => {
    const pending = trigger(arm('away', instant, T0), delays, T0 + SEC)
    expect(pendingAt(pending, T0 + 21 * SEC)).toBeUndefined()
    expect(pendingAt(arm('away', instant, T0), T0)).toBeUndefined()
    expect(pendingAt(DISARMED, T0)).toBeUndefined()
  })
})

describe('pending — the entry delay', () => {
  it('a trigger while armed opens the entry delay, then fires', () => {
    const armed = arm('away', instant, T0)
    const t = trigger(armed, delays, T0 + SEC)
    expect(stateAt(t, T0 + SEC)).toBe('pending')
    expect(stateAt(t, T0 + 20 * SEC)).toBe('pending')
    expect(stateAt(t, T0 + 21 * SEC)).toBe('triggered')
  })

  it('fires at once when there is no entry delay', () => {
    const armed = arm('away', instant, T0)
    expect(stateAt(trigger(armed, instant, T0 + SEC), T0 + SEC)).toBe('triggered')
  })

  it('a SECOND trigger does not restart the countdown', () => {
    // An intruder walking past two sensors would otherwise postpone the alarm
    // indefinitely.
    const armed = arm('away', instant, T0)
    const first = trigger(armed, delays, T0 + SEC)
    const second = trigger(first, delays, T0 + 10 * SEC)
    expect(stateAt(second, T0 + 21 * SEC)).toBe('triggered')
  })

  it('IGNORES a trigger while disarmed', () => {
    // The panel is the gate. A rule firing while disarmed is a notification,
    // not a break-in — and an alarm that could be set off while disarmed would
    // make the whole feature untrustworthy.
    expect(trigger(DISARMED, delays, T0)).toEqual(DISARMED)
    expect(stateAt(trigger(DISARMED, delays, T0), T0 + 3600 * SEC)).toBe('disarmed')
  })

  it('ignores a trigger DURING the exit delay — you are still on your way out', () => {
    const arming = arm('away', delays, T0)
    // `arming` is not armed yet, so walking to the door cannot set it off.
    expect(isArmed(arming, T0 + SEC)).toBe(false)
    expect(stateAt(trigger(arming, delays, T0 + SEC), T0 + SEC)).toBe('arming')
  })
})

describe('disarm — the transition that has to cancel, not queue', () => {
  it('cancels a pending entry rather than letting it fire behind you', () => {
    // Walking in and typing the code is the most-used transition in a real
    // alarm. A disarm that only masked the pending timer would set the alarm
    // off after the operator had already stopped it.
    const armed = arm('away', instant, T0)
    trigger(armed, delays, T0 + SEC)
    const off = disarm(T0 + 5 * SEC)
    expect(stateAt(off, T0 + 60 * SEC)).toBe('disarmed')
  })

  it('cancels an exit delay', () => {
    arm('away', delays, T0)
    expect(stateAt(disarm(T0 + SEC), T0 + 600 * SEC)).toBe('disarmed')
  })

  it('clears a fired alarm', () => {
    const armed = arm('away', instant, T0)
    const fired = trigger(armed, instant, T0 + SEC)
    expect(stateAt(fired, T0 + SEC)).toBe('triggered')
    expect(stateAt(disarm(T0 + 2 * SEC), T0 + 2 * SEC)).toBe('disarmed')
  })
})

describe('settle — so a stored value does not depend on when it is read', () => {
  it('turns a passed entry delay into a fired alarm in the RECORD', () => {
    const armed = arm('away', instant, T0)
    const pending = trigger(armed, delays, T0)
    const settled = settle(pending, T0 + 21 * SEC)
    expect(settled.fired).toBe(true)
    // And it fired when the delay ended, not when someone happened to look.
    expect(settled.changedAt).toBe(T0 + 20 * SEC)
  })

  it('turns a passed exit delay into the armed mode', () => {
    const settled = settle(arm('away', delays, T0), T0 + 31 * SEC)
    expect(settled.armedAt).toBeUndefined()
    expect(stateAt(settled, T0 + 31 * SEC)).toBe('armed_away')
  })

  it('leaves an unfinished delay alone', () => {
    const arming = arm('away', delays, T0)
    expect(settle(arming, T0 + SEC)).toEqual(arming)
  })
})

/**
 * The third duration. Everything here is about the same failure: a panel that
 * goes off once and is then not armed for the rest of the night, because
 * `triggered` had no end and only a person could clear it.
 */
describe('the triggered duration — a siren that stops, and re-arms', () => {
  const bounded: AlarmDelays = {
    exitDelaySec: 0,
    entryDelaySec: 0,
    triggeredDurationSec: 120,
    postTriggeredAction: 'rearmAfter',
  }

  it('returns to the armed mode once the duration passes', () => {
    const fired = trigger(arm('away', bounded, T0), bounded, T0 + SEC)
    expect(stateAt(fired, T0 + SEC)).toBe('triggered')
    expect(stateAt(fired, T0 + 119 * SEC)).toBe('triggered')
    expect(stateAt(fired, T0 + 122 * SEC)).toBe('armed_away')
  })

  it('0 means "until somebody disarms it" — the behaviour before the field existed', () => {
    const fired = trigger(arm('away', instant, T0), instant, T0 + SEC)
    expect(stateAt(fired, T0 + 86_400 * SEC)).toBe('triggered')
  })

  it('counts from the FIRE, not from the trigger — the entry delay is not siren time', () => {
    // 20s pending, then 120s of siren: it must stop at 140s, not at 120s.
    const withEntry: AlarmDelays = {
      exitDelaySec: 0,
      entryDelaySec: 20,
      triggeredDurationSec: 120,
      postTriggeredAction: 'rearmAfter',
    }
    const pending = trigger(arm('away', withEntry, T0), withEntry, T0)
    expect(stateAt(pending, T0 + 19 * SEC)).toBe('pending')
    expect(stateAt(pending, T0 + 139 * SEC)).toBe('triggered')
    expect(stateAt(pending, T0 + 141 * SEC)).toBe('armed_away')
  })

  it('is ARMED again afterwards, so a SECOND intruder still sets it off', () => {
    // The whole point. Before this, one event left the panel un-armable and
    // everything after it was unprotected.
    const first = trigger(arm('away', bounded, T0), bounded, T0 + SEC)
    const later = T0 + 200 * SEC
    expect(isArmed(first, later)).toBe(true)
    const second = trigger(first, bounded, later)
    expect(second).not.toBe(first)
    expect(stateAt(second, later)).toBe('triggered')
    // …and the second siren gets its own full duration.
    expect(stateAt(second, later + 119 * SEC)).toBe('triggered')
    expect(stateAt(second, later + 121 * SEC)).toBe('armed_away')
  })

  it('a disarm during the siren still wins', () => {
    const fired = trigger(arm('away', bounded, T0), bounded, T0 + SEC)
    expect(stateAt(fired, T0 + 10 * SEC)).toBe('triggered')
    expect(stateAt(disarm(T0 + 10 * SEC), T0 + 300 * SEC)).toBe('disarmed')
  })

  it('settles into a re-armed machine, so a restart mid-siren comes back armed', () => {
    // A hub restarted 5 minutes into a 2-minute siren must not resume sounding.
    const fired = trigger(arm('away', bounded, T0), bounded, T0)
    const settled = settle(fired, T0 + 300 * SEC)
    expect(settled.fired).toBe(false)
    expect(settled.clearAt).toBeUndefined()
    expect(settled.triggerAt).toBeUndefined()
    expect(stateAt(settled, T0 + 300 * SEC)).toBe('armed_away')
    // It stopped when the duration ended, not when the hub came back.
    expect(settled.changedAt).toBe(T0 + 120 * SEC)
  })

  it('settle keeps the stop instant while the siren is still sounding', () => {
    // Dropping `clearAt` here is the bug that would leave it sounding forever:
    // settle runs on every publish tick.
    const fired = trigger(arm('away', bounded, T0), bounded, T0)
    const settled = settle(fired, T0 + SEC)
    expect(settled.fired).toBe(true)
    expect(settled.clearAt).toBe(T0 + 120 * SEC)
    expect(stateAt(settled, T0 + 121 * SEC)).toBe('armed_away')
  })

  it('disableAfter settles to disarmed instead of re-arming', () => {
    const disable: AlarmDelays = {
      exitDelaySec: 0,
      entryDelaySec: 0,
      triggeredDurationSec: 60,
      postTriggeredAction: 'disableAfter',
    }
    const fired = trigger(arm('night', disable, T0), disable, T0)
    expect(stateAt(fired, T0 + 30 * SEC)).toBe('triggered')
    expect(stateAt(fired, T0 + 61 * SEC)).toBe('disarmed')
    const settled = settle(fired, T0 + 61 * SEC)
    expect(settled.target).toBe('disarmed')
    expect(settled.fired).toBe(false)
    expect(isArmed(settled, T0 + 61 * SEC)).toBe(false)
  })
})
