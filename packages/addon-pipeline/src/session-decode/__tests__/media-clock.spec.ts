/**
 * The clock that lets a PRE-ROLL frame say when it was actually shot.
 *
 * Everything in the session-decode path stamps `Date.now()` — the worker
 * (`decode-worker-child.ts` publish) and the pump (`toDecodedFrame`). For a
 * live frame that is right to within the decode latency. For a frame
 * reconstructed out of 4 s of retained history it is wrong by up to 4 s, and a
 * detection carrying it would put a track's `firstSeen` at session open rather
 * than at the moment the subject was there — which is worse than the late
 * birth this whole change exists to fix.
 */
import { describe, expect, it } from 'vitest'
import { anchorMediaClock, mediaWallClockOf, ptsToMs } from '../media-clock.js'

describe('ptsToMs', () => {
  it('converts a 90 kHz RTP pts to milliseconds', () => {
    expect(ptsToMs(90_000n, { num: 1, den: 90_000 })).toBe(1000)
    expect(ptsToMs(45_000n, { num: 1, den: 90_000 })).toBe(500)
  })

  it('converts a frame-rate time base', () => {
    expect(ptsToMs(30n, { num: 1, den: 30 })).toBe(1000)
  })

  it('returns null for a time base that cannot describe a duration', () => {
    expect(ptsToMs(1n, { num: 0, den: 90_000 })).toBeNull()
    expect(ptsToMs(1n, { num: 1, den: 0 })).toBeNull()
  })
})

describe('anchorMediaClock', () => {
  it('places the first decoded frame `preRollMs` in the PAST', () => {
    // The restreamer served 3994 ms of history, so the first packet the decoder
    // saw is ~4 s old — not "now".
    const anchor = anchorMediaClock({
      firstPtsMs: 1000,
      preRollMs: 3994,
      nowWall: 1_788_900_486_000,
    })
    expect(anchor.wallAtFirstPts).toBe(1_788_900_486_000 - 3994)
    expect(anchor.firstPtsMs).toBe(1000)
  })

  it('degrades to "the first frame is now" when no history was served', () => {
    const anchor = anchorMediaClock({ firstPtsMs: 7, preRollMs: 0, nowWall: 5000 })
    expect(anchor.wallAtFirstPts).toBe(5000)
  })
})

describe('mediaWallClockOf', () => {
  const anchor = anchorMediaClock({
    firstPtsMs: 1000,
    preRollMs: 4000,
    nowWall: 1_788_900_486_000,
  })

  it('carries the frame OWN moment, not the moment it was decoded', () => {
    // 1.5 s of media after the first retained frame → 2.5 s before now.
    expect(mediaWallClockOf(anchor, 2500, 1_788_900_486_100)).toBe(1_788_900_486_000 - 2500)
  })

  it('never dates a frame in the FUTURE', () => {
    // A pts that runs past the anchor (clock jump, a container whose pts is not
    // wall-clock-shaped) must not produce a track that starts after now — a
    // future timestamp is the one failure worse than the bug being fixed.
    const now = 1_788_900_486_100
    expect(mediaWallClockOf(anchor, 999_000, now)).toBe(now)
  })

  it('is monotone in pts', () => {
    const a = mediaWallClockOf(anchor, 1200, 1_788_900_490_000)
    const b = mediaWallClockOf(anchor, 1300, 1_788_900_490_000)
    expect(b).toBeGreaterThan(a)
  })
})

// ── The anchor is per DIAL, not per worker (2026-09-09) ────────────────────
//
// Measured on `agent-a`, camera 111, 14:52: a detach/attach REUSED the
// warm decode worker (`reusing the warm detection decode worker (no re-fork)`),
// the worker re-dialed (`SPS parse from SDP extradata` at 14:52:49, dialAgeMs
// 247 041 on the previous dial), and the NEW dial's pts restarted near zero.
// The anchor from the first dial survived on the worker object, so every
// frame of the new dial was dated `wallAtFirstPts(old) + ~0`: `pipeline stats`
// reported `frameAge.avg 268 655 ms` — constant, not growing — for the rest of
// the session, and `pipeline-analytics frame lag` `captureLagMaxMs=271 374`.
// A wrong timestamp is silent, which is why this module exists; a re-dial is
// a new pts epoch and must be a new anchor.
import { mediaClockForDial } from '../media-clock.js'

describe('mediaClockForDial', () => {
  const W = 1_788_957_900_000 // 14:45:00 local, the first dial

  it('keeps the anchor for frames of the SAME dial', () => {
    const first = mediaClockForDial(null, 1, { firstPtsMs: 5000, preRollMs: 0, nowWall: W })
    const again = mediaClockForDial(first, 1, { firstPtsMs: 9000, preRollMs: 0, nowWall: W + 4000 })
    expect(again).toBe(first)
    expect(mediaWallClockOf(again.anchor, 9000, W + 4000)).toBe(W + 4000)
  })

  it('re-anchors on a NEW dial: the measured 268 s back-dating does not happen', () => {
    const first = mediaClockForDial(null, 1, { firstPtsMs: 5000, preRollMs: 0, nowWall: W })
    // 268 s later the worker re-dials and the new stream's pts restarts at 0.
    const redialWall = W + 268_655
    const second = mediaClockForDial(first, 2, { firstPtsMs: 0, preRollMs: 0, nowWall: redialWall })
    expect(second).not.toBe(first)
    expect(second.dialSeq).toBe(2)
    // The first frame of the new dial is NOW, not 268 s ago…
    expect(mediaWallClockOf(second.anchor, 0, redialWall)).toBe(redialWall)
    // …and the next frame of the new dial advances from there.
    expect(mediaWallClockOf(second.anchor, 100, redialWall + 100)).toBe(redialWall + 100)
    // With the OLD anchor the same frame would have carried the defect.
    expect(mediaWallClockOf(first.anchor, 0, redialWall)).toBe(W - 5000)
  })
})
