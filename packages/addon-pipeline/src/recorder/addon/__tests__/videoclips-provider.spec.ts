import { EVENT_PAD_MS, MAX_CLIP_EVENT_IDS } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  clipIdFor,
  createVideoclipsProvider,
  eventsToClips,
  parseClipId,
  VISIT_EVENT_FETCH_LIMIT,
} from '../videoclips-provider.js'
import type { MediaOwnersQuery } from '../videoclips-shared.js'

/** The `provider` a videoclips call names (D554): the recorder's clip-source addon id. */
const RECORDER = 'recorder'

const PAD = { preMs: 500, postMs: 1500 }
/** Left overhang the provider must widen the read by (VISIT_MERGE_GAP_MS + preMs). */
const OVERHANG = PAD.preMs + PAD.postMs + PAD.preMs

/** A presence probe that vouches for exactly the named owner ids. Deliberately
 *  NOT a "vouch for everything" fake: a fake that pre-seeds what production
 *  forgot to fetch is precisely how this defect stayed invisible. */
function ownersWith(...owned: readonly string[]): (q: MediaOwnersQuery) => Promise<Set<string>> {
  return async (q) => new Set(q.ownerIds.filter((id) => owned.includes(id)))
}
const noOwners = (): ((q: MediaOwnersQuery) => Promise<Set<string>>) => ownersWith()

describe('eventsToClips', () => {
  it('maps per-kind events into padded, newest-first clips', () => {
    const clips = eventsToClips(
      {
        motion: [{ id: 'm1', timestamp: 1000 }],
        object: [{ id: 'o1', timestamp: 2000, mediaUrl: '/thumb/o1.jpg' }],
        audio: [{ id: 'a1', timestamp: 3000 }],
      },
      PAD,
      new Set(['o1']),
    )
    // newest-first: a1(2500) > o1(1500) > m1(500)
    expect(clips.map((c) => c.kind)).toEqual(['audio', 'object', 'motion'])
    expect(clips[2]).toMatchObject({
      id: 'analytics:500:2500:m1',
      source: 'analytics',
      kind: 'motion',
      timeRange: { startMs: 500, endMs: 2500 },
    })
    expect(clips[1]?.thumbnail).toBe('/thumb/o1.jpg')
  })

  // T3, per-event flavour — mutation: fall back to `e.mediaUrl` (today's code).
  it('withholds the thumbnail for an event nothing vouched for', () => {
    const clips = eventsToClips(
      { motion: [], object: [{ id: 'o1', timestamp: 2000, mediaUrl: '/thumb/o1.jpg' }], audio: [] },
      PAD,
      new Set(),
    )
    // One clip, or the absence below would hold for an empty list too.
    expect(clips).toHaveLength(1)
    expect(clips[0]?.thumbnail).toBeUndefined()
  })

  // T6 — mutation: emit stillAtMs anyway (it would 204 on an unrecorded camera).
  it('T6: never promises a recorded still on a per-event padded window', () => {
    const clips = eventsToClips(
      { motion: [{ id: 'm1', timestamp: 1000 }], object: [], audio: [] },
      PAD,
      new Set(),
    )
    // One clip, or the absence below would hold for an empty list too.
    expect(clips).toHaveLength(1)
    expect(clips[0]?.stillAtMs).toBeUndefined()
  })

  it('returns empty when there are no events', () => {
    expect(eventsToClips({ motion: [], object: [], audio: [] }, PAD, new Set())).toEqual([])
  })
})

describe('clipId round-trip', () => {
  it('encodes + parses the window and event id', () => {
    const id = clipIdFor('evt-9', 500, 2500)
    expect(id).toBe('analytics:500:2500:evt-9')
    expect(parseClipId(id)).toEqual({ eventId: 'evt-9', startMs: 500, endMs: 2500 })
  })

  it('preserves colons inside the event id', () => {
    expect(parseClipId(clipIdFor('a:b:c', 1, 2))).toEqual({
      eventId: 'a:b:c',
      startMs: 1,
      endMs: 2,
    })
  })

  it('rejects ids it did not mint', () => {
    expect(parseClipId('native:reolink:123')).toBeNull()
    expect(parseClipId('analytics:x:y:e')).toBeNull()
  })
})

