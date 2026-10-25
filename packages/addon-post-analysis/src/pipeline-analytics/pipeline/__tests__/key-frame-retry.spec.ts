import { describe, expect, it } from 'vitest'
import {
  KEY_FRAME_MAX_RETRIES,
  KEY_FRAME_RETRY_MIN_GAP_MS,
  KEY_FRAME_RETRY_PRIORITY,
  decideKeyFrameCapture,
} from '../key-frame-retry.js'
import { DEFAULT_CAPTURE_PRIORITY } from '../../runtime/capture-scheduler.js'

/**
 * The defect this decides: `keyFrame` fired on `isNewBest` ALONE, and
 * `isNewBest` is a best-frame PEAK signal. Measured on the live hub
 * 2026-08-06, of 102 tracks that logged a native-capture miss, 494 (80%) got
 * exactly ONE attempt in their whole life — the log line said "will retry next
 * best" and for four tracks in five there was no next best. 388 of 542
 * surviving miss-logged tracks (71.6%) ended with no key frame at all, and a
 * track with no key frame can never be re-embedded.
 *
 * The thumbnail beside it has always retried (`isNewBest || !thumbnailLanded`).
 * This brings the key frame to the same rule — BOUNDED, because the hub is
 * saturated and each attempt is a native full-frame fetch at 4096 px.
 */
const base = { landed: false, retries: 0, lastAttemptAt: undefined } as const

describe('decideKeyFrameCapture', () => {
  it('captures on a genuine new best, as it always has', () => {
    const d = decideKeyFrameCapture({
      isNewBest: true,
      plausibleBox: true,
      state: base,
      now: 10_000,
    })
    expect(d.kind).toBe('new-best')
  })

  it('RETRIES when nothing landed and this frame is not a new best (the fix)', () => {
    const d = decideKeyFrameCapture({
      isNewBest: false,
      plausibleBox: true,
      state: { landed: false, retries: 0, lastAttemptAt: 1_000 },
      now: 1_000 + KEY_FRAME_RETRY_MIN_GAP_MS,
    })
    expect(d.kind).toBe('retry')
  })

  it('does not retry once a key frame landed', () => {
    const d = decideKeyFrameCapture({
      isNewBest: false,
      plausibleBox: true,
      state: { landed: true, retries: 0, lastAttemptAt: 1_000 },
      now: 90_000,
    })
    expect(d.kind).toBe('skip')
  })

  it('holds the min gap between retries', () => {
    const state = { landed: false, retries: 1, lastAttemptAt: 1_000 }
    expect(
      decideKeyFrameCapture({
        isNewBest: false,
        plausibleBox: true,
        state,
        now: 1_000 + KEY_FRAME_RETRY_MIN_GAP_MS - 1,
      }).kind,
    ).toBe('skip')
    expect(
      decideKeyFrameCapture({
        isNewBest: false,
        plausibleBox: true,
        state,
        now: 1_000 + KEY_FRAME_RETRY_MIN_GAP_MS,
      }).kind,
    ).toBe('retry')
  })

  it('BOUNDS the retries — the hub is saturated, this is not free', () => {
    const spent = { landed: false, retries: KEY_FRAME_MAX_RETRIES, lastAttemptAt: 1_000 }
    expect(
      decideKeyFrameCapture({ isNewBest: false, plausibleBox: true, state: spent, now: 900_000 })
        .kind,
    ).toBe('skip')
  })

  it('a genuine new best is NOT charged against the retry budget', () => {
    // The peak signal is already hysteresis- and rate-limited; the budget
    // exists to bound the NEW per-frame path, not to cap the old one.
    const spent = { landed: false, retries: KEY_FRAME_MAX_RETRIES, lastAttemptAt: 1_000 }
    expect(
      decideKeyFrameCapture({ isNewBest: true, plausibleBox: true, state: spent, now: 900_000 })
        .kind,
    ).toBe('new-best')
  })

  it('an implausible box blocks BOTH paths — a retry must never lock in a void tile', () => {
    expect(
      decideKeyFrameCapture({ isNewBest: true, plausibleBox: false, state: base, now: 10_000 })
        .kind,
    ).toBe('skip')
    expect(
      decideKeyFrameCapture({
        isNewBest: false,
        plausibleBox: false,
        state: { landed: false, retries: 0, lastAttemptAt: 1_000 },
        now: 900_000,
      }).kind,
    ).toBe('skip')
  })

  it('the FIRST retry needs no gap when nothing was ever attempted', () => {
    const d = decideKeyFrameCapture({
      isNewBest: false,
      plausibleBox: true,
      state: base,
      now: 10_000,
    })
    expect(d.kind).toBe('retry')
  })
})

describe('KEY_FRAME_RETRY_PRIORITY', () => {
  it('ranks BELOW the tier-1 key frame, so a retry never displaces live media', () => {
    expect(KEY_FRAME_RETRY_PRIORITY).toBeGreaterThan(DEFAULT_CAPTURE_PRIORITY.keyFrame)
    expect(KEY_FRAME_RETRY_PRIORITY).toBeGreaterThan(DEFAULT_CAPTURE_PRIORITY.thumbnail)
  })

  it('still ranks above enrichment — a re-embeddable track beats a gallery tile', () => {
    expect(KEY_FRAME_RETRY_PRIORITY).toBeLessThan(DEFAULT_CAPTURE_PRIORITY.embed)
  })
})
