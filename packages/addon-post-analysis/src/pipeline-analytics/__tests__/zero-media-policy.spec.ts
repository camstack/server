import { describe, it, expect } from 'vitest'
import {
  decideZeroMediaPolicy,
  ZERO_MEDIA_SUPPRESS_MAX_DURATION_MS,
  ZERO_MEDIA_NOTHING_TO_SHOW_MAX_DURATION_MS,
  DEFAULT_ZERO_MEDIA_POLICY_CONFIG,
  type ZeroMediaPolicyInput,
} from '../zero-media-policy.js'

const base = (over: Partial<ZeroMediaPolicyInput> = {}): ZeroMediaPolicyInput => ({
  durationMs: 5_000,
  hasMedia: false,
  hasBestMedia: false,
  confirmed: false,
  hasRasterFallback: false,
  ...over,
})

describe('decideZeroMediaPolicy', () => {
  it('persists untouched when the track already has media', () => {
    // Even an ultra-short, never-confirmed track is left alone once it owns media.
    expect(decideZeroMediaPolicy(base({ hasMedia: true, durationMs: 100 }))).toBe('persist')
  })

  it('suppresses an ultra-short, never-confirmed, zero-media track (false birth)', () => {
    expect(
      decideZeroMediaPolicy(base({ durationMs: 300, confirmed: false, hasMedia: false })),
    ).toBe('suppress')
  })

  it('keeps a confirmed short zero-media track only when it has SOMETHING to show', () => {
    // Confirmed short zero-media track WITH a raster fallback: keep it.
    expect(
      decideZeroMediaPolicy(base({ durationMs: 300, confirmed: true, hasRasterFallback: true })),
    ).toBe('raster-fallback')
    // 2026-07-22 revision: confirmed but NOTHING to render (no media, no
    // raster) and short-lived → an empty gallery row → suppress. (`confirmed`
    // fires within a few hundred ms on low-minHits cameras, so it is no
    // guarantee of a real subject.)
    expect(
      decideZeroMediaPolicy(base({ durationMs: 300, confirmed: true, hasRasterFallback: false })),
    ).toBe('suppress')
  })

  it('does NOT suppress a LONGER zero-media track even when never confirmed', () => {
    expect(
      decideZeroMediaPolicy(base({ durationMs: 5_000, confirmed: false, hasRasterFallback: true })),
    ).toBe('raster-fallback')
    expect(
      decideZeroMediaPolicy(
        base({ durationMs: 5_000, confirmed: false, hasRasterFallback: false }),
      ),
    ).toBe('persist')
  })

  it('treats the thresholds as exclusive floors', () => {
    // At the ultra-short threshold the FIRST rule no longer applies, but the
    // 2026-07-22 nothing-to-show rule (< 1.5s, no media, no raster) still
    // suppresses the empty row.
    const atThreshold = base({
      durationMs: ZERO_MEDIA_SUPPRESS_MAX_DURATION_MS,
      confirmed: false,
    })
    expect(decideZeroMediaPolicy(atThreshold)).toBe('suppress')
    // At the nothing-to-show threshold nothing suppresses anymore.
    const atNothingToShow = base({
      durationMs: ZERO_MEDIA_NOTHING_TO_SHOW_MAX_DURATION_MS,
      confirmed: false,
    })
    expect(decideZeroMediaPolicy(atNothingToShow)).toBe('persist')
    const justBelow = base({
      durationMs: ZERO_MEDIA_SUPPRESS_MAX_DURATION_MS - 1,
      confirmed: false,
    })
    expect(decideZeroMediaPolicy(justBelow)).toBe('suppress')
  })

  it('prefers the raster fallback over a bare persist for a kept zero-media track', () => {
    expect(decideZeroMediaPolicy(base({ durationMs: 10_000, hasRasterFallback: true }))).toBe(
      'raster-fallback',
    )
  })

  it('FIX B: a CONFIRMED zero-media track with a retained raster fallback always commits it (thumbnail at close)', () => {
    // The widened retention (dispatcher) guarantees any confirmed track that was
    // observed on a handled frame carries a raster fallback. At close the policy
    // must then choose `raster-fallback` (→ thumbnail put) rather than leaving a
    // blank reel tile — for BOTH an ultra-short and a long confirmed track.
    expect(
      decideZeroMediaPolicy(base({ durationMs: 200, confirmed: true, hasRasterFallback: true })),
    ).toBe('raster-fallback')
    expect(
      decideZeroMediaPolicy(base({ durationMs: 30_000, confirmed: true, hasRasterFallback: true })),
    ).toBe('raster-fallback')
  })

  it('honours a custom suppression threshold', () => {
    expect(
      decideZeroMediaPolicy(base({ durationMs: 1_500, confirmed: false }), {
        ...DEFAULT_ZERO_MEDIA_POLICY_CONFIG,
        suppressMaxDurationMs: 2_000,
      }),
    ).toBe('suppress')
  })

  it('default config exposes the named 1s threshold', () => {
    expect(DEFAULT_ZERO_MEDIA_POLICY_CONFIG.suppressMaxDurationMs).toBe(
      ZERO_MEDIA_SUPPRESS_MAX_DURATION_MS,
    )
    expect(ZERO_MEDIA_SUPPRESS_MAX_DURATION_MS).toBe(1_000)
  })
})