describe('createVideoclipsProvider', () => {
  it('listClips composes fetched events into clips (and honors limit)', async () => {
    const fetchEvents = vi.fn(async () => ({
      motion: [{ id: 'm1', timestamp: 1000 }],
      object: [{ id: 'o1', timestamp: 2000 }],
      audio: [],
    }))
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 0,
      until: 9999,
      limit: 1,
    })
    expect(fetchEvents).toHaveBeenCalledWith({
      deviceId: 7,
      since: -OVERHANG,
      until: 9999,
      limit: 1,
    })
    expect(clips).toHaveLength(1)
    expect(clips[0]?.kind).toBe('object') // newest-first
  })

  it('getClipPlayback resolves the encoded window via the recorder', async () => {
    const resolvePlayback = vi.fn(async () => ({
      playbackUrl: 'https://hub/rec/7/master.m3u8?from=500&to=2500',
    }))
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: vi.fn(),
      fetchMediaOwners: noOwners(),
      resolvePlayback,
    })
    const out = await provider.getClipPlayback({ deviceId: 7, clipId: 'analytics:500:2500:m1' })
    expect(resolvePlayback).toHaveBeenCalledWith({ deviceId: 7, startMs: 500, endMs: 2500 })
    expect(out.playbackUrl).toContain('master.m3u8')
  })

  it('getClipPlayback throws on an unrecognized clip id', async () => {
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: vi.fn(),
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    await expect(provider.getClipPlayback({ deviceId: 7, clipId: 'bogus' })).rejects.toThrow(
      'unrecognized clipId',
    )
  })

  it('listClips drops clips whose window has no recorded footage behind it', async () => {
    // m1 window [500,3500] overlaps the recorded range [3000,9000]; o1 window
    // [9500,12500] starts after footage ends — an unplayable stub, dropped.
    const fetchEvents = vi.fn(async () => ({
      motion: [{ id: 'm1', timestamp: 1000 }],
      object: [{ id: 'o1', timestamp: 10_000 }],
      audio: [],
    }))
    const fetchAvailability = vi.fn(async () => [{ startMs: 3000, endMs: 9000 }])
    const provider = createVideoclipsProvider({
      defaultPad: { preMs: 500, postMs: 2500 },
      fetchEvents,
      fetchAvailability,
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 0,
      until: 20_000,
    })
    // This test has its OWN pad, so its overhang is its own: pre+post+pre.
    expect(fetchAvailability).toHaveBeenCalledWith({
      deviceId: 7,
      since: -(500 + 2500 + 500),
      until: 20_000,
    })
    // m1's window [500,3500] clamped to the footage → [3000,3500]. It used to
    // read [3000,9000] — the whole recorded range — because the 30 s constant
    // merged m1 with o1 nine seconds away and the visit then took the footage
    // it spanned. The grain is pre+post (3 s here), so they are two bursts;
    // o1's sits after the footage ends and is dropped, which is this test's
    // actual claim.
    expect(clips).toHaveLength(1)
    expect(clips[0]).toMatchObject({
      id: 'analytics:3000:3500:visit',
      kind: 'motion',
      timeRange: { startMs: 3000, endMs: 3500 },
      eventIds: ['m1'],
    })
  })

  it('listClips returns no clips for a camera with zero recorded footage', async () => {
    const fetchEvents = vi.fn(async () => ({
      motion: [],
      object: [],
      audio: [
        { id: 'a1', timestamp: 5000 },
        { id: 'a2', timestamp: 8000 },
      ],
    }))
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      fetchAvailability: vi.fn(async () => []),
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    await expect(
      provider.listClips({ provider: RECORDER, deviceId: 7, since: 0, until: 20_000 }),
    ).resolves.toEqual([])
  })

  it('listClips applies limit AFTER the footage filter', async () => {
    const fetchEvents = vi.fn(async () => ({
      motion: [
        { id: 'm1', timestamp: 1000 },
        { id: 'm2', timestamp: 5000 },
      ],
      object: [],
      audio: [],
    }))
    // Only m1's window [500,2500] has footage; m2's [4500,6500] does not.
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      fetchAvailability: vi.fn(async () => [{ startMs: 0, endMs: 3000 }]),
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 0,
      until: 20_000,
      limit: 1,
    })
    // [500,2500] — m1's own padded window. Not 0 (where the recording began)
    // and no longer 3000 (where it ended): that end came from the 30 s
    // constant merging m1 with m2 four seconds away, after which the visit
    // took all the footage it spanned. The grain is now pre+post (D583).
    expect(clips.map((c) => c.id)).toEqual(['analytics:500:2500:visit'])
  })

  it('thins the quiet kinds BEFORE the limit, not after', async () => {
    // Order matters and nothing pinned it. Applied after paging, `limit` counts
    // rows that then vanish: page one comes back short, and it comes back with
    // the WRONG rows — this list is newest-first, so a limit taken first keeps
    // the two newest and the cooldown then spares a row the correct order
    // would have dropped.
    //
    // Three audio blips: 0, 60 s, 360 s. The cooldown (5 min) keeps the first
    // and the last.
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: vi.fn(async () => ({
        motion: [],
        object: [],
        audio: [
          { id: 'a0', timestamp: 0 },
          { id: 'a1', timestamp: 60_000 },
          { id: 'a6', timestamp: 360_000 },
        ],
      })),
      fetchAvailability: vi.fn(async () => [{ startMs: -10_000, endMs: 400_000 }]),
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 0,
      until: 400_000,
      limit: 2,
    })
    expect(clips.map((c) => c.eventIds?.[0])).toEqual(['a6', 'a0'])
  })

  it('does not pass list limit into fetchEvents when clustering visits', async () => {
    const fetchEvents = vi.fn(async () => ({
      motion: [
        { id: 'm1', timestamp: 1000 },
        { id: 'm2', timestamp: 2000 },
      ],
      object: [],
      audio: [],
    }))
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      fetchAvailability: vi.fn(async () => [{ startMs: 0, endMs: 10_000 }]),
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 0,
      until: 20_000,
      limit: 1,
    })
    // The annotation read is bounded, but never by the CLIP limit — one visit
    // is annotated by every event inside it.
    expect(fetchEvents).toHaveBeenCalledWith({
      deviceId: 7,
      since: -OVERHANG,
      until: 20_000,
      limit: VISIT_EVENT_FETCH_LIMIT,
    })
    expect(clips).toHaveLength(1)
    expect(clips[0]!.eventIds).toEqual(['m1', 'm2'])
  })
})

