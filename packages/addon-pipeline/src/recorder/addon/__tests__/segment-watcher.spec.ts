import { describe, it, expect } from 'vitest'
import {
  parseEpochStartMs,
  correctedDurMs,
  parseLivePlaylist,
  parseMediaSequence,
  planFinalizations,
  segmentListSize,
  PENDING_GRACE_MS,
  WATCHER_PASS_WORST_MS,
} from '../segment-watcher.js'

describe('parseEpochStartMs', () => {
  it('derives startMs from an epoch-named flat segment (relative or absolute)', () => {
    expect(parseEpochStartMs('1718600000.m4s')).toBe(1718600000_000)
    expect(parseEpochStartMs('/tmp/rec-v2/99/low/1718600000.m4s')).toBe(1718600000_000)
  })
  it('returns null for a non-epoch / already-relocated name', () => {
    expect(parseEpochStartMs('1718600000-4000-12345.m4s')).toBeNull()
    expect(parseEpochStartMs('live.m3u8')).toBeNull()
  })
})

describe('correctedDurMs', () => {
  it('clamps an inflated first-segment EXTINF to the inter-segment gap', () => {
    // EXTINF 87.961s, but the successor starts only 12s later → clamp to 12000.
    expect(correctedDurMs(87.961, 1_000_000, 1_012_000)).toBe(12_000)
  })
  it('keeps the (sub-second-accurate) EXTINF when it is below the start gap', () => {
    // EXTINF 4.000s, successor 4s later → EXTINF wins (preserves precision).
    expect(correctedDurMs(4.0, 1_000_000, 1_004_000)).toBe(4_000)
  })
  it('trusts EXTINF for the genuine last segment (no successor)', () => {
    expect(correctedDurMs(3.5, 1_000_000, null)).toBe(3_500)
  })
  it('trusts EXTINF when the gap is non-positive (restart / same-second)', () => {
    expect(correctedDurMs(4.0, 1_000_000, 1_000_000)).toBe(4_000)
  })
})

describe('parseLivePlaylist', () => {
  it('pairs each #EXTINF with the following segment path, ignoring other tags', () => {
    const body = [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      '#EXTINF:4.000,',
      '1718600000.m4s',
      '#EXTINF:4.012,',
      '1718600004.m4s',
    ].join('\n')
    expect(parseLivePlaylist(body)).toEqual([
      { durSeconds: 4.0, segPath: '1718600000.m4s' },
      { durSeconds: 4.012, segPath: '1718600004.m4s' },
    ])
  })
})

describe('planFinalizations', () => {
  const body = [
    '#EXTM3U',
    '#EXTINF:90.0,', // inflated first segment
    '1000.m4s',
    '#EXTINF:4.0,',
    '1012.m4s',
    '#EXTINF:4.0,',
    '1016.m4s',
  ].join('\n')

  it('holds back the live tail and corrects the first segment against its successor', () => {
    const plan = planFinalizations(body, 0)
    // 3 entries, no ENDLIST → finalizable = first 2; tail (index 2) held back.
    expect(plan.toHandle).toHaveLength(2)
    expect(plan.from).toBe(0)
    expect(plan.processed).toBe(2)
    // First segment: gap 1012-1000 = 12s → clamped to 12000 (not 90000).
    expect(plan.toHandle[0]!.durMs).toBe(12_000)
    // startMs derived from epoch-seconds 1012 → gap to 1016 = 4s.
    expect(plan.toHandle[1]!.durMs).toBe(4_000)
  })

  it('advances past already-processed entries (high-water mark)', () => {
    const plan = planFinalizations(body, 1)
    expect(plan.from).toBe(1)
    expect(plan.toHandle).toHaveLength(1)
    expect(plan.processed).toBe(2)
  })

  it('flushes the tail once #EXT-X-ENDLIST is present', () => {
    const withEnd = `${body}\n#EXT-X-ENDLIST`
    const plan = planFinalizations(withEnd, 0)
    expect(plan.toHandle).toHaveLength(3)
    expect(plan.processed).toBe(3)
  })

  it('replays from the top when the playlist rotated below the mark', () => {
    const shortBody = ['#EXTM3U', '#EXTINF:4.0,', '2000.m4s', '#EXTINF:4.0,', '2004.m4s'].join('\n')
    const plan = planFinalizations(shortBody, 5)
    expect(plan.from).toBe(0)
  })

  it('does not report roll-off on an unbounded list', () => {
    expect(planFinalizations(body, 0).rolledOff).toBe(0)
  })
})

