/**
 * How long a tile waits before asking again — and when it stops asking.
 *
 * The shape of the problem, measured on the live hub (592, 2026-09-20): one
 * page paints 60 tiles, the provider serves ONE CoverPreview in flight per
 * host behind a 16-deep lane, and **43 of the 60 answer `queue-full`**. Those
 * 43 stills are seconds away, so the tile comes back for them.
 *
 * What it must not do is mirror the server's queue on the client, or hammer a
 * one-in-flight lane with 43 synchronised retries. So: a bounded number of
 * asks, exponential, jittered, taking the server's own hint when the server
 * has one — and then a definite end, because a tile that asks for ever is the
 * other way to never show the operator anything.
 */
import { describe, expect, it } from 'vitest'
import {
  planStillRetry,
  STILL_RETRY_ATTEMPTS,
  STILL_RETRY_MAX_WAIT_MS,
} from '../clip-still-retry.js'

/** Jitter pinned to its extremes so the schedule itself is assertable. */
const NO_JITTER = () => 0.5
const LOW = () => 0
const HIGH = () => 1

describe('planStillRetry', () => {
  it('backs off exponentially rather than re-asking at the same rate', () => {
    const waits = [0, 1, 2, 3].map(
      (attempt) => planStillRetry({ attempt, serverHintMs: null, random: NO_JITTER })?.waitMs ?? 0,
    )
    expect(waits).toEqual([...waits].sort((a, b) => a - b))
    expect(new Set(waits).size).toBe(waits.length)
    expect(waits[0]).toBeGreaterThan(0)
  })

  it('STOPS — a tile never asks for ever', () => {
    expect(
      planStillRetry({ attempt: STILL_RETRY_ATTEMPTS, serverHintMs: null, random: NO_JITTER }),
    ).toBeNull()
    expect(
      planStillRetry({ attempt: STILL_RETRY_ATTEMPTS + 5, serverHintMs: null, random: NO_JITTER }),
    ).toBeNull()
  })

  it('takes the server’s hint when the server knows better than the curve', () => {
    // The queue measured its own depth; on the first attempt the curve has not
    // caught up with it yet.
    const plan = planStillRetry({ attempt: 0, serverHintMs: 16_000, random: NO_JITTER })
    expect(plan?.waitMs).toBeGreaterThanOrEqual(16_000)
  })

  it('never lets a hint drop the wait BELOW the client’s own floor', () => {
    // A provider that answers `retry-after: 1` for 43 tiles at once would get
    // 43 requests a second. The client's curve is the floor, always.
    const withHint = planStillRetry({ attempt: 2, serverHintMs: 100, random: NO_JITTER })
    const without = planStillRetry({ attempt: 2, serverHintMs: null, random: NO_JITTER })
    expect(withHint?.waitMs).toBe(without?.waitMs)
  })

  it('caps a single wait, however large the hint', () => {
    const plan = planStillRetry({ attempt: 0, serverHintMs: 10 * 60_000, random: NO_JITTER })
    expect(plan?.waitMs).toBeLessThanOrEqual(STILL_RETRY_MAX_WAIT_MS)
  })

  it('JITTERS, so 43 tiles refused together do not come back together', () => {
    const low = planStillRetry({ attempt: 1, serverHintMs: null, random: LOW })?.waitMs ?? 0
    const high = planStillRetry({ attempt: 1, serverHintMs: null, random: HIGH })?.waitMs ?? 0
    expect(high).toBeGreaterThan(low)
    // Spread wide enough to matter, bounded enough to stay a schedule.
    expect(high / low).toBeGreaterThan(1.2)
    expect(high / low).toBeLessThan(2.5)
  })

  it('gives the whole page long enough to drain a 60-deep first paint', () => {
    // 60 tiles, one mint in flight per host: the tail tile is ~60 mints away.
    // The budget has to outlast that or the retry is theatre.
    const total = Array.from({ length: STILL_RETRY_ATTEMPTS }, (_, attempt) =>
      planStillRetry({ attempt, serverHintMs: null, random: NO_JITTER }),
    ).reduce((sum, plan) => sum + (plan?.waitMs ?? 0), 0)
    expect(total).toBeGreaterThan(45_000)
  })
})
