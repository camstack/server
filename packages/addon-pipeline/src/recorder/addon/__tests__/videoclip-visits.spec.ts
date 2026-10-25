import { MAX_CLIP_EVENT_IDS, VISIT_MERGE_GAP_MS } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { clusterFootageVisits, VISIT_EVENT_ID, visitsToClips } from '../videoclip-visits.js'
import { clipIdFor } from '../videoclips-provider.js'

/**
 * Dispensa (device 1438) 2026-08-15 14:xx `low` — live `recording.getAvailability`
 * on 2026-08-16. Four ranges around one pantry visit; intra-visit holes are
 * ~8 s (GOP / keyframe rolls). `RANGE_MERGE_GAP_MS = 5 s` leaves them split;
 * `VISIT_MERGE_GAP_MS = 30 s` (events-band post-buffer) glues them into one
 * clip.
 */
const DISPENSA_AUG15_14_LOW = [
  { startMs: 1_786_803_950_000, endMs: 1_786_803_961_996 },
  { startMs: 1_786_803_970_000, endMs: 1_786_803_990_000 },
  { startMs: 1_786_803_998_000, endMs: 1_786_804_010_000 },
  { startMs: 1_786_804_018_000, endMs: 1_786_804_066_419 },
] as const

describe('clusterFootageVisits', () => {
  it('glues GOP-sized holes inside one events-mode visit', () => {
    const visits = clusterFootageVisits(DISPENSA_AUG15_14_LOW, VISIT_MERGE_GAP_MS)
    expect(visits).toHaveLength(1)
    expect(visits[0]).toMatchObject({
      startMs: 1_786_803_950_000,
      endMs: 1_786_804_066_419,
    })
    expect(visits[0]!.holes).toEqual([
      { startMs: 1_786_803_961_996, endMs: 1_786_803_970_000 },
      { startMs: 1_786_803_990_000, endMs: 1_786_803_998_000 },
      { startMs: 1_786_804_010_000, endMs: 1_786_804_018_000 },
    ])
    expect(visits[0]!.ranges).toHaveLength(4)
  })

  it('does not glue distinct visits hours apart', () => {
    const visits = clusterFootageVisits(
      [
        { startMs: 1_786_691_476_000, endMs: 1_786_691_547_000 },
        { startMs: 1_786_707_589_000, endMs: 1_786_707_648_000 },
      ],
      VISIT_MERGE_GAP_MS,
    )
    expect(visits).toHaveLength(2)
    expect(visits.map((v) => v.holes)).toEqual([[], []])
  })

  it('keeps the 5 s availability split when the visit gap is that tight', () => {
    expect(clusterFootageVisits(DISPENSA_AUG15_14_LOW, 5_000)).toHaveLength(4)
  })

  it('returns empty for no footage', () => {
    expect(clusterFootageVisits([], VISIT_MERGE_GAP_MS)).toEqual([])
  })
})

describe('visitsToClips', () => {
  const pad = { preMs: 5_000, postMs: 10_000 }

  it('emits one clip per visit, annotated with overlapping events', () => {
    const visits = clusterFootageVisits(DISPENSA_AUG15_14_LOW, VISIT_MERGE_GAP_MS)
    const clips = visitsToClips(
      visits,
      {
        motion: [
          { id: 'm-early', timestamp: 1_786_803_947_311, mediaUrl: '/t/early' },
          { id: 'm-mid', timestamp: 1_786_804_029_977 },
        ],
        object: [{ id: 'o1', timestamp: 1_786_803_950_815, mediaUrl: '/t/obj' }],
        audio: [],
      },
      pad,
      new Set(['o1', 'm-early']),
    )
    expect(clips).toHaveLength(1)
    expect(clips[0]!.id).toBe(clipIdFor(VISIT_EVENT_ID, 1_786_803_950_000, 1_786_804_066_419))
    expect(clips[0]!.kind).toBe('object')
    expect(clips[0]!.eventIds).toEqual(['o1', 'm-early', 'm-mid'])
    expect(clips[0]!.thumbnail).toBe('/t/obj')
    expect(clips[0]!.holes).toHaveLength(3)
  })

  it('aggregates the attached object classes into labels, dominant first', () => {
    // The ribbon used to render only the KIND — "Object" — because the row
    // carried no classes at all. The slim object events already hold
    // `className`; the visit aggregates the distinct ones by frequency.
    const visits = clusterFootageVisits([{ startMs: 1000, endMs: 40_000 }], VISIT_MERGE_GAP_MS)
    const clips = visitsToClips(
      visits,
      {
        motion: [],
        object: [
          { id: 'o1', timestamp: 2_000, className: 'person' },
          { id: 'o2', timestamp: 3_000, className: 'person' },
          { id: 'o3', timestamp: 4_000, className: 'cat' },
        ],
        audio: [],
      },
      pad,
      new Set(),
    )
    expect(clips[0]!.labels).toEqual(['person', 'cat'])
  })

  it('caps labels and never emits an empty array', () => {
    const visits = clusterFootageVisits([{ startMs: 1000, endMs: 40_000 }], VISIT_MERGE_GAP_MS)
    const many = visitsToClips(
      visits,
      {
        motion: [],
        object: [
          { id: 'a', timestamp: 2_000, className: 'person' },
          { id: 'b', timestamp: 2_100, className: 'car' },
          { id: 'c', timestamp: 2_200, className: 'cat' },
          { id: 'd', timestamp: 2_300, className: 'dog' },
        ],
        audio: [],
      },
      pad,
      new Set(),
    )
    expect(many[0]!.labels).toHaveLength(3)
    const none = visitsToClips(
      visits,
      { motion: [{ id: 'm', timestamp: 2_000 }], object: [], audio: [] },
      pad,
      new Set(),
    )
    expect(none[0]!.labels).toBeUndefined()
  })

  it('still emits a footage-only visit when analytics is empty', () => {
    const visits = clusterFootageVisits([{ startMs: 1000, endMs: 40_000 }], VISIT_MERGE_GAP_MS)
    const clips = visitsToClips(visits, { motion: [], object: [], audio: [] }, pad, new Set())
    expect(clips).toHaveLength(1)
    expect(clips[0]).toMatchObject({
      kind: 'motion',
      timeRange: { startMs: 1000, endMs: 40_000 },
      eventIds: [],
    })
  })
})