describe('createVideoclipsProvider — the vouched thumbnail on the wire', () => {
  const visitAvailability = vi.fn(async () => [{ startMs: 0, endMs: 100_000 }])

  // T7 — mutation: probe per clip → the call-count assertion fails.
  it('T7: probes media presence ONCE per listClips, never per clip', async () => {
    const fetchEvents = vi.fn(async () => ({
      // Three minutes apart, so the isolated-motion cooldown (2 min) keeps
      // both. This test needs TWO clips as scaffolding for its actual claim —
      // one presence probe per listClips, not one per clip — and the fixture
      // used to lean on a 40 s separation that the cooldown now closes.
      motion: [
        { id: 'm1', timestamp: 1000 },
        { id: 'm2', timestamp: 181_000 },
      ],
      object: [],
      audio: [],
    }))
    const fetchMediaOwners = vi.fn(ownersWith('m1'))
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      // Two visits, one per event.
      fetchAvailability: vi.fn(async () => [
        { startMs: 0, endMs: 10_000 },
        { startMs: 41_000, endMs: 300_000 },
      ]),
      fetchMediaOwners,
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 0,
      until: 200_000,
    })
    expect(clips).toHaveLength(2)
    expect(fetchMediaOwners).toHaveBeenCalledTimes(1)
    expect(fetchMediaOwners).toHaveBeenCalledWith({
      deviceId: 7,
      ownerKind: 'motion',
      ownerIds: ['m1', 'm2'],
    })
  })

  it('resolves an object event with no own media through its owning TRACK', async () => {
    const fetchEvents = vi.fn(async () => ({
      motion: [],
      object: [{ id: 'o1', timestamp: 5000, trackId: 'trk-1', mediaUrl: '/t/o1' }],
      audio: [],
    }))
    const fetchMediaOwners = vi.fn(ownersWith('trk-1'))
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      fetchAvailability: visitAvailability,
      fetchMediaOwners,
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 0,
      until: 200_000,
    })
    expect(fetchMediaOwners).toHaveBeenCalledTimes(2)
    expect(fetchMediaOwners).toHaveBeenNthCalledWith(2, {
      deviceId: 7,
      ownerKind: 'track',
      ownerIds: ['trk-1'],
    })
    expect(clips[0]!.thumbnail).toBe('/t/o1')
  })

  it('never asks for a track already answered by the event probe', async () => {
    const fetchEvents = vi.fn(async () => ({
      motion: [],
      object: [{ id: 'o1', timestamp: 5000, trackId: 'trk-1', mediaUrl: '/t/o1' }],
      audio: [],
    }))
    const fetchMediaOwners = vi.fn(ownersWith('o1'))
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      fetchAvailability: visitAvailability,
      fetchMediaOwners,
      resolvePlayback: vi.fn(),
    })
    await provider.listClips({ provider: RECORDER, deviceId: 7, since: 0, until: 200_000 })
    expect(fetchMediaOwners).toHaveBeenCalledTimes(1)
  })

  // T11 — mutation: fail OPEN on the claim → G1 breaks under load.
  it('T11: a failed presence read empties no LIST but makes no CLAIM', async () => {
    const fetchEvents = vi.fn(async () => ({
      motion: [{ id: 'm1', timestamp: 5000, mediaUrl: '/t/m1' }],
      object: [{ id: 'o1', timestamp: 6000, mediaUrl: '/t/o1' }],
      audio: [],
    }))
    const warns: { message: string; meta: Record<string, unknown> }[] = []
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      fetchAvailability: visitAvailability,
      fetchMediaOwners: vi.fn(async () => {
        throw new Error('media index unreachable')
      }),
      logWarn: (message, meta) => warns.push({ message, meta }),
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 0,
      until: 200_000,
    })
    expect(clips).toHaveLength(1)
    expect(clips.every((c) => c.thumbnail === undefined)).toBe(true)
    // The still sits inside the VISIT now, not at the midpoint of the whole
    // recording stretch: a visit is the event's window clamped to footage, so
    // 6 000 is where the event actually is. Handed the session's range the
    // still landed 44 s away from what the clip is about.
    expect(clips[0]!.stillAtMs).toBe(6_000)
    // A branch that drops work says so, per camera.
    expect(warns).toHaveLength(1)
    expect(warns[0]!.meta['deviceId']).toBe(7)
  })

  // T10 — mutation: swallow the error silently.
  it('T10: a failed availability read falls back to padded windows, still vouched, and warns', async () => {
    const fetchEvents = vi.fn(async () => ({
      motion: [{ id: 'm1', timestamp: 5000, mediaUrl: '/t/m1' }],
      object: [{ id: 'o1', timestamp: 6000, mediaUrl: '/t/o1' }],
      audio: [],
    }))
    const warns: { message: string; meta: Record<string, unknown> }[] = []
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      fetchAvailability: vi.fn(async () => {
        throw new Error('recorder unreachable')
      }),
      fetchMediaOwners: vi.fn(ownersWith('o1')),
      logWarn: (message, meta) => warns.push({ message, meta }),
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 0,
      until: 20_000,
    })
    expect(clips).toHaveLength(2)
    expect(clips.find((c) => c.id.endsWith(':o1'))!.thumbnail).toBe('/t/o1')
    expect(clips.find((c) => c.id.endsWith(':m1'))!.thumbnail).toBeUndefined()
    expect(warns).toHaveLength(1)
    expect(warns[0]!.message).toContain('availability read failed')
    expect(warns[0]!.meta['deviceId']).toBe(7)
  })

  it('counts and logs the visits it could not vouch a still for', async () => {
    const fetchEvents = vi.fn(async () => ({
      motion: [{ id: 'm1', timestamp: 5000, mediaUrl: '/t/m1' }],
      object: [],
      audio: [],
    }))
    const infos: { message: string; meta: Record<string, unknown> }[] = []
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      fetchAvailability: visitAvailability,
      fetchMediaOwners: noOwners(),
      logInfo: (message, meta) => infos.push({ message, meta }),
      resolvePlayback: vi.fn(),
    })
    await provider.listClips({ provider: RECORDER, deviceId: 7, since: 0, until: 200_000 })
    expect(infos).toHaveLength(1)
    expect(infos[0]!.message).toContain('no vouched still')
    expect(infos[0]!.meta).toMatchObject({ deviceId: 7, clipsWithoutStill: 1, clips: 1 })
  })

  it('stays silent when every visit has a vouched still', async () => {
    const infos: string[] = []
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: vi.fn(async () => ({
        motion: [{ id: 'm1', timestamp: 5000, mediaUrl: '/t/m1' }],
        object: [],
        audio: [],
      })),
      fetchAvailability: visitAvailability,
      fetchMediaOwners: vi.fn(ownersWith('m1')),
      logInfo: (message) => infos.push(message),
      resolvePlayback: vi.fn(),
    })
    await provider.listClips({ provider: RECORDER, deviceId: 7, since: 0, until: 200_000 })
    expect(infos).toEqual([])
  })
})

