import { describe, expect, it } from 'vitest'
import {
  JOIN_BURST_MAX_SPAN_LIMIT_MS,
  JOIN_BURST_MIN_SPAN_MS,
  resolveJoinBurstBound,
} from '../rtsp/join-burst-bound.js'
import { DEFAULT_PRIME_BURST_BOUND, PRIME_MAX_PACKETS } from '../rtsp/rtsp-restreamer.js'

/**
 * Precedence and validation for the join-burst bound.
 *
 * The value arrives from two operator surfaces that can each be absent, stale
 * or nonsense: a cluster-wide default in the stream-broker addon's global
 * settings, and a per-camera-stream override in `DeviceOverride`. This resolver
 * is the single place the two are combined, so it is also the single place that
 * has to refuse a value that would disable the bound entirely — a `0` from a
 * cleared number input must mean "inherit", never "withhold every burst".
 */
describe('resolveJoinBurstBound', () => {
  it('falls back to the D57 default with nothing configured', () => {
    expect(resolveJoinBurstBound({ camStreamId: 'native:main' })).toEqual(DEFAULT_PRIME_BURST_BOUND)
  })

  it('uses the cluster default when the stream has no override', () => {
    expect(resolveJoinBurstBound({ camStreamId: 'native:main', clusterMaxSpanMs: 2500 })).toEqual({
      maxSpanMs: 2500,
      maxPackets: PRIME_MAX_PACKETS,
    })
  })

  it('lets a camera stream override the cluster default', () => {
    // The 4 s-GOP camera: its IDR interval makes the cluster value unreachable.
    expect(
      resolveJoinBurstBound({
        camStreamId: 'native:main',
        clusterMaxSpanMs: 2000,
        overrides: { 'native:main': 4500 },
      }),
    ).toEqual({ maxSpanMs: 4500, maxPackets: PRIME_MAX_PACKETS })
  })

  it('scopes the override to its own camera stream', () => {
    // Overrides are keyed by camStreamId because IDR interval is a property of
    // the ENCODER, and a camera's sub-stream routinely runs a different GOP
    // from its main. A per-device value would mis-tune one of them.
    const overrides = { 'native:main': 4500 }
    expect(
      resolveJoinBurstBound({ camStreamId: 'native:sub', clusterMaxSpanMs: 2000, overrides })
        .maxSpanMs,
    ).toBe(2000)
  })

  it('treats 0 / negative / non-finite as "inherit", never as "withhold everything"', () => {
    // A cleared number input posts 0. Passing that through would make every
    // burst wider than 0 ms — i.e. all of them — withheld, and every consumer
    // of that camera would silently start one full IDR interval late.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        resolveJoinBurstBound({
          camStreamId: 'native:main',
          clusterMaxSpanMs: 2000,
          overrides: { 'native:main': bad },
        }).maxSpanMs,
      ).toBe(2000)
      expect(
        resolveJoinBurstBound({ camStreamId: 'native:main', clusterMaxSpanMs: bad }).maxSpanMs,
      ).toBe(DEFAULT_PRIME_BURST_BOUND.maxSpanMs)
    }
  })

  it('clamps a value below the floor rather than accepting it', () => {
    expect(
      resolveJoinBurstBound({
        camStreamId: 'native:main',
        overrides: { 'native:main': 1 },
      }).maxSpanMs,
    ).toBe(JOIN_BURST_MIN_SPAN_MS)
  })

  it('clamps a value above the ceiling rather than accepting it', () => {
    // The ceiling is what stops "configurable" from meaning "D57 can be turned
    // off": the measured population reached 61 535 ms in a single burst.
    expect(
      resolveJoinBurstBound({
        camStreamId: 'native:main',
        overrides: { 'native:main': 120_000 },
      }).maxSpanMs,
    ).toBe(JOIN_BURST_MAX_SPAN_LIMIT_MS)
    expect(JOIN_BURST_MAX_SPAN_LIMIT_MS).toBeLessThan(61_535)
  })

  it('never makes the packet ceiling configurable', () => {
    // `maxPackets` is a defensive backstop against timestamps that stopped
    // describing the stream (wrap, an all-intra latch that never closed) — not
    // a tuning knob. A burst that big is a defect, and no camera's GOP is a
    // reason to raise it.
    expect(
      resolveJoinBurstBound({
        camStreamId: 'native:main',
        clusterMaxSpanMs: 4500,
        overrides: { 'native:main': 4500 },
      }).maxPackets,
    ).toBe(PRIME_MAX_PACKETS)
  })
})
