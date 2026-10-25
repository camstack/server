/**
 * Unit tests for `computeAvSyncSkew` — the pure timeline-math helper that
 * backs the debug-only "av-sync diag" log in the WebRTC session.
 *
 * The A/V lip-sync investigation needs hard numbers, not eyeballing: given the
 * LAST RTP timestamp sent on each track, that track's clock rate, and the
 * wall-clock elapsed since the session was created, the helper converts the
 * RTP timestamps to media-seconds and reports:
 *   - per-track media-time (rtpTs / rate)
 *   - per-track skew = media-time − wall-clock-elapsed (how far the RTP clock
 *     has drifted from real time)
 *   - inter-track skew = audio media-seconds − video media-seconds (the
 *     decisive figure — negative means audio's media clock lags video's, the
 *     suspected "audio plays ~0.5s behind video" symptom)
 *
 * Pure function only — no werift, no timers — so it runs fast and isolated.
 */
import { describe, it, expect } from 'vitest'
import { computeAvSyncSkew, type AvSyncSkewResult } from '../webrtc/session.js'

function bothTracks(r: AvSyncSkewResult): {
  video: NonNullable<AvSyncSkewResult['video']>
  audio: NonNullable<AvSyncSkewResult['audio']>
} {
  if (r.video === null || r.audio === null) {
    throw new Error('expected both tracks in skew result')
  }
  return { video: r.video, audio: r.audio }
}

describe('computeAvSyncSkew', () => {
  it('converts RTP timestamps to media-seconds at the track clock rate', () => {
    const r = computeAvSyncSkew({
      video: { rtpTs: 90_000, rate: 90_000, elapsedMs: 1_000 },
      audio: { rtpTs: 8_000, rate: 8_000, elapsedMs: 1_000 },
    })
    // 90000 ticks at 90kHz = 1.0s; 8000 ticks at 8kHz = 1.0s.
    const { video, audio } = bothTracks(r)
    expect(video.mediaSeconds).toBeCloseTo(1.0, 6)
    expect(audio.mediaSeconds).toBeCloseTo(1.0, 6)
  })

  it('reports zero per-track skew when media-time tracks wall-clock exactly', () => {
    const r = computeAvSyncSkew({
      video: { rtpTs: 90_000 * 5, rate: 90_000, elapsedMs: 5_000 },
      audio: { rtpTs: 8_000 * 5, rate: 8_000, elapsedMs: 5_000 },
    })
    const { video, audio } = bothTracks(r)
    expect(video.skewSeconds).toBeCloseTo(0, 6)
    expect(audio.skewSeconds).toBeCloseTo(0, 6)
    expect(r.interTrackSkewSeconds).toBeCloseTo(0, 6)
  })

  it('reports NEGATIVE inter-track skew when the audio media clock lags video', () => {
    // Video media clock at 10.0s, audio media clock at 9.5s (0.5s behind) —
    // the exact "audio plays ~0.5s behind video" signature.
    const r = computeAvSyncSkew({
      video: { rtpTs: 90_000 * 10, rate: 90_000, elapsedMs: 10_000 },
      audio: { rtpTs: 8_000 * 9.5, rate: 8_000, elapsedMs: 10_000 },
    })
    const { video, audio } = bothTracks(r)
    expect(video.mediaSeconds).toBeCloseTo(10.0, 6)
    expect(audio.mediaSeconds).toBeCloseTo(9.5, 6)
    expect(r.interTrackSkewSeconds).toBeCloseTo(-0.5, 6)
  })

  it('per-track skew is negative when a media clock runs behind wall-clock', () => {
    // 9.5s of media produced in 10s of wall-clock → the clock is 0.5s behind.
    const r = computeAvSyncSkew({
      video: { rtpTs: 90_000 * 9.5, rate: 90_000, elapsedMs: 10_000 },
      audio: { rtpTs: 8_000 * 10, rate: 8_000, elapsedMs: 10_000 },
    })
    const { video, audio } = bothTracks(r)
    expect(video.skewSeconds).toBeCloseTo(-0.5, 6)
    expect(audio.skewSeconds).toBeCloseTo(0, 6)
  })

  it('handles a missing track (null) by reporting null for that track', () => {
    const r = computeAvSyncSkew({
      video: { rtpTs: 90_000, rate: 90_000, elapsedMs: 1_000 },
      audio: null,
    })
    if (r.video === null) throw new Error('expected video track')
    expect(r.video.mediaSeconds).toBeCloseTo(1.0, 6)
    expect(r.audio).toBeNull()
    // Inter-track skew is undefined when one track is absent.
    expect(r.interTrackSkewSeconds).toBeNull()
  })

  it('returns null media for a zero/invalid clock rate instead of dividing by zero', () => {
    const r = computeAvSyncSkew({
      video: { rtpTs: 90_000, rate: 0, elapsedMs: 1_000 },
      audio: { rtpTs: 8_000, rate: 8_000, elapsedMs: 1_000 },
    })
    expect(r.video).toBeNull()
    expect(r.interTrackSkewSeconds).toBeNull()
  })
})
