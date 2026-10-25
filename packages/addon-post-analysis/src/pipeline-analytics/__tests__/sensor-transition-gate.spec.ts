/**
 * The gate between "a `DeviceStateChanged` arrived for a mapped sensor cap"
 * and "the sensor actually changed".
 *
 * The red tests are the two families measured on camera 101 / contact sensor
 * 4131 on 2026-08-29→30. Neither is a door opening, and both minted a
 * synthetic `contact` track on the camera's timeline:
 *
 *  - the RECOVERY family. The Zigbee entity flaps `off → unavailable → off`
 *    (03:22:37 → 03:23:28, 03:56:51 → 03:58:19, 04:40:05 → 04:45:45). The HA
 *    provider drops the `unavailable` push and writes the recovery, whose
 *    `entryOpen` is still `false` and whose `lastChangedAt` has MOVED. The
 *    kernel mirror diffs the slice, not the boolean, so it emits;
 *  - the COLD-SLICE family. `HaBinarySensorDevice`'s constructor writes
 *    `{ entryOpen: false, lastChangedAt: 0 }` on every device rebuild, and the
 *    real state lands seconds later with a `lastChangedAt` HOURS old. Two
 *    emissions, no transition.
 *
 * 30 of 35 contact events in that window were one of these. A real cycle
 * (03:41:06 open, 03:41:17 close) must still pass — BOTH edges: the timeline
 * marker is not the doorbell's rising edge, a door closing is an event too.
 *
 * And the caps with no level at all (`doorbell`, `button`, `presence`,
 * `event-emitter`) must pass through untouched.
 * Suppressing those is the failure this repo already shipped once — camera
 * 101's press of 2026-08-08 06:59Z produced a row, a ring and no marker.
 */
import { describe, expect, it } from 'vitest'
import { SensorTransitionGate } from '../services/sensor-transition-gate.js'

const SENSOR = 4131
const STARTED_AT = 1_788_000_000_000
/** A KNOWN value with an UNKNOWN change time — see the gate's header, "A
 *  placeholder slice is not a state". Not 0 (a placeholder), never fresh. */
const KNOWN_BUT_OLD = 1

/** A gate whose clock and start floor are fixed, so no test reads Date.now(). */
function gate(nowMs = STARTED_AT + 60_000): SensorTransitionGate {
  return new SensorTransitionGate({ startedAtMs: STARTED_AT, now: () => nowMs })
}