describe('createVideoclipsProvider — the left overhang (§3.4)', () => {
  // T8 — mutation: remove the overhang → T9 fails.
  it('T8: reads with a left overhang and drops what does not intersect the window', async () => {
    // One event inside the straddling range. A visit is a burst of EVENTS
    // clamped to footage, so a window with none has no clips at all — that is
    // the point of the change, and it would have hollowed out this test's
    // subject rather than its claim. The claim is the OVERHANG: a range
    // straddling `since` is kept, one entirely before it is not.
    const fetchEvents = vi.fn(async () => ({
      // Just BEFORE `since`, so its padded window straddles it — which is
      // what the overhang exists to keep reachable.
      motion: [{ id: 'm-straddle', timestamp: 199_800 }],
      object: [],
      audio: [],
    }))
    const fetchAvailability = vi.fn(async () => [
      // Entirely before `since` — a real visit, but not this window's.
      { startMs: 100_000, endMs: 150_000 },
      // Straddles `since`.
      { startMs: 190_000, endMs: 260_000 },
    ])
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      fetchAvailability,
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 200_000,
      until: 300_000,
    })
    expect(fetchAvailability).toHaveBeenCalledWith({
      deviceId: 7,
      since: 200_000 - OVERHANG,
      until: 300_000,
    })
    expect(fetchEvents).toHaveBeenCalledWith({
      deviceId: 7,
      since: 200_000 - OVERHANG,
      until: 300_000,
      limit: VISIT_EVENT_FETCH_LIMIT,
    })
    // Straddles `since` (200 000) and is kept; the range entirely before it
    // contributed nothing, because no event happened there.
    const range = clips[0]?.timeRange
    expect(clips).toHaveLength(1)
    expect(range?.startMs).toBeLessThan(200_000)
    expect(range?.endMs).toBeGreaterThan(200_000)
  })

  // T9 — the operator-visible half: the picture must not depend on scroll position.
  it('T9: a visit straddling `since` keeps the transition row that carries its only still', async () => {
    const fetchEvents = vi.fn(async ({ since }: { since: number }) => ({
      // The transition row (the ONLY one with a snapshot) sits before `since`;
      // the heartbeats sit inside the window.
      // Inside the GRAIN of each other (pre+post), so they are one visit —
      // the fixture used to rely on the 30 s constant to glue two rows 15 s
      // apart, which this spec's tiny pad no longer does. The CLAIM is
      // unchanged: the only row carrying a still sits before `since`.
      motion: [
        { id: 'm-heartbeat', timestamp: 200_500 },
        ...(since <= 199_500
          ? [{ id: 'm-transition', timestamp: 199_500, mediaUrl: '/t/tr' }]
          : []),
      ],
      object: [],
      audio: [],
    }))
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents,
      fetchAvailability: vi.fn(async () => [{ startMs: 190_000, endMs: 260_000 }]),
      fetchMediaOwners: vi.fn(ownersWith('m-transition')),
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 200_000,
      until: 300_000,
    })
    expect(clips).toHaveLength(1)
    expect(clips[0]!.thumbnail).toBe('/t/tr')
  })
})