// ── 2026-07-31: media WITHOUT a best shot ────────────────────────────────────
describe('decideZeroMediaPolicy — media but no best shot', () => {
  it('spends the raster on a track that has frames but NO best shot (fd12a3ec)', () => {
    // The reported case: 13.4 s, 60 positions, firstFrame + snapshot + lastFrame
    // persisted, no thumbnail and no keyFrame — the native lease missed and the
    // capture was still queued for retry when the track died.
    expect(
      decideZeroMediaPolicy(
        base({ durationMs: 13_400, hasMedia: true, confirmed: true, hasRasterFallback: true }),
      ),
    ).toBe('raster-fallback')
  })

  it('leaves a track with a real best shot completely alone', () => {
    // The raster is strictly worse than a native crop — it must never overwrite one.
    expect(
      decideZeroMediaPolicy(
        base({ durationMs: 13_400, hasMedia: true, hasBestMedia: true, hasRasterFallback: true }),
      ),
    ).toBe('persist')
  })

  it('counts a bare keyFrame as a best shot — the derived tile beats the raster', () => {
    // track-close passes hasBestMedia for `thumbnail` OR `keyFrame`, because the
    // keyFrame-derived tile that runs later is native-resolution.
    expect(
      decideZeroMediaPolicy(base({ hasMedia: true, hasBestMedia: true, hasRasterFallback: true })),
    ).toBe('persist')
  })

  it('NEVER suppresses a track that owns media, however short (290d70ee)', () => {
    // 3.6 s and 1.7 s tracks with only a first frame: real subjects, kept even
    // with no raster retained to spend.
    for (const durationMs of [3_600, 1_700, 200]) {
      expect(
        decideZeroMediaPolicy(base({ durationMs, hasMedia: true, hasRasterFallback: false })),
      ).toBe('persist')
    }
  })
})

// ── 2026-07-22: nothing-to-show suppression is confirmation-independent ──────
describe('decideZeroMediaPolicy nothing-to-show rule', () => {
  it('suppresses a short CONFIRMED zero-media track with no raster (empty row)', () => {
    // f969edaf replay: 454ms person, minHits confirmed it, nothing to render.
    expect(
      decideZeroMediaPolicy({
        durationMs: 454,
        hasMedia: false,
        hasBestMedia: false,
        confirmed: true,
        hasRasterFallback: false,
      }),
    ).toBe('suppress')
  })

  it('keeps a short confirmed zero-media track WITH a raster fallback', () => {
    expect(
      decideZeroMediaPolicy({
        durationMs: 900,
        hasMedia: false,
        hasBestMedia: false,
        confirmed: true,
        hasRasterFallback: true,
      }),
    ).toBe('raster-fallback')
  })

  it('keeps a LONG zero-media track even with nothing to show', () => {
    expect(
      decideZeroMediaPolicy({
        durationMs: 3_765,
        hasMedia: false,
        hasBestMedia: false,
        confirmed: true,
        hasRasterFallback: false,
      }),
    ).toBe('persist')
  })
})