describe('SensorTransitionGate', () => {
  it('drops the availability recovery: entryOpen unchanged, only lastChangedAt moved', () => {
    const g = gate()
    // The steady state the mirror already holds.
    expect(
      g.observe(SENSOR, 'contact', { entryOpen: false, lastChangedAt: STARTED_AT - 3_600_000 }),
    ).toEqual({ changed: false, reason: 'baseline-seeded-inactive' })
    // `unavailable → off`: the provider re-writes with a FRESH lastChangedAt.
    expect(
      g.observe(SENSOR, 'contact', { entryOpen: false, lastChangedAt: STARTED_AT + 59_000 }),
    ).toEqual({ changed: false, reason: 'no-change' })
  })

  it('drops the cold-slice rebuild pair', () => {
    const g = gate()
    // `HaBinarySensorDevice` constructor: a placeholder, not a state.
    expect(g.observe(SENSOR, 'contact', { entryOpen: false, lastChangedAt: 0 })).toEqual({
      changed: false,
      reason: 'cold-slice',
    })
    // The real state, hours old — the FIRST sighting, since the placeholder
    // remembered nothing.
    expect(
      g.observe(SENSOR, 'contact', { entryOpen: false, lastChangedAt: STARTED_AT - 24_000_000 }),
    ).toEqual({ changed: false, reason: 'baseline-seeded-inactive' })
  })

  it('passes BOTH edges of a real open/close cycle', () => {
    const g = gate()
    g.observe(SENSOR, 'contact', { entryOpen: false, lastChangedAt: STARTED_AT - 3_600_000 })
    expect(
      g.observe(SENSOR, 'contact', { entryOpen: true, lastChangedAt: STARTED_AT + 60_000 }),
    ).toEqual({ changed: true })
    expect(
      g.observe(SENSOR, 'contact', { entryOpen: false, lastChangedAt: STARTED_AT + 72_000 }),
    ).toEqual({ changed: true })
  })

  it('passes a cap with no boolean level through untouched, every time', () => {
    const g = gate()
    // A doorbell press carries no level — the ARRIVAL is the event. Three in a
    // row must be three markers, not one plus two `no-change`.
    for (let i = 0; i < 3; i++) {
      expect(g.observe(101, 'doorbell', { lastPressedAt: STARTED_AT + i })).toEqual({
        changed: true,
      })
    }
    expect(g.observe(700, 'button', {})).toEqual({ changed: true })
    expect(g.observe(702, 'presence', { state: 'home' })).toEqual({ changed: true })
  })

  // C1 (alarm Phase 2 review): a placeholder `closed` remembered as a baseline
  // turned the real, hours-old `open` into an OPENING after a provider
  // respawn — and on an armed panel, an opening fires the siren.
  it('a placeholder followed by a long-open door is NOT an opening', () => {
    const g = gate()
    expect(g.observe(SENSOR, 'contact', { entryOpen: false, lastChangedAt: 0 })).toEqual({
      changed: false,
      reason: 'cold-slice',
    })
    expect(
      g.observe(SENSOR, 'contact', { entryOpen: true, lastChangedAt: STARTED_AT - 3_600_000 }),
    ).toEqual({ changed: false, reason: 'baseline-seeded-stale-active' })
  })

  it('a placeholder is dropped for a pass-through cap too, and counted', () => {
    let now = STARTED_AT + 60_000
    const g = new SensorTransitionGate({ startedAtMs: STARTED_AT, now: () => now })
    expect(g.observe(SENSOR, 'presence', { state: 'home', lastChangedAt: 0 })).toEqual({
      changed: false,
      reason: 'cold-slice',
    })
    now += 700_000
    expect(g.takeDropSummary(now)).toEqual([
      { deviceId: SENSOR, capName: 'presence', reason: 'cold-slice', count: 1 },
    ])
  })

  it('a first sighting that is already OPEN needs a fresh upstream transition', () => {
    // Hydration of a door that has been open for hours — errs towards silence
    // and says so, rather than inventing an opening at restart time.
    expect(
      gate().observe(SENSOR, 'contact', { entryOpen: true, lastChangedAt: STARTED_AT - 3_600_000 }),
    ).toEqual({ changed: false, reason: 'baseline-seeded-stale-active' })
    // A door that opened WHILE we were watching, seconds ago, is a real rise
    // even though it is the first slice this process ever saw.
    expect(
      gate().observe(SENSOR, 'contact', { entryOpen: true, lastChangedAt: STARTED_AT + 50_000 }),
    ).toEqual({ changed: true })
  })

  it('keeps the per-(device, cap) memories apart', () => {
    const g = gate()
    g.observe(SENSOR, 'contact', { entryOpen: false, lastChangedAt: STARTED_AT })
    // A DIFFERENT sensor's first `false` is its own baseline, not 4131's.
    expect(g.observe(9999, 'contact', { entryOpen: false, lastChangedAt: STARTED_AT })).toEqual({
      changed: false,
      reason: 'baseline-seeded-inactive',
    })
    // A different cap on the SAME device likewise.
    expect(
      g.observe(SENSOR, 'tamper', { tampered: true, lastChangedAt: STARTED_AT + 59_000 }),
    ).toEqual({ changed: true })
  })

  it('refuses a source cap whose slice carries no boolean, and does not remember it', () => {
    const g = gate()
    expect(g.observe(SENSOR, 'contact', {})).toEqual({
      changed: false,
      reason: 'non-boolean-value',
    })
    // The memory is untouched, so the next real slice is still a first sighting.
    expect(g.observe(SENSOR, 'contact', { entryOpen: false, lastChangedAt: STARTED_AT })).toEqual({
      changed: false,
      reason: 'baseline-seeded-inactive',
    })
  })
})