/**
 * `-segment_list_size` makes the playlist a SLIDING WINDOW, and from that
 * moment an index into the body is no longer the name of a segment: entry 0 is a
 * different file after every slide. If the placeholder stayed an index into the
 * body, it would get stuck at `entries.length - 1` and would never finalize ANYTHING
 * while ffmpeg keeps writing — the memory fix would have
 * switched off recording indexing while looking like it worked.
 */
describe('bounded playlist — the placeholder is global, not an index into the body', () => {
  /** A window of `size` entries starting at global segment `base`. */
  const window = (base: number, size: number, endlist = false): string => {
    const lines = ['#EXTM3U', '#EXT-X-VERSION:3', `#EXT-X-MEDIA-SEQUENCE:${base}`]
    for (let i = 0; i < size; i++) {
      lines.push('#EXTINF:10.000000,')
      lines.push(`${1_000_000 + (base + i) * 10}.m4s`)
    }
    if (endlist) lines.push('#EXT-X-ENDLIST')
    return lines.join('\n')
  }

  it('reads EXT-X-MEDIA-SEQUENCE, and treats it as 0 when missing', () => {
    expect(parseMediaSequence(window(8, 4))).toBe(8)
    expect(parseMediaSequence('#EXTM3U\n#EXTINF:4.0,\na.m4s')).toBe(0)
  })

  it('keeps finalizing while the window slides', () => {
    // Window full at 4 entries, placeholder already at 8 (everything that left was
    // handled). The window advances by one: there must be new work.
    const plan = planFinalizations(window(6, 4), 9)
    expect(plan.from).toBe(9)
    expect(plan.toHandle).toHaveLength(0) // 6..9 finalizable, 9 is the tail
    const next = planFinalizations(window(7, 4), 9)
    expect(next.toHandle).toHaveLength(1)
    expect(next.processed).toBe(10)
    expect(next.rolledOff).toBe(0)
  })

  it('names in global coordinates the segment it delivers', () => {
    const plan = planFinalizations(window(20, 4), 20)
    expect(plan.from).toBe(20)
    expect(plan.processed).toBe(23)
    expect(plan.toHandle.map((p) => p.entry.segPath)).toEqual([
      `${1_000_000 + 200}.m4s`,
      `${1_000_000 + 210}.m4s`,
      `${1_000_000 + 220}.m4s`,
    ])
  })

  it('SAYS how many entries left the window without being handled', () => {
    // The watcher was stuck at segment 4; the window is already at 20.
    const plan = planFinalizations(window(20, 4), 4)
    expect(plan.rolledOff).toBe(16)
    expect(plan.from).toBe(20) // restarts from the edge, does not recompute dead indices
  })

  it('an ffmpeg restart (sequence back to 0) stays a replay, not a roll-off', () => {
    const plan = planFinalizations(window(0, 2), 30)
    expect(plan.from).toBe(0)
    expect(plan.rolledOff).toBe(0)
  })

  it('ENDLIST also frees the tail of the window', () => {
    const plan = planFinalizations(window(20, 4, true), 20)
    expect(plan.toHandle).toHaveLength(4)
    expect(plan.processed).toBe(24)
  })
})

describe('segmentListSize', () => {
  it('covers the retained tail plus the pending grace and the worst pass', () => {
    // The size IS the time: the tail (1) plus how long an entry can
    // remain this watcher's business, divided by the duration of a segment.
    for (const segmentSeconds of [2, 4, 6, 10, 30]) {
      const size = segmentListSize(segmentSeconds)
      const coveredMs = (size - 1) * segmentSeconds * 1000
      expect(coveredMs).toBeGreaterThanOrEqual(PENDING_GRACE_MS + WATCHER_PASS_WORST_MS)
    }
  })
  it('at a 10 s segment that is 15 entries — ~2.5 minutes of playlist, not an infinite list', () => {
    expect(segmentListSize(10)).toBe(15)
  })
  it('does not degenerate on an absurd segmentSeconds', () => {
    expect(segmentListSize(0)).toBeGreaterThan(1)
    expect(Number.isFinite(segmentListSize(0))).toBe(true)
  })
})
