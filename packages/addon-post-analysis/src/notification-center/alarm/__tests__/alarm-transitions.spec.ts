import type { AlarmArmMode, AlarmState } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  alarmTransition,
  NC_ALARM_INCIDENT_MAX_FOLLOWERS,
  NcAlarmAttribution,
  type NcAlarmTriggerSource,
} from '../alarm-transitions.js'

const MODES: readonly AlarmArmMode[] = ['home', 'away', 'night']

const SOURCE: NcAlarmTriggerSource = {
  ruleId: 'r1',
  ruleName: 'Intrusione',
  deviceId: 102,
  recordId: 'ev-1',
  trackId: 'trk-1',
  timestamp: 1_000,
}

describe('alarmTransition', () => {
  it('says nothing on the FIRST publish — a restart armed nothing', () => {
    expect(alarmTransition({ previous: null, next: 'armed_away', modes: MODES, at: 1 })).toBeNull()
    expect(alarmTransition({ previous: null, next: 'triggered', modes: MODES, at: 1 })).toBeNull()
  })

  it('says nothing when the state did not change', () => {
    expect(
      alarmTransition({ previous: 'armed_away', next: 'armed_away', modes: MODES, at: 1 }),
    ).toBeNull()
  })

  it('reports the siren, with the rule that set it off', () => {
    const t = alarmTransition({
      previous: 'pending',
      next: 'triggered',
      modes: MODES,
      at: 5,
      source: SOURCE,
    })
    expect(t).toEqual({
      kind: 'alarm-triggered',
      state: 'triggered',
      previous: 'pending',
      at: 5,
      source: SOURCE,
    })
  })

  it('reports a MANUAL siren with no source at all', () => {
    const t = alarmTransition({ previous: 'armed_home', next: 'triggered', modes: MODES, at: 5 })
    expect(t?.kind).toBe('alarm-triggered')
    expect(t?.source).toBeUndefined()
  })

  it('reports an arm, and a mode CHANGE', () => {
    expect(
      alarmTransition({ previous: 'arming', next: 'armed_away', modes: MODES, at: 7 }),
    ).toMatchObject({ kind: 'alarm-armed', mode: 'away' })
    expect(
      alarmTransition({ previous: 'armed_home', next: 'armed_away', modes: MODES, at: 7 }),
    ).toMatchObject({ kind: 'alarm-armed', mode: 'away' })
  })

  it('reports the panel re-arming itself after a bounded siren as a RE-ARM, not an arm', () => {
    // Not silence (D630: every transition is told) and not "Away armed" either
    // — that would read as somebody arming it mid break-in.
    expect(
      alarmTransition({ previous: 'triggered', next: 'armed_away', modes: MODES, at: 9 }),
    ).toEqual({
      kind: 'alarm-rearmed',
      state: 'armed_away',
      previous: 'triggered',
      mode: 'away',
      at: 9,
    })
  })

  it('does not report an arm into a mode this panel does not offer', () => {
    expect(
      alarmTransition({ previous: 'disarmed', next: 'armed_vacation', modes: MODES, at: 9 }),
    ).toBeNull()
  })

  it('reports a disarm, including one that cancelled an entry countdown', () => {
    expect(
      alarmTransition({ previous: 'armed_away', next: 'disarmed', modes: MODES, at: 11 }),
    ).toMatchObject({ kind: 'alarm-disarmed', previous: 'armed_away' })
    expect(
      alarmTransition({ previous: 'pending', next: 'disarmed', modes: MODES, at: 11 }),
    ).toMatchObject({ kind: 'alarm-disarmed', previous: 'pending' })
  })

  it('says nothing about a countdown state it was told nothing about', () => {
    // `pending` and `disarming` are never announced at all; `arming` is
    // announced only when the panel says what it is arming INTO and when.
    // A provider that reports the bare word (a Home Assistant panel mirroring
    // someone else's keypad) names no mode and no delay — and a countdown
    // notification that cannot say "armed in 30s" is not the feature.
    for (const next of ['arming', 'pending', 'disarming'] as const) {
      expect(alarmTransition({ previous: 'disarmed', next, modes: MODES, at: 13 })).toBeNull()
    }
  })
})

/**
 * THE EXIT DELAY. Everything here is about the window between pressing Arm and
 * the alarm actually being on — the one alarm notification that arrives while
 * the operator can still change their mind.
 */
/**
 * THE ENTRY DELAY. The window between a sensor tripping and the triggered notification — the
 * only one in which the person walking in can still disarm.
 */