/**
 * G1 — a clip carries `thumbnail` only for an event CONFIRMED to own media.
 * The presence set is an explicit input so these stay pure and no fake can
 * pre-seed a URL production would never have fetched.
 */
describe('visitsToClips — the vouched thumbnail (G1)', () => {
  const pad = { preMs: 5_000, postMs: 10_000 }
  const visits = clusterFootageVisits([{ startMs: 1000, endMs: 40_000 }], VISIT_MERGE_GAP_MS)

  // T1 — mutation: swap the KIND_ORDER precedence.
  it('T1: picks the dominant-kind event that HAS media', () => {
    const clips = visitsToClips(
      visits,
      {
        motion: [{ id: 'm1', timestamp: 20_000, mediaUrl: '/t/m1' }],
        object: [{ id: 'o1', timestamp: 21_000, mediaUrl: '/t/o1' }],
        audio: [],
      },
      pad,
      new Set(['o1', 'm1']),
    )
    expect(clips[0]!.kind).toBe('object')
    expect(clips[0]!.thumbnail).toBe('/t/o1')
  })

  // T2 — mutation: drop the second `find`.
  it('T2: falls back to another kind’s vouched still, keeping the visit kind', () => {
    const clips = visitsToClips(
      visits,
      {
        motion: [{ id: 'm1', timestamp: 20_000, mediaUrl: '/t/m1' }],
        object: [{ id: 'o1', timestamp: 21_000, mediaUrl: '/t/o1' }],
        audio: [],
      },
      pad,
      new Set(['m1']), // o1's URL exists but nothing backs it
    )
    expect(clips[0]!.kind).toBe('object')
    expect(clips[0]!.thumbnail).toBe('/t/m1')
  })

  // T3 — mutation: make `thumbnail` fall back to `mediaUrl` (today's behaviour).
  it('T3: no vouched event → NO thumbnail, but a stillAtMs', () => {
    const clips = visitsToClips(
      visits,
      {
        motion: [{ id: 'm1', timestamp: 20_000, mediaUrl: '/t/m1' }],
        object: [{ id: 'o1', timestamp: 21_000, mediaUrl: '/t/o1' }],
        audio: [],
      },
      pad,
      new Set(),
    )
    expect(clips[0]!.thumbnail).toBeUndefined()
    expect(clips[0]!.stillAtMs).toBe(20_500)
  })

  // T4
  it('T4: a footage-only visit is drawable — no thumbnail, a stillAtMs, empty eventIds', () => {
    const clips = visitsToClips(visits, { motion: [], object: [], audio: [] }, pad, new Set())
    expect(clips[0]!.thumbnail).toBeUndefined()
    expect(clips[0]!.stillAtMs).toBe(20_500)
    expect(clips[0]!.eventIds).toEqual([])
    expect(clips[0]!.eventCount).toBe(0)
  })
})

/** G2 — `stillAtMs` lies inside footage, never in a hole. */
describe('visitsToClips — stillAtMs (G2)', () => {
  const pad = { preMs: 5_000, postMs: 10_000 }

  // T5 — mutation: compute the visit midpoint instead of the longest range's.
  it('T5: lands in the LONGEST range, not the visit midpoint', () => {
    // 8 s range, 40 s hole, 90 s range. Merge gap widened past the hole so the
    // three pieces stay one visit.
    const visits = clusterFootageVisits(
      [
        { startMs: 0, endMs: 8_000 },
        { startMs: 48_000, endMs: 138_000 },
      ],
      60_000,
    )
    expect(visits).toHaveLength(1)
    const clips = visitsToClips(visits, { motion: [], object: [], audio: [] }, pad, new Set())
    const still = clips[0]!.stillAtMs
    expect(still).toBe(93_000)
    // The naive visit midpoint (69 000) sits inside the hole — assert it does not.
    for (const hole of clips[0]!.holes ?? []) {
      expect(still! >= hole.startMs && still! < hole.endMs).toBe(false)
    }
    expect(clips[0]!.holes).toEqual([{ startMs: 8_000, endMs: 48_000 }])
  })
})

/** Fix B — `eventIds` is a bounded sample, and `eventIds[0]` always survives. */
describe('visitsToClips — bounded eventIds', () => {
  const pad = { preMs: 5_000, postMs: 10_000 }

  it('caps the sample at MAX_CLIP_EVENT_IDS while reporting the true count', () => {
    const visits = clusterFootageVisits([{ startMs: 0, endMs: 1_000_000 }], VISIT_MERGE_GAP_MS)
    const motion = Array.from({ length: MAX_CLIP_EVENT_IDS + 40 }, (_, i) => ({
      id: `m${i}`,
      timestamp: 1000 + i,
    }))
    const clips = visitsToClips(visits, { motion, object: [], audio: [] }, pad, new Set())
    expect(clips[0]!.eventCount).toBe(MAX_CLIP_EVENT_IDS + 40)
    expect(clips[0]!.eventIds).toHaveLength(MAX_CLIP_EVENT_IDS)
    // The viewer's thumbnail fallback reads `eventIds[0]` — it must not move.
    expect(clips[0]!.eventIds![0]).toBe('m0')
  })
})
