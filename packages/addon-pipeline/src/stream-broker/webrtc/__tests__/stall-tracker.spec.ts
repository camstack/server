import { describe, it, expect } from 'vitest'
import { StallTracker, buildStallSample, type StallSample } from '../stall-tracker.js'
import { ADAPTIVE_CONFIG } from '../adaptive-config.js'

/** The production numbers — the tracker is tested against what ships. */
const CONFIG = ADAPTIVE_CONFIG

const TICK = 2_000

/** A window in which the client received `received` of the `sent` kbps. */
function win(received: number, sent: number, serverSending = true): StallSample {
  return {
    delivery: { receivedKbps: received, sentKbps: sent, windowMs: 4_000 },
    recent: { receivedKbps: received, sentKbps: sent, windowMs: 2_000 },
    clientReporting: true,
    telemetryShared: false,
    serverSending,
  }
}

/** A GOP window and the newest 2 s report, judged separately. */
function split(gop: [number, number], recent: [number, number]): StallSample {
  return {
    delivery: { receivedKbps: gop[0], sentKbps: gop[1], windowMs: 6_000 },
    recent: { receivedKbps: recent[0], sentKbps: recent[1], windowMs: 2_000 },
    clientReporting: true,
    telemetryShared: false,
    serverSending: true,
  }
}

const UNKNOWN: StallSample = {
  delivery: null,
  recent: null,
  clientReporting: false,
  telemetryShared: false,
  serverSending: true,
}

/** Feed `count` evaluations of `sample`, starting at `from`. Returns the clock. */
function feed(tracker: StallTracker, from: number, count: number, sample: StallSample): number {
  let now = from
  for (let i = 0; i < count; i += 1) {
    tracker.observe(sample, now)
    now += TICK
  }
  return now - TICK
}