describe('alarmTransition — the entry delay', () => {
  it('armed_away → pending gives alarm-pending, with the seconds left', () => {
    expect(
      alarmTransition({
        previous: 'armed_away',
        next: 'pending',
        modes: MODES,
        at: 1_000,
        pending: { target: 'armed_away', triggerAt: 21_000 },
      }),
    ).toEqual({
      kind: 'alarm-pending',
      state: 'pending',
      previous: 'armed_away',
      mode: 'away',
      seconds: 20,
      at: 1_000,
    })
  })

  it('carries the rule that started the countdown', () => {
    expect(
      alarmTransition({
        previous: 'armed_home',
        next: 'pending',
        modes: MODES,
        at: 1_001,
        source: SOURCE,
        pending: { target: 'armed_home', triggerAt: 21_000 },
      }),
    ).toMatchObject({ kind: 'alarm-pending', mode: 'home', seconds: 20, source: SOURCE })
  })

  it('says nothing on the TICK — the entry delay is one notification', () => {
    expect(
      alarmTransition({
        previous: 'pending',
        next: 'pending',
        modes: MODES,
        at: 2_000,
        pending: { target: 'armed_away', triggerAt: 21_000 },
      }),
    ).toBeNull()
  })

  it('pending → disarmed is a disarm that says what it cancelled', () => {
    expect(
      alarmTransition({ previous: 'pending', next: 'disarmed', modes: MODES, at: 3_000 }),
    ).toEqual({ kind: 'alarm-disarmed', state: 'disarmed', previous: 'pending', at: 3_000 })
    expect(
      alarmTransition({ previous: 'triggered', next: 'disarmed', modes: MODES, at: 3_000 }),
    ).toMatchObject({ kind: 'alarm-disarmed', previous: 'triggered' })
  })

  it('arming → armed_away is still alarm-armed, and a boot publish is still nothing', () => {
    expect(
      alarmTransition({ previous: 'arming', next: 'armed_away', modes: MODES, at: 5 }),
    ).toMatchObject({ kind: 'alarm-armed', mode: 'away' })
    expect(
      alarmTransition({
        previous: null,
        next: 'pending',
        modes: MODES,
        at: 5,
        pending: { target: 'armed_away', triggerAt: 20_000 },
      }),
    ).toBeNull()
  })
})

describe('alarmTransition — the exit delay', () => {
  const arming = (armedAt: number): { target: AlarmState; armedAt: number } => ({
    target: 'armed_away',
    armedAt,
  })

  it('reports the arming that STARTED, with the mode and the seconds left', () => {
    expect(
      alarmTransition({
        previous: 'disarmed',
        next: 'arming',
        modes: MODES,
        at: 1_000,
        arming: arming(31_000),
      }),
    ).toEqual({
      kind: 'alarm-arming',
      state: 'arming',
      previous: 'disarmed',
      mode: 'away',
      seconds: 30,
      at: 1_000,
    })
  })

  it('says nothing on the TICK — the countdown is one notification, not thirty', () => {
    // The panel re-publishes once a second while a delay runs. Every one of
    // those is `arming → arming`, and the guard that stops them is the same
    // one that stops a re-published `armed_away`.
    expect(
      alarmTransition({
        previous: 'arming',
        next: 'arming',
        modes: MODES,
        at: 2_000,
        arming: arming(31_000),
      }),
    ).toBeNull()
  })

  it('says nothing on the FIRST publish — a hub that rebooted mid-exit armed nothing', () => {
    expect(
      alarmTransition({
        previous: null,
        next: 'arming',
        modes: MODES,
        at: 2_000,
        arming: arming(31_000),
      }),
    ).toBeNull()
  })

  it('does not report an exit delay into a mode this panel does not offer', () => {
    expect(
      alarmTransition({
        previous: 'disarmed',
        next: 'arming',
        modes: MODES,
        at: 1_000,
        arming: { target: 'armed_vacation', armedAt: 31_000 },
      }),
    ).toBeNull()
  })

  it('never reports a NEGATIVE countdown', () => {
    // `settle()` may report a publish a tick late, and "armed in -1 seconds"
    // is the sentence that would reach the phone.
    expect(
      alarmTransition({
        previous: 'disarmed',
        next: 'arming',
        modes: MODES,
        at: 40_000,
        arming: arming(31_000),
      }),
    ).toMatchObject({ seconds: 0 })
  })

  it('rounds UP, so a 30s delay is never announced as 29', () => {
    expect(
      alarmTransition({
        previous: 'disarmed',
        next: 'arming',
        modes: MODES,
        at: 1_001,
        arming: arming(31_000),
      }),
    ).toMatchObject({ seconds: 30 })
  })

  it('still reports the ARM that ends the exit delay — two events, not one', () => {
    // The pair is the feature: "arming, 30s" then "Away armed — 12 cameras".
    expect(
      alarmTransition({ previous: 'arming', next: 'armed_away', modes: MODES, at: 31_000 }),
    ).toMatchObject({ kind: 'alarm-armed', mode: 'away' })
  })
})