describe('createVideoclipsProvider — the wire budget (§7.2 P4)', () => {
  it('caps eventIds per clip, keeps the first id, and reports the true count', async () => {
    const motion = Array.from({ length: 300 }, (_, i) => ({
      id: `motion-event-${String(i).padStart(4, '0')}`,
      timestamp: 1000 + i * 10,
    }))
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: vi.fn(async () => ({ motion, object: [], audio: [] })),
      fetchAvailability: vi.fn(async () => [{ startMs: 0, endMs: 100_000 }]),
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 7,
      since: 0,
      until: 200_000,
    })
    expect(clips[0]!.eventIds).toHaveLength(MAX_CLIP_EVENT_IDS)
    expect(clips[0]!.eventIds![0]).toBe('motion-event-0000')
    expect(clips[0]!.eventCount).toBe(300)
    // The budget the operator actually pays: ≤ 1.5 KB per clip row.
    expect(Buffer.byteLength(JSON.stringify(clips[0]))).toBeLessThanOrEqual(1500)
  })

  it('warns when the annotation fetch limit truncates a camera-day', async () => {
    const motion = Array.from({ length: VISIT_EVENT_FETCH_LIMIT }, (_, i) => ({
      id: `m${i}`,
      timestamp: 1000 + i,
    }))
    const warns: { message: string; meta: Record<string, unknown> }[] = []
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: vi.fn(async () => ({ motion, object: [], audio: [] })),
      fetchAvailability: vi.fn(async () => [{ startMs: 0, endMs: 100_000 }]),
      fetchMediaOwners: noOwners(),
      logWarn: (message, meta) => warns.push({ message, meta }),
      resolvePlayback: vi.fn(),
    })
    await provider.listClips({ provider: RECORDER, deviceId: 7, since: 0, until: 200_000 })
    expect(warns).toHaveLength(1)
    expect(warns[0]!.message).toContain('annotation fetch truncated')
    expect(warns[0]!.meta['deviceId']).toBe(7)
  })
})

