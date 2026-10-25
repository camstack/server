import { describe, expect, it } from 'vitest'
import {
  absorbSignal,
  DEFAULT_WAKE_HOLD_MS,
  holdIsLive,
  NO_HOLD,
  WAKE_HOLD_MAX_RUN_MS,
  WAKE_QUARANTINE_AFTER_CAP_MS,
  type WakeHold,
} from './wake-hold.js'

const T0 = 1_000_000
const HOLD = DEFAULT_WAKE_HOLD_MS

describe('absorbSignal', () => {
  it('the first signal ARMS a run', () => {
    const { hold, outcome } = absorbSignal({ current: NO_HOLD, now: T0, holdMs: HOLD })
    expect(outcome).toBe('armed')
    expect(hold).toEqual({
      runStartedAt: T0,
      until: T0 + HOLD,
      signals: 1,
      quarantinedUntil: 0,
    })
  })

  it('EXTENDS from the last signal, never stacks', () => {
    // Continuous motion keeps the camera up; it sleeps `holdMs` after the LAST
    // signal, not after the sum of them.
    const first = absorbSignal({ current: NO_HOLD, now: T0, holdMs: HOLD }).hold
    const second = absorbSignal({ current: first, now: T0 + 5_000, holdMs: HOLD })
    expect(second.outcome).toBe('extended')
    expect(second.hold.until).toBe(T0 + 5_000 + HOLD)
    expect(second.hold.runStartedAt).toBe(T0)
    expect(second.hold.signals).toBe(2)
  })

  it('a signal after the hold EXPIRED starts a NEW run', () => {
    const first = absorbSignal({ current: NO_HOLD, now: T0, holdMs: HOLD }).hold
    const later = absorbSignal({ current: first, now: T0 + HOLD + 1, holdMs: HOLD })
    expect(later.outcome).toBe('armed')
    expect(later.hold.runStartedAt).toBe(T0 + HOLD + 1)
    expect(later.hold.signals).toBe(1)
  })

  it('never extends past the ceiling, even by one signal', () => {
    const nearCeiling: WakeHold = {
      runStartedAt: T0,
      until: T0 + WAKE_HOLD_MAX_RUN_MS - 1_000,
      signals: 40,
      quarantinedUntil: 0,
    }
    const out = absorbSignal({
      current: nearCeiling,
      now: T0 + WAKE_HOLD_MAX_RUN_MS - 2_000,
      holdMs: HOLD,
    })
    expect(out.hold.until).toBe(T0 + WAKE_HOLD_MAX_RUN_MS)
  })

  it('a STUCK sensor is capped, and says so', () => {
    // The failure this whole design exists to prevent: a PIR reporting every
    // second must cost one five-minute wake, not a night.
    const atCeiling: WakeHold = {
      runStartedAt: T0,
      until: T0 + WAKE_HOLD_MAX_RUN_MS,
      signals: 300,
      // The run reached the ceiling, so the quarantine is already armed — that
      // is what the extension that touched the ceiling did.
      quarantinedUntil: T0 + WAKE_HOLD_MAX_RUN_MS + WAKE_QUARANTINE_AFTER_CAP_MS,
    }
    const out = absorbSignal({
      current: atCeiling,
      now: T0 + WAKE_HOLD_MAX_RUN_MS,
      holdMs: HOLD,
    })
    expect(out.outcome).toBe('quarantined')
    expect(out.hold.until).toBe(atCeiling.until)
    // Counted, so the line can say how many a stuck sensor is producing.
    expect(out.hold.signals).toBe(301)
  })

  it('a capped run does not secretly restart itself', () => {
    // A new run measured from now would be the same unbounded extension under
    // a different name.
    const atCeiling: WakeHold = {
      runStartedAt: T0,
      until: T0 + WAKE_HOLD_MAX_RUN_MS,
      signals: 300,
      quarantinedUntil: 0,
    }
    const out = absorbSignal({ current: atCeiling, now: T0 + 10, holdMs: HOLD })
    expect(out.hold.runStartedAt).toBe(T0)
  })
})

describe('holdIsLive', () => {
  it('is the one question the demand predicate asks', () => {
    expect(holdIsLive(NO_HOLD, T0)).toBe(false)
    const hold: WakeHold = { runStartedAt: T0, until: T0 + 10, signals: 1, quarantinedUntil: 0 }
    expect(holdIsLive(hold, T0)).toBe(true)
    expect(holdIsLive(hold, T0 + 10)).toBe(false)
  })
})

describe('the ceiling is not cosmetic', () => {
  it('a capped run cannot restart the instant it lapses', () => {
    // The gap the first version of this file had, found by its own test: a run
    // ends exactly AT the ceiling, so the next signal from a sensor that never
    // stops armed a fresh five minutes. Five awake, an instant asleep, five
    // awake — all night, which is the failure the ceiling exists to prevent.
    let hold = absorbSignal({ current: NO_HOLD, now: T0, holdMs: HOLD }).hold
    // Drive it to the ceiling with a signal every second.
    for (let t = T0 + 1_000; t <= T0 + WAKE_HOLD_MAX_RUN_MS; t += 1_000) {
      hold = absorbSignal({ current: hold, now: t, holdMs: HOLD }).hold
    }
    expect(hold.until).toBe(T0 + WAKE_HOLD_MAX_RUN_MS)
    expect(hold.quarantinedUntil).toBeGreaterThan(hold.until)

    // The very next signal, the instant the run lapses.
    const next = absorbSignal({
      current: hold,
      now: T0 + WAKE_HOLD_MAX_RUN_MS,
      holdMs: HOLD,
    })
    expect(next.outcome).toBe('quarantined')
    expect(holdIsLive(next.hold, T0 + WAKE_HOLD_MAX_RUN_MS)).toBe(false)
  })

  it('and the camera is free again once the quarantine lifts', () => {
    const quarantined: WakeHold = {
      runStartedAt: T0,
      until: T0 + WAKE_HOLD_MAX_RUN_MS,
      signals: 300,
      quarantinedUntil: T0 + WAKE_HOLD_MAX_RUN_MS + WAKE_QUARANTINE_AFTER_CAP_MS,
    }
    const after = absorbSignal({
      current: quarantined,
      now: quarantined.quarantinedUntil,
      holdMs: HOLD,
    })
    expect(after.outcome).toBe('armed')
    expect(after.hold.signals).toBe(1)
  })
})