/**
 * The lifetime of "who set this alarm off". Every case below is a way the
 * COMBINED notification would otherwise carry the wrong incident's pictures.
 * There is no pending note any more (D735): the source rides the press.
 */
describe('NcAlarmAttribution', () => {
  it('an accepted rule press claims its own source', () => {
    const a = new NcAlarmAttribution()
    a.claim(SOURCE)
    expect(a.current()).toBe(SOURCE)
  })

  it('survives the ENTRY DELAY — the press and the siren are 20s apart', () => {
    const a = new NcAlarmAttribution()
    a.claim(SOURCE)
    // Twenty seconds of `pending` later, the siren finally sounds.
    expect(a.current()).toBe(SOURCE)
  })

  it('a MANUAL trigger clears what a rule left behind, never inherits it', () => {
    const a = new NcAlarmAttribution()
    a.claim(SOURCE)
    a.claim(null)
    expect(a.current()).toBeNull()
  })

  it('a re-arm or a disarm drops the countdown it belonged to', () => {
    const a = new NcAlarmAttribution()
    a.claim(SOURCE)
    a.clear()
    expect(a.current()).toBeNull()
  })
})

/**
 * D705 — the incident's OTHER subjects. A match that presses the panel while its
 * entry delay runs is refused as a trigger, and `follow` is the only thing that
 * keeps its subject for the triggered notification's mosaic.
 */
describe('NcAlarmAttribution — followers (D705)', () => {
  const OTHER: NcAlarmTriggerSource = {
    ...SOURCE,
    ruleId: 'r2',
    deviceId: 101,
    recordId: 'ev-2',
    trackId: 'trk-2',
    timestamp: 5_000,
  }

  it('keeps a match that pressed during the countdown', () => {
    const a = new NcAlarmAttribution()
    a.claim(SOURCE)
    expect(a.follow(OTHER)).toEqual({ kind: 'joined', source: OTHER, followers: 1 })
    expect(a.followers()).toEqual([OTHER])
  })

  it('never holds the same subject twice — the source, or a follower', () => {
    const a = new NcAlarmAttribution()
    a.claim(SOURCE)
    expect(a.follow({ ...SOURCE, ruleId: 'r9' }).kind).toBe('duplicate')
    a.follow(OTHER)
    expect(a.follow(OTHER).kind).toBe('duplicate')
    expect(a.followers()).toEqual([OTHER])
  })

  it('is bounded — a camera matching for the whole delay does not grow the row', () => {
    const a = new NcAlarmAttribution()
    a.claim(SOURCE)
    for (let i = 0; i < NC_ALARM_INCIDENT_MAX_FOLLOWERS; i += 1) {
      expect(a.follow({ ...OTHER, trackId: `trk-f${i}` }).kind).toBe('joined')
    }
    expect(a.follow({ ...OTHER, trackId: 'trk-over' }).kind).toBe('full')
    expect(a.followers()).toHaveLength(NC_ALARM_INCIDENT_MAX_FOLLOWERS)
  })

  it('a countdown started BY HAND collects nobody — there is no combined row', () => {
    const a = new NcAlarmAttribution()
    a.claim(null)
    expect(a.follow(OTHER)).toEqual({ kind: 'no-incident', source: OTHER })
    expect(a.followers()).toEqual([])
  })

  it('a new countdown, a trigger announced or a disarm drops what the last one collected', () => {
    const a = new NcAlarmAttribution()
    a.claim(SOURCE)
    a.follow(OTHER)
    a.clear()
    expect(a.followers()).toEqual([])
    a.claim(SOURCE)
    a.follow(OTHER)
    a.claim(SOURCE)
    expect(a.followers()).toEqual([])
  })
})

describe('alarmTransition — followers ride alarm-triggered only (D705)', () => {
  const FOLLOWER: NcAlarmTriggerSource = { ...SOURCE, ruleId: 'r2', trackId: 'trk-2' }

  it('carries them on alarm-triggered beside the source', () => {
    const t = alarmTransition({
      previous: 'pending',
      next: 'triggered',
      modes: MODES,
      at: 9_000,
      source: SOURCE,
      followers: [FOLLOWER],
    })
    expect(t?.followers).toEqual([FOLLOWER])
  })

  it('never without a source, and never as an empty list', () => {
    const manual = alarmTransition({
      previous: 'pending',
      next: 'triggered',
      modes: MODES,
      at: 9_000,
      followers: [FOLLOWER],
    })
    expect(manual).not.toHaveProperty('followers')
    const alone = alarmTransition({
      previous: 'pending',
      next: 'triggered',
      modes: MODES,
      at: 9_000,
      source: SOURCE,
      followers: [],
    })
    expect(alone).not.toHaveProperty('followers')
  })
})
