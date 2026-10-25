/**
 * What the notification rules ASK a camera's clip ring to hold.
 *
 * The rules are the only thing that knows whether a camera will ever deliver
 * footage, and on the live hub most of them never do: of 15 rules exactly one
 * asks for a `clip` and ten for a `gif`, while four attach no media at all —
 * yet every camera used to pay a flat minute of ring. These cases are the
 * mapping, one row each.
 */
import { describe, expect, it } from 'vitest'
import type { NcRule } from '@camstack/types'
import {
  buildClipRetentionPlan,
  clipRetentionSecFor,
  deriveClipRetentionAsks,
  NC_CLIP_DISPATCH_MARGIN_SEC,
} from '../clip-retention-ask.js'

/** The window an ordinary footage rule asks for: 4 + 6 + 10. */
// A rule storing no roll: 4 s pre + 6 s post (D654) + the dispatch margin.
const WINDOW_SEC = 4 + 6 + NC_CLIP_DISPATCH_MARGIN_SEC

function rule(over: Partial<NcRule>): NcRule {
  const base: NcRule = {
    id: 'r1',
    name: 'rule',
    enabled: true,
    delivery: 'immediate',
    conditions: {},
    targets: [],
    media: { attach: 'best' },
    throttle: { cooldownSec: 60, scope: 'rule-device' },
    priority: 3,
    createdBy: 'test',
    createdAt: 0,
    updatedAt: 0,
    disabledTargetIds: [],
  }
  return { ...base, ...over }
}