describe('SensorTransitionGate — the drop summary', () => {
  it('summarises per (device, cap, reason) and flushes once per window', () => {
    let now = STARTED_AT
    const g = new SensorTransitionGate({
      startedAtMs: STARTED_AT,
      now: () => now,
      summaryWindowMs: 600_000,
    })
    // Camera motion churn: the flood this must never log line-by-line.
    for (let i = 0; i < 500; i++) {
      now += 1_000
      g.observe(101, 'motion', { detected: false, lastDetectedAt: STARTED_AT })
    }
    // Nothing flushed yet — still inside the first window? No: 500 s of ticks
    // is inside 600 s, so the window is still open.
    expect(g.takeDropSummary(now)).toEqual([])
    now += 200_000
    const flushed = g.takeDropSummary(now)
    expect(flushed).toEqual([
      { deviceId: 101, capName: 'motion', reason: 'baseline-seeded-inactive', count: 1 },
      { deviceId: 101, capName: 'motion', reason: 'no-change', count: 499 },
    ])
    // Draining resets the window and the counters.
    expect(g.takeDropSummary(now)).toEqual([])
  })
})

/**
 * A cover is a LEVEL, but its level is a state WORD (`open`, `opening`, …),
 * not a boolean — and its slice also carries `position`, which ticks all the
 * way through a travel. Passing it through as "arrival is the event" would
 * write a row per linked camera, and an NC evaluation, for every tick and for
 * every same-state republish. Only a change of the word is a transition.
 */
describe('SensorTransitionGate — a cover transitions on its state word', () => {
  const COVER = 812
  const slice = (state: string, position: number | null): Record<string, unknown> => ({
    state,
    position,
    tiltPosition: null,
    lastChangedAt: STARTED_AT + 1_000,
  })

  it('opening → open is two events', () => {
    const g = gate()
    expect(g.observe(COVER, 'cover', slice('closed', 0))).toEqual({
      changed: false,
      reason: 'baseline-seeded-inactive',
    })
    expect(g.observe(COVER, 'cover', slice('opening', 5))).toEqual({ changed: true })
    expect(g.observe(COVER, 'cover', slice('open', 100))).toEqual({ changed: true })
  })

  it('a position-only update is no event', () => {
    const g = gate()
    g.observe(COVER, 'cover', slice('closed', 0))
    g.observe(COVER, 'cover', slice('opening', 5))
    expect(g.observe(COVER, 'cover', slice('opening', 40))).toEqual({
      changed: false,
      reason: 'no-change',
    })
    expect(g.observe(COVER, 'cover', slice('opening', 75))).toEqual({
      changed: false,
      reason: 'no-change',
    })
  })

  it('a same-state republish is no event, and is counted in the drop summary', () => {
    let now = STARTED_AT + 60_000
    const g = new SensorTransitionGate({ startedAtMs: STARTED_AT, now: () => now })
    g.observe(COVER, 'cover', slice('open', 100))
    expect(g.observe(COVER, 'cover', slice('open', 100))).toEqual({
      changed: false,
      reason: 'no-change',
    })
    now += 700_000
    expect(g.takeDropSummary(now)).toEqual([
      { deviceId: COVER, capName: 'cover', reason: 'baseline-seeded-stale-active', count: 1 },
      { deviceId: COVER, capName: 'cover', reason: 'no-change', count: 1 },
    ])
  })

  // FIRST SIGHTING — the boolean kinds' rule, on the word. After a runner
  // respawn the gate's memory is empty and the next slice is usually the next
  // REAL change: on a two-word cover (Velux, HA: closed/open only) seeding
  // and dropping it would lose the whole opening.
  it('a fresh first-sighting `open` after the gate started is an event', () => {
    const now = STARTED_AT + 60_000
    const g = new SensorTransitionGate({ startedAtMs: STARTED_AT, now: () => now })
    expect(
      g.observe(COVER, 'cover', {
        state: 'open',
        position: 100,
        tiltPosition: null,
        lastChangedAt: now - 2_000,
      }),
    ).toEqual({ changed: true })
  })

  it('a stale first-sighting `open` (changed before the gate started) is seeded and dropped', () => {
    const g = gate()
    expect(
      g.observe(COVER, 'cover', {
        state: 'open',
        position: 100,
        tiltPosition: null,
        lastChangedAt: STARTED_AT - 3_600_000,
      }),
    ).toEqual({ changed: false, reason: 'baseline-seeded-stale-active' })
  })

  it('a first-sighting `closed` is seeded and dropped, however fresh', () => {
    const now = STARTED_AT + 60_000
    const g = new SensorTransitionGate({ startedAtMs: STARTED_AT, now: () => now })
    expect(
      g.observe(COVER, 'cover', {
        state: 'closed',
        position: 0,
        tiltPosition: null,
        lastChangedAt: now - 1_000,
      }),
    ).toEqual({ changed: false, reason: 'baseline-seeded-inactive' })
  })

  it('a placeholder `closed` then the real, long-open cover is NOT an opening', () => {
    const g = gate()
    expect(
      g.observe(COVER, 'cover', {
        state: 'closed',
        position: 0,
        tiltPosition: null,
        lastChangedAt: 0,
      }),
    ).toEqual({ changed: false, reason: 'cold-slice' })
    expect(
      g.observe(COVER, 'cover', {
        state: 'open',
        position: 100,
        tiltPosition: null,
        lastChangedAt: STARTED_AT - 3_600_000,
      }),
    ).toEqual({ changed: false, reason: 'baseline-seeded-stale-active' })
  })

  it('a slice without a state word is dropped, and remembers nothing', () => {
    const g = gate()
    g.observe(COVER, 'cover', slice('closed', 0))
    expect(g.observe(COVER, 'cover', { position: 10 })).toEqual({
      changed: false,
      reason: 'non-word-value',
    })
    expect(g.observe(COVER, 'cover', slice('opening', 10))).toEqual({ changed: true })
  })
})