describe('StallTracker — judged on DELIVERY, relative to what the rung sends', () => {
  it('a fully delivered rung never reads stalled and is climb-safe, however low its bitrate', () => {
    const t = new StallTracker(CONFIG)
    // 41 kbps sent, 40 received: the device-104 sub stream, whole.
    const now = feed(t, 0, 30, win(40, 41))
    expect(t.isStalled(now)).toBe(false)
    expect(t.climbSafety(now)).toEqual({ safe: true })
  })

  it('declares a stall only after stallConfirmMs of the client receiving ≪ what was sent', () => {
    const t = new StallTracker(CONFIG)
    let now = feed(t, 0, 3, win(5, 800))
    expect(now).toBe(4_000)
    expect(t.isStalled(now)).toBe(false)
    expect(t.climbSafety(now)).toEqual({ safe: false, reason: 'stall-building' })
    now = feed(t, 6_000, 1, win(5, 800))
    expect(t.isStalled(now)).toBe(true)
    const ev = t.evidence(now)
    expect(ev.stalledForMs).toBe(6_000)
    expect(ev.clientKbps).toBe(5)
    expect(ev.sentKbps).toBe(800)
    expect(ev.deliveryRatio).toBeCloseTo(5 / 800, 5)
  })

  /**
   * I3 (review 2026-09-25): a stall used to START only when the whole GOP
   * window read < 25 %, so on a 4 s GOP three zero reports had to pass before
   * the 6 s confirm even began — 12–18 s from freeze to downgrade. A TOTAL
   * freeze is unambiguous on one report.
   */
  it('a total freeze starts the stall on the newest report, while the GOP window still remembers good data', () => {
    const t = new StallTracker(CONFIG)
    t.observe(split([670, 1_000], [0, 1_000]), 0)
    t.observe(split([340, 1_000], [0, 1_000]), 2_000)
    t.observe(split([0, 1_000], [0, 1_000]), 4_000)
    t.observe(split([0, 1_000], [0, 1_000]), 6_000)
    expect(t.isStalled(6_000)).toBe(true)
  })

  it('a report that missed an IDR at its edge is not a freeze (it still carried the P-frames)', () => {
    const t = new StallTracker(CONFIG)
    // 82 kbit of P-frames landed, a 240 kbit IDR sent in the last 50 ms did not.
    const now = feed(t, 0, 5, split([100, 100], [41, 161]))
    expect(t.isStalled(now)).toBe(false)
  })

  it('a report over a near-idle send (< 16 kbps) cannot start a freeze', () => {
    const t = new StallTracker(CONFIG)
    const now = feed(t, 0, 5, split([100, 100], [0, 10]))
    expect(t.isStalled(now)).toBe(false)
  })

  it('a recovered newest report clears a freeze even while the GOP window still holds the zeros', () => {
    const t = new StallTracker(CONFIG)
    let now = feed(t, 0, 2, split([0, 1_000], [0, 1_000]))
    now = feed(t, now + TICK, 1, split([150, 1_000], [980, 1_000]))
    now = feed(t, now + TICK, 2, split([300, 1_000], [0, 1_000]))
    expect(t.isStalled(now)).toBe(false)
  })

  /**
   * I2: the client record is DEVICE-scoped — the last writer wins. With two
   * adaptive sessions of one camera on this broker, a session on `high` reads
   * the `low` viewer's 41 kbps against its own 4 631 kbps sent and would
   * confirm a stall on a healthy picture.
   */
  it('with more than one adaptive session on the device, delivery is unknown — never a stall', () => {
    const t = new StallTracker(CONFIG)
    let now = 0
    for (let i = 0; i < 10; i += 1) {
      t.observe(
        buildStallSample({
          delivery: { receivedKbps: 41, sentKbps: 4_631, windowMs: 4_000 },
          recent: { receivedKbps: 0, sentKbps: 4_631, windowMs: 2_000 },
          clientReporting: true,
          serverSending: true,
          adaptiveSessionsOnDevice: 2,
        }),
        now,
      )
      now += TICK
    }
    expect(t.isStalled(now)).toBe(false)
    expect(t.isTelemetryShared).toBe(true)
    expect(t.evidence(now).deliveryRatio).toBeNull()
    // One session: the same numbers ARE a stall.
    const own = new StallTracker(CONFIG)
    for (let i = 0; i < 5; i += 1) {
      own.observe(
        buildStallSample({
          delivery: { receivedKbps: 41, sentKbps: 4_631, windowMs: 4_000 },
          recent: { receivedKbps: 0, sentKbps: 4_631, windowMs: 2_000 },
          clientReporting: true,
          serverSending: true,
          adaptiveSessionsOnDevice: 1,
        }),
        i * TICK,
      )
    }
    expect(own.isStalled(4 * TICK)).toBe(true)
  })

  it('does not stall when the broker is not sending — an idle feed is not a broken link', () => {
    const t = new StallTracker(CONFIG)
    expect(t.isStalled(feed(t, 0, 10, win(0, 0, false)))).toBe(false)
    const u = new StallTracker(CONFIG)
    // Sent nothing over the window: there is no ratio to judge.
    expect(u.isStalled(feed(u, 0, 10, win(0, 0, true)))).toBe(false)
  })

  it('treats an unknown delivery window as unknown — not a stall, and not a veto on climbing', () => {
    const t = new StallTracker(CONFIG)
    const now = feed(t, 0, 10, UNKNOWN)
    expect(t.isStalled(now)).toBe(false)
    expect(t.climbSafety(now)).toEqual({ safe: true })
    expect(t.evidence(now).deliveryRatio).toBeNull()
  })

  it('a client that IS reporting but has not covered a window yet refuses a climb — "not yet" is not "no telemetry"', () => {
    const t = new StallTracker(CONFIG)
    const now = feed(t, 0, 3, { ...UNKNOWN, clientReporting: true })
    expect(t.isStalled(now)).toBe(false)
    expect(t.climbSafety(now)).toEqual({ safe: false, reason: 'delivery' })
  })

  it('a partially delivered window holds (dead band): no stall, and no climb', () => {
    const t = new StallTracker(CONFIG)
    let now = 0
    for (let i = 0; i < 60; i += 1) {
      // 40 % landed: above the stall ratio (25 %), below recovery (50 %).
      t.observe(win(400, 1_000), now)
      expect(t.isStalled(now)).toBe(false)
      expect(t.climbSafety(now)).toEqual({ safe: false, reason: 'delivery' })
      now += TICK
    }
  })

  it('refuses a climb below the climb ratio even when nothing is stalling', () => {
    const t = new StallTracker(CONFIG)
    const now = feed(t, 0, 5, win(800, 1_000))
    expect(t.isStalled(now)).toBe(false)
    expect(t.climbSafety(now)).toEqual({ safe: false, reason: 'delivery' })
  })

  it('a recovery above the recover ratio clears a building stall', () => {
    const t = new StallTracker(CONFIG)
    let now = feed(t, 0, 2, win(0, 800))
    expect(t.climbSafety(now)).toEqual({ safe: false, reason: 'stall-building' })
    now = feed(t, now + TICK, 1, win(790, 800))
    expect(t.climbSafety(now)).toEqual({ safe: true })
    now = feed(t, now + TICK, 2, win(0, 800))
    expect(t.isStalled(now)).toBe(false)
  })

  it('a ratio inside the dead band does not clear a stall already building', () => {
    const t = new StallTracker(CONFIG)
    let now = feed(t, 0, 2, win(0, 800))
    now = feed(t, now + TICK, 1, win(320, 800))
    now = feed(t, now + TICK, 2, win(0, 800))
    expect(t.isStalled(now)).toBe(true)
  })

  it('a tier change blanks the window so the re-offer’s own dead air cannot cascade', () => {
    const t = new StallTracker(CONFIG)
    let now = feed(t, 0, 4, win(0, 800))
    expect(t.isStalled(now)).toBe(true)
    t.markChanged(now)
    const during = feed(t, now + TICK, 3, win(0, 800))
    expect(during).toBeLessThan(now + CONFIG.waitAfterChangeMs)
    expect(t.isStalled(during)).toBe(false)
    expect(t.climbSafety(during)).toEqual({ safe: true })
  })
})