/**
 * Slice 6 (D549 decision 2): `videoclips` is a collection, so every provider
 * must be able to NAME the sources it serves for a camera — that naming is
 * what routes `getClipPlayback` when a camera has more than one, and what
 * keeps an empty clip list from reading as "this camera has no recordings".
 */
describe('createVideoclipsProvider — listSources', () => {
  function provider() {
    return createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: vi.fn(async () => ({ motion: [], object: [], audio: [] })),
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
  }

  it('names exactly one source, and it is the one its clip ids are prefixed with', async () => {
    const sources = await provider().listSources({ deviceId: 7 })
    expect(sources).toHaveLength(1)
    expect(sources[0]!.source).toBe('analytics')
    // The prefix the dispatcher routes on — `clipIdFor` must agree with it.
    expect(clipIdFor('ev', 1, 2).startsWith(`${sources[0]!.source}:`)).toBe(true)
  })

  it('reports ok: this source is the hub itself, and it just answered', async () => {
    const sources = await provider().listSources({ deviceId: 7 })
    expect(sources[0]!.availability).toEqual({ state: 'ok' })
  })
})

// R5: the default provider is wired with the SHARED canonical pad from
// @camstack/types — not a locally re-declared 5s/10s literal.
describe('eventsToClips with the shared EVENT_PAD_MS', () => {
  it('pads clip windows -5s/+10s around the event timestamp', () => {
    const clips = eventsToClips(
      { motion: [{ id: 'm1', timestamp: 100_000 }], object: [], audio: [] },
      EVENT_PAD_MS,
      new Set(),
    )
    expect(clips[0]).toMatchObject({ timeRange: { startMs: 95_000, endMs: 110_000 } })
  })
})

/**
 * The MIRROR of T10/T11: the footage is right there and the ANALYTICS EVENT LOG
 * is the read that failed.
 *
 * It could not happen while one addon held both halves. It can now: the source
 * is registered by the addon that owns the footage and the events arrive from
 * another process over `ctx.api`, which can fail, time out, or answer from a
 * node that is offline.
 *
 * The answer follows the branch, because the two branches have different
 * truths behind them (D560):
 *
 *  - **Availability ANSWERED ⇒ a degraded list.** A visit is a window over
 *    recorded footage; events only ANNOTATE it. So the visits still exist,
 *    unannotated (no labels, no stills, no event ids) — and an availability
 *    read that answered `[]` produces an empty list that is TRUE about footage,
 *    which is exactly what a successful events read would have produced too.
 *  - **Availability unknown ⇒ a named refusal.** Without it the clips ARE the
 *    events, so an empty list would be the precise lie this line of work exists
 *    to end: "this camera has no recordings".
 *
 * Either way it is REPORTED, not only logged: the source row keeps saying so
 * until a later list reads its events.
 */