/**
 * A lock is a level too, on its `state` word with `locked` at rest. It used to
 * pass through, and the placeholder `unlocked` a provider constructor writes
 * after a respawn was an unlock the armed panel could fire on (C1).
 */
describe('SensorTransitionGate — a lock transitions on its state word', () => {
  const LOCK = 901
  const lock = (state: string, lastChangedAt: number): Record<string, unknown> => ({
    state,
    lastChangedAt,
  })

  it('the constructor placeholder `unlocked` is no unlock', () => {
    const g = gate()
    expect(g.observe(LOCK, 'lock-control', lock('unlocked', 0))).toEqual({
      changed: false,
      reason: 'cold-slice',
    })
    // The real state: locked for hours. Seeds, silently.
    expect(g.observe(LOCK, 'lock-control', lock('locked', STARTED_AT - 3_600_000))).toEqual({
      changed: false,
      reason: 'baseline-seeded-inactive',
    })
  })

  it('locked → unlocked → locked is two events; a same-word republish is none', () => {
    const g = gate()
    g.observe(LOCK, 'lock-control', lock('locked', STARTED_AT - 3_600_000))
    expect(g.observe(LOCK, 'lock-control', lock('unlocked', STARTED_AT + 50_000))).toEqual({
      changed: true,
    })
    expect(g.observe(LOCK, 'lock-control', lock('unlocked', STARTED_AT + 55_000))).toEqual({
      changed: false,
      reason: 'no-change',
    })
    expect(g.observe(LOCK, 'lock-control', lock('locked', STARTED_AT + 58_000))).toEqual({
      changed: true,
    })
  })

  it('a first-sighting `unlocked` is an event only when fresh', () => {
    expect(gate().observe(LOCK, 'lock-control', lock('unlocked', STARTED_AT - 3_600_000))).toEqual({
      changed: false,
      reason: 'baseline-seeded-stale-active',
    })
    expect(gate().observe(LOCK, 'lock-control', lock('unlocked', STARTED_AT + 50_000))).toEqual({
      changed: true,
    })
  })

  // A provider that REPLAYS a cached value after a respawn knows the value but
  // not when it changed, and stamps it `1` (epoch + 1 ms): not a placeholder,
  // never fresh (Homematic `HM_SEEDED_CHANGED_AT`). Stamped `now` it cleared
  // the floor, and a lock unlocked for hours became an unlock an armed rule
  // could fire on.
  it('a first-sighting `unlocked` carrying the known-but-old stamp (1) is seeded, not emitted', () => {
    const g = gate()
    expect(g.observe(LOCK, 'lock-control', lock('unlocked', KNOWN_BUT_OLD))).toEqual({
      changed: false,
      reason: 'baseline-seeded-stale-active',
    })
    // …and it IS a baseline: the real lock that follows is a transition.
    expect(g.observe(LOCK, 'lock-control', lock('locked', STARTED_AT + 50_000))).toEqual({
      changed: true,
    })
  })
})
