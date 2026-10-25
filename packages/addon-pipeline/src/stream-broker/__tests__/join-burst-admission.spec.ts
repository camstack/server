/**
 * The join-burst bound is a property of the CONSUMER, not of the stream.
 *
 * These assert the decision itself, at the seam that makes it. The integration
 * proof — a real `RtspRestreamer` with real sessions over a 4 000 ms GOP —
 * lives in `rtsp-detection-intent-prime.spec.ts`; this file pins the rule in
 * isolation so a regression names the case rather than a packet count.
 *
 * The fleet measurement this encodes: 100-frame GOPs at 25 fps = a 4 000 ms IDR
 * interval, against a fixed 2 000 ms bound. A burst's span at join is the time
 * since the last IDR, uniform in `[0, IDR]`, so detection was withheld on
 * roughly half its dials — measured 44-61 % served over 6 h.
 */
import { describe, expect, it } from 'vitest'
import { admitJoinBurst } from '../rtsp/join-burst-admission.js'
import type { PrimeBurstBound } from '../rtsp/rtsp-restreamer.js'

/** The shipped bound: `joinBurstMaxSpanMs` 2000, `PRIME_MAX_PACKETS` 2000. */
const BOUND: PrimeBurstBound = { maxSpanMs: 2000, maxPackets: 2000 }
const LIVE_EDGE_MS = 500

/** Mid-GOP join on a 4 000 ms-IDR camera — the case that was withheld ~half the time. */
const OVER_SPAN_MS = 3000

describe('admitJoinBurst — who may take the burst', () => {
  it('SERVES a detection decode a burst wider than the span bound', () => {
    expect(
      admitJoinBurst({
        liveEdgeOnly: false,
        detectionIntent: true,
        fromRing: true,
        spanMs: OVER_SPAN_MS,
        packets: 400,
        bound: BOUND,
        liveEdgeMaxSpanMs: LIVE_EDGE_MS,
      }),
    ).toBe('none')
  })

  it('WITHHOLDS the same burst from a HomeKit-style muted leg', () => {
    // The re-clocking population the bound was measured for: a 2 996 ms burst
    // became 3 030 ms of controller-visible jitter. Withheld by the live-edge
    // rule, which is stricter still (500 ms) and fires first.
    expect(
      admitJoinBurst({
        liveEdgeOnly: true,
        detectionIntent: false,
        fromRing: true,
        spanMs: OVER_SPAN_MS,
        packets: 400,
        bound: BOUND,
        liveEdgeMaxSpanMs: LIVE_EDGE_MS,
      }),
    ).toBe('live-edge')
  })

  it('WITHHOLDS it from a SENTRY leg too — which is not muted at all (D525)', () => {
    // The reason this input stopped being `isMuted()`. A sentry is the same
    // ffmpeg-copy re-clocking shape as the HomeKit leg above, and since it
    // carries the camera's audio it is no longer muted. Asked about the mute,
    // this burst would have been SERVED — a 3 s backlog handed to a consumer
    // that never drains one.
    expect(
      admitJoinBurst({
        liveEdgeOnly: true,
        detectionIntent: false,
        fromRing: true,
        spanMs: OVER_SPAN_MS,
        packets: 400,
        bound: BOUND,
        liveEdgeMaxSpanMs: LIVE_EDGE_MS,
      }),
    ).toBe('live-edge')
  })

  it('WITHHOLDS the same burst from a recording leg (not muted, so the span bound is what binds)', () => {
    expect(
      admitJoinBurst({
        liveEdgeOnly: false,
        detectionIntent: false,
        fromRing: true,
        spanMs: OVER_SPAN_MS,
        packets: 400,
        bound: BOUND,
        liveEdgeMaxSpanMs: LIVE_EDGE_MS,
      }),
    ).toBe('span')
  })

  it('keeps the PACKET backstop over a detection decode — the exemption is span-only', () => {
    // `maxPackets` is not a tuning knob: it catches a stream whose RTP
    // timestamps stopped describing it (wrap, a repeated timestamp, an
    // all-intra latch that never closed). In exactly those cases `spanMs` is
    // meaningless, so a span-only exemption must not become an unbounded one.
    expect(
      admitJoinBurst({
        liveEdgeOnly: false,
        detectionIntent: true,
        fromRing: true,
        spanMs: 10,
        packets: BOUND.maxPackets + 1,
        bound: BOUND,
        liveEdgeMaxSpanMs: LIVE_EDGE_MS,
      }),
    ).toBe('packets')
  })

  it('withholds a keyframe-only prime from a plain muted leg, and still serves detection', () => {
    // `!fromRing` is the degenerate fallback — a lone, possibly stale AU.
    const base = {
      fromRing: false,
      spanMs: 0,
      packets: 12,
      bound: BOUND,
      liveEdgeMaxSpanMs: LIVE_EDGE_MS,
    }
    expect(admitJoinBurst({ ...base, liveEdgeOnly: true, detectionIntent: false })).toBe(
      'live-edge',
    )
    expect(admitJoinBurst({ ...base, liveEdgeOnly: false, detectionIntent: true })).toBe('none')
  })

  it('serves a near-live muted leg, unchanged', () => {
    expect(
      admitJoinBurst({
        liveEdgeOnly: true,
        detectionIntent: false,
        fromRing: true,
        spanMs: LIVE_EDGE_MS - 1,
        packets: 20,
        bound: BOUND,
        liveEdgeMaxSpanMs: LIVE_EDGE_MS,
      }),
    ).toBe('none')
  })

  it('counts a burst that breaches BOTH bounds as a span withhold, not a packet one', () => {
    // Precedence preserved from the code this replaced. `primeWithheldSpanMs`
    // is the counter read per camera to decide whether a stream's bound needs
    // raising; silently re-attributing it to the packet backstop would answer
    // a different question.
    expect(
      admitJoinBurst({
        liveEdgeOnly: false,
        detectionIntent: false,
        fromRing: true,
        spanMs: OVER_SPAN_MS,
        packets: BOUND.maxPackets + 1,
        bound: BOUND,
        liveEdgeMaxSpanMs: LIVE_EDGE_MS,
      }),
    ).toBe('span')
  })
})