describe('createVideoclipsProvider — footage present, events unreachable', () => {
  const visitAvailability = (): (() => Promise<{ startMs: number; endMs: number }[]>) =>
    vi.fn(async () => [
      { startMs: 0, endMs: 40_000 },
      { startMs: 120_000, endMs: 160_000 },
    ])
  const unreachableEvents = (): (() => Promise<never>) =>
    vi.fn(async () => {
      throw new Error('pipelineAnalytics.getMotionEvents: node agent-a is offline')
    })

  it('lists the recorded visits UNANNOTATED rather than empty, and says so per camera', async () => {
    const warns: { message: string; meta: Record<string, unknown> }[] = []
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: unreachableEvents(),
      fetchAvailability: visitAvailability(),
      fetchMediaOwners: noOwners(),
      logWarn: (message, meta) => warns.push({ message, meta }),
      resolvePlayback: vi.fn(),
    })
    const clips = await provider.listClips({
      provider: RECORDER,
      deviceId: 101,
      since: 0,
      until: 200_000,
    })
    // Two visits: the gap is far wider than VISIT_MERGE_GAP_MS.
    expect(clips).toHaveLength(2)
    expect(clips.map((c) => c.timeRange)).toEqual([
      { startMs: 120_000, endMs: 160_000 },
      { startMs: 0, endMs: 40_000 },
    ])
    // Playable: the id still encodes the window, so getClipPlayback is
    // self-contained without a single event.
    expect(clips[0]!.id).toBe('analytics:120000:160000:visit')
    expect(clips.every((c) => c.thumbnail === undefined)).toBe(true)
    expect(clips.every((c) => c.labels === undefined)).toBe(true)
    expect(clips.every((c) => c.eventCount === 0)).toBe(true)
    // A branch that drops work says so, per camera.
    const degraded = warns.filter((w) => w.message.includes('event log unreachable'))
    expect(degraded).toHaveLength(1)
    expect(degraded[0]!.meta['deviceId']).toBe(101)
    expect(String(degraded[0]!.meta['error'])).toContain('agent-a is offline')
  })

  it('answers an empty list only when the FOOTAGE read said there is none', async () => {
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: unreachableEvents(),
      fetchAvailability: vi.fn(async () => []),
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    // Not a lie: with availability present a clip only ever comes from footage,
    // so this is the same answer a successful events read would have given.
    await expect(
      provider.listClips({ provider: RECORDER, deviceId: 101, since: 0, until: 200_000 }),
    ).resolves.toEqual([])
  })

  it('refuses BY NAME when neither the events nor the footage could be read', async () => {
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: unreachableEvents(),
      fetchAvailability: vi.fn(async () => {
        throw new Error('recording.getAvailability: no provider for device 101')
      }),
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    await expect(
      provider.listClips({ provider: RECORDER, deviceId: 101, since: 0, until: 200_000 }),
    ).rejects.toThrow(/agent-a is offline[\s\S]*no provider for device 101/)
  })

  it('refuses BY NAME when there is no footage read wired at all', async () => {
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: unreachableEvents(),
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    await expect(
      provider.listClips({ provider: RECORDER, deviceId: 101, since: 0, until: 200_000 }),
    ).rejects.toThrow(/agent-a is offline/)
  })

  it('REPORTS the degradation on the source row, and stops once a list reads its events', async () => {
    let broken = true
    const provider = createVideoclipsProvider({
      defaultPad: PAD,
      fetchEvents: vi.fn(async () => {
        if (broken) throw new Error('pipelineAnalytics unreachable')
        return { motion: [], object: [], audio: [] }
      }),
      fetchAvailability: visitAvailability(),
      fetchMediaOwners: noOwners(),
      resolvePlayback: vi.fn(),
    })
    // Before anything ran, nothing is claimed.
    expect((await provider.listSources({ deviceId: 101 }))[0]!.availability).toEqual({
      state: 'ok',
    })

    await provider.listClips({ provider: RECORDER, deviceId: 101, since: 0, until: 200_000 })
    const degraded = (await provider.listSources({ deviceId: 101 }))[0]!.availability
    // `ok`, not `unreachable`: rows SHIPPED. `unreachable` renders as "its
    // clips are missing from this list" beside a list that has them, and it is
    // the other camera's lie. The reason is what the operator reads.
    expect(degraded.state).toBe('ok')
    expect(degraded.reason).toContain('pipelineAnalytics unreachable')
    // Per camera: another device never touched is untouched.
    expect((await provider.listSources({ deviceId: 616 }))[0]!.availability).toEqual({
      state: 'ok',
    })

    broken = false
    await provider.listClips({ provider: RECORDER, deviceId: 101, since: 0, until: 200_000 })
    expect((await provider.listSources({ deviceId: 101 }))[0]!.availability).toEqual({
      state: 'ok',
    })
  })
})