describe('clip retention asks', () => {
  it('a rule that attaches only a STILL asks for nothing — a still never reads the ring', () => {
    // Ten of the fifteen live rules are this shape.
    const asks = deriveClipRetentionAsks([
      rule({ media: { attach: 'best' }, conditions: { devices: [101] } }),
      rule({ id: 'r2', media: { attach: 'best-matching' }, conditions: { devices: [101] } }),
      rule({ id: 'r3', media: { attach: 'none' }, conditions: { devices: [101] } }),
      rule({ id: 'r4', media: { attach: 'best', gif: false }, conditions: { devices: [101] } }),
    ])
    expect(asks).toEqual([])
    expect(clipRetentionSecFor(asks, 101)).toBe(0)
  })

  it('a gif rule asks for its own window plus the dispatch margin', () => {
    const asks = deriveClipRetentionAsks([
      rule({ media: { attach: 'best', gif: true }, conditions: { devices: [101] } }),
    ])
    expect(asks).toEqual([
      {
        deviceId: 101,
        seconds: WINDOW_SEC,
        reason: 'window',
        ruleId: 'r1',
        ruleName: 'rule',
      },
    ])
    expect(clipRetentionSecFor(asks, 101)).toBe(WINDOW_SEC)
    // …and nothing for a camera the rule cannot fire on.
    expect(clipRetentionSecFor(asks, 102)).toBe(0)
  })

  it('a SENSOR rule asks for its footage like any rule — it goes through the same media path (D897)', () => {
    // Until D897 a sensor rule's stored gif/clip were ignored at delivery and
    // it asked for nothing; it now cuts what it stored, so its ring must hold it.
    const asks = deriveClipRetentionAsks([
      rule({
        delivery: 'device-event',
        media: { image: 'clean', gif: true, clip: true, profile: 'high' },
        conditions: { devices: [101] },
      }),
    ])
    expect(clipRetentionSecFor(asks, 101)).toBeGreaterThan(0)
  })

  it("honours the rule's own pre/post roll", () => {
    const asks = deriveClipRetentionAsks([
      rule({
        media: { attach: 'best', clip: true, clipPreRollSec: 12, clipPostRollSec: 15 },
        conditions: { devices: [104] },
      }),
    ])
    expect(clipRetentionSecFor(asks, 104)).toBe(12 + 15 + NC_CLIP_DISPATCH_MARGIN_SEC)
  })

  it('clamps to the occupancy ceiling — the ring is bounded, whatever a rule asks', () => {
    const asks = deriveClipRetentionAsks([
      rule({
        media: { attach: 'best', clip: true, clipPreRollSec: 30, clipPostRollSec: 30 },
        conditions: { devices: [104] },
      }),
    ])
    expect(clipRetentionSecFor(asks, 104)).toBe(60)
  })

  it('an OCCUPANCY rule asks for the full minute — its edge is confirmed late', () => {
    const asks = deriveClipRetentionAsks([
      rule({
        delivery: 'device-event',
        media: { attach: 'best', frame: 'full', gif: true },
        conditions: {
          devices: [102],
          occupancy: {
            zoneId: 'z',
            className: 'vehicle',
            op: 'became-free',
            count: 1,
            sustainSeconds: 29,
          },
        },
      }),
    ])
    expect(asks[0]?.reason).toBe('occupancy')
    expect(clipRetentionSecFor(asks, 102)).toBe(60)
  })

  // D691: the operator asked for "un minuto" of buffer on EVERY camera an
  // occupancy rule follows — a still-only departure rule included, because its
  // picture is a frame of the departure, cut from that ring at `observedAt`.
  it('an occupancy rule that attaches only a STILL still asks for the full minute (D691)', () => {
    const occupancy = {
      zoneId: 'z',
      className: 'vehicle',
      op: 'became-free' as const,
      count: 1,
      sustainSeconds: 29,
    }
    const asks = deriveClipRetentionAsks([
      rule({
        delivery: 'device-event',
        media: { attach: 'best', frame: 'full' },
        conditions: { devices: [102], occupancy },
      }),
      rule({
        id: 'r2',
        delivery: 'device-event',
        media: { attach: 'none' },
        conditions: { devices: [108], occupancy },
      }),
    ])
    expect(asks.map((a) => a.reason)).toEqual(['occupancy', 'occupancy'])
    expect(clipRetentionSecFor(asks, 102)).toBe(60)
    expect(clipRetentionSecFor(asks, 108)).toBe(60)
  })

  it('a DISABLED rule asks for nothing — it cannot fire, so it cannot cut', () => {
    const asks = deriveClipRetentionAsks([
      rule({
        enabled: false,
        media: { attach: 'best', clip: true },
        conditions: { devices: [102] },
      }),
    ])
    expect(asks).toEqual([])
  })

  it('a rule with no device scope asks EVERYWHERE — one device-less ask', () => {
    const asks = deriveClipRetentionAsks([rule({ media: { attach: 'best', gif: true } })])
    expect(asks[0]?.deviceId).toBeUndefined()
    expect(clipRetentionSecFor(asks, 101)).toBe(WINDOW_SEC)
    expect(clipRetentionSecFor(asks, 9999)).toBe(WINDOW_SEC)
  })

  it('a camera served by several rules gets the MAX, not the last', () => {
    const asks = deriveClipRetentionAsks([
      rule({ id: 'a', media: { attach: 'best', gif: true }, conditions: { devices: [102] } }),
      rule({
        id: 'b',
        delivery: 'device-event',
        media: { attach: 'best', gif: true },
        conditions: {
          devices: [102],
          occupancy: {
            zoneId: 'z',
            className: 'vehicle',
            op: 'became-occupied',
            count: 1,
            sustainSeconds: 29,
          },
        },
      }),
      rule({ id: 'c', media: { attach: 'best', gif: true }, conditions: { devices: [101] } }),
    ])
    expect(clipRetentionSecFor(asks, 102)).toBe(60)
    expect(clipRetentionSecFor(asks, 101)).toBe(WINDOW_SEC)
  })

  it('carries the profile the rule named, so the cut is not re-armed after the fact', () => {
    const asks = deriveClipRetentionAsks([
      rule({
        media: { attach: 'best', clip: true, profile: 'high' },
        conditions: { devices: [101] },
      }),
    ])
    expect(asks[0]?.profile).toBe('high')
  })

  // D692 §6.3: a grouped row is enqueued up to `groupingSec` after its anchor (the window's
  // open), so the ring must hold that much longer for the cut to stay warm.
  describe('a grouped rule (D692)', () => {
    it('a grouped gif rule at the defaults asks window + margin + groupingSec: 4 + 6 + 10 + 20', () => {
      const asks = deriveClipRetentionAsks([
        rule({
          groupingSec: 20,
          media: { attach: 'best', gif: true },
          conditions: { devices: [101] },
        }),
      ])
      expect(clipRetentionSecFor(asks, 101)).toBe(40)
      expect(clipRetentionSecFor(asks, 101)).toBe(WINDOW_SEC + 20)
    })

    it('groupingSec 60 is capped at the ring ceiling (60)', () => {
      const asks = deriveClipRetentionAsks([
        rule({
          groupingSec: 60,
          media: { attach: 'best', clip: true },
          conditions: { devices: [101] },
        }),
      ])
      expect(clipRetentionSecFor(asks, 101)).toBe(60)
    })

    it('a grouped rule that attaches only a STILL still asks for nothing', () => {
      const asks = deriveClipRetentionAsks([
        rule({ groupingSec: 20, media: { attach: 'best' }, conditions: { devices: [101] } }),
      ])
      expect(asks).toEqual([])
    })

    it('a groupingSec stored on a TRACK-END rule (the guard refuses it) asks the plain window', () => {
      const asks = deriveClipRetentionAsks([
        rule({
          delivery: 'track-end',
          groupingSec: 20,
          media: { attach: 'best', gif: true },
          conditions: { devices: [101] },
        }),
      ])
      expect(clipRetentionSecFor(asks, 101)).toBe(WINDOW_SEC)
    })

    it('a groupingSec stored on a SOUND rule (the guard refuses it) asks what a sound rule asked before', () => {
      const asks = deriveClipRetentionAsks([
        rule({
          groupingSec: 20,
          conditions: {
            devices: [101],
            audio: { labels: ['dog_bark'], hitPercent: 60, samplingSeconds: 10 },
          },
          media: { attach: 'best', gif: true },
        }),
      ])
      expect(clipRetentionSecFor(asks, 101)).toBe(WINDOW_SEC)
    })
  })

  it('the plan reports whether the rules were ever READ — empty is not the same answer', () => {
    expect(buildClipRetentionPlan([], false)).toEqual({ rulesLoaded: false, asks: [] })
    expect(buildClipRetentionPlan([], true)).toEqual({ rulesLoaded: true, asks: [] })
  })
})
