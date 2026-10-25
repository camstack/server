/**
 * The `debug.*` bodies over a fake inventory.
 *
 * What this file exists to pin, beyond the happy path:
 *
 *  - **face and plate crops count.** They hang off `face-<trackId>` /
 *    `plate-<trackId>`, not `track:<trackId>`, and an inventory that reads only
 *    the first owner reports MISSING_BEST_CROP on every track that produced a
 *    face — the opposite of the truth.
 *  - **a vanished track is reported, not dropped.** A `debug` mark does not pin
 *    retention (D81), so an id CAN stop resolving between the list and the
 *    analysis.
 *  - **the export plan asks for each track's events ONCE.** They are needed
 *    twice (the count, and `events.json`) and the seam is a real query.
 */
import type { MediaFileInfo, ObjectEvent, Track } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeTestMediaFileInfo } from '../../../__tests__/support/media-file.js'
import { makeTestObjectEvent } from '../../../__tests__/support/events.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import type { MediaProvenance } from '../../store/media-store.js'
import { MAX_EXPORT_TRACKS } from '../debug-actions.js'
import {
  analyzeDebugTracks,
  buildDebugBundlePlan,
  type DebugServiceDeps,
  listDebugTracks,
} from '../debug-service.js'

const T0 = 1_700_000_000_000

function track(over: Partial<Track> & Pick<Track, 'trackId' | 'deviceId'>): Track {
  return {
    className: 'person',
    firstSeen: T0,
    lastSeen: T0 + 30_000,
    positions: [{ x: 1, y: 1, timestamp: T0, bbox: { x: 0, y: 0, w: 1, h: 1 } }],
    snapshots: [],
    zonesVisited: [],
    totalDistance: 0,
    state: 'idle',
    active: false,
    ...over,
  }
}

function mediaInfo(kind: MediaFileInfo['kind'], mediaId: number): MediaFileInfo {
  return makeTestMediaFileInfo({ mediaId, kind, sizeBytes: 100, timestamp: T0 })
}

function event(trackId: string): ObjectEvent {
  return makeTestObjectEvent({
    deviceId: 101,
    timestamp: T0,
    trackId,
    className: 'person',
    confidence: 0.9,
  })
}

interface FakeWorld {
  readonly tracksByDevice?: ReadonlyMap<number, readonly Track[]>
  readonly mediaByOwner?: ReadonlyMap<string, readonly MediaFileInfo[]>
  readonly eventsByTrack?: ReadonlyMap<string, readonly ObjectEvent[]>
  /** Absent from the map = no thumbnail row (`null`), matching the store. */
  readonly thumbnailProvenanceByTrack?: ReadonlyMap<string, MediaProvenance>
  /** Media ids (D482) whose blob cannot be read — the index row is there, the
   *  bytes are not. Everything else probes readable. */
  readonly unreadableMediaIds?: ReadonlySet<number>
}

function makeDeps(world: FakeWorld): DebugServiceDeps & { listEvents: ReturnType<typeof vi.fn> } {
  const tracksByDevice = world.tracksByDevice ?? new Map()
  const all = [...tracksByDevice.values()].flat()
  const listEvents = vi.fn(
    async (trackId: string) => world.eventsByTrack?.get(trackId) ?? ([] as readonly ObjectEvent[]),
  )
  return {
    listDeviceIds: async () => [...tracksByDevice.keys()],
    listDebugTracks: async (deviceId, limit) =>
      (tracksByDevice.get(deviceId) ?? []).slice(0, limit),
    getTrack: async (trackId) => all.find((t) => t.trackId === trackId) ?? null,
    listMediaInfo: async (ownerKind, ownerId) =>
      world.mediaByOwner?.get(`${ownerKind}:${ownerId}`) ?? [],
    listEvents,
    trackThumbnailProvenance: async (trackId) =>
      world.thumbnailProvenanceByTrack?.get(trackId) ?? null,
    // Readable unless the world says otherwise. The default matters: a fake
    // that answered "unreadable" by omission would put the new finding on every
    // fixture and hide the rule it exists to prove.
    probeMediaBlob: async (mediaId) => !(world.unreadableMediaIds?.has(mediaId) ?? false),
    logger: makeSilentLogger(),
    now: () => T0,
  }
}

describe('listDebugTracks', () => {
  it('returns every camera’s marked tracks, newest first across cameras', async () => {
    const deps = makeDeps({
      tracksByDevice: new Map([
        [101, [track({ trackId: 'a', deviceId: 101, lastSeen: T0 + 1_000 })]],
        [102, [track({ trackId: 'b', deviceId: 102, lastSeen: T0 + 9_000 })]],
      ]),
    })

    const out = await listDebugTracks(deps, {})

    expect(out.tracks.map((t) => t.trackId)).toEqual(['b', 'a'])
    expect(out.truncated).toBe(false)
  })

  it('restricts to the requested cameras', async () => {
    const deps = makeDeps({
      tracksByDevice: new Map([
        [101, [track({ trackId: 'a', deviceId: 101 })]],
        [102, [track({ trackId: 'b', deviceId: 102 })]],
      ]),
    })

    const out = await listDebugTracks(deps, { deviceIds: [102] })

    expect(out.tracks.map((t) => t.trackId)).toEqual(['b'])
  })

  it('says so when a camera fills the limit, rather than stopping silently', async () => {
    const deps = makeDeps({
      tracksByDevice: new Map([
        [101, [track({ trackId: 'a', deviceId: 101 }), track({ trackId: 'b', deviceId: 101 })]],
      ]),
    })

    expect((await listDebugTracks(deps, { limit: 2 })).truncated).toBe(true)
    expect((await listDebugTracks(deps, { limit: 5 })).truncated).toBe(false)
  })

  it('carries the derived duration', async () => {
    const deps = makeDeps({
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101 })]]]),
    })
    const item = (await listDebugTracks(deps, {})).tracks[0]
    expect(item?.durationMs).toBe(30_000)
  })

  it('never asks the store for a full row — the list carries no trajectory', async () => {
    // `listDebug` returns `slim` rows on purpose: `positions` is a ~10 KB JSON
    // column, and parsing it for every row of every camera is the cost this
    // surface must not have. `getTrack` (the full read) belongs to `analyze`.
    const deps = makeDeps({
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101 })]]]),
    })
    const getTrack = vi.fn(deps.getTrack)
    await listDebugTracks({ ...deps, getTrack }, {})
    expect(getTrack).not.toHaveBeenCalled()
  })
})

/**
 * D276 — a stand-in tile is REPORTED, never shown as if it were a best shot.
 *
 * The provenance is store-internal and never reaches a cap output, so this
 * bridge is the only path it has to a screen. Both directions are pinned:
 * `standin` produces the finding, and a tile too old to classify (which the
 * store answers `native` for) produces nothing — "we cannot tell" must not
 * render as an accusation.
 */
describe('the best-shot provenance findings', () => {
  function completeWorld(provenance?: MediaProvenance): FakeWorld {
    return {
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101 })]]]),
      mediaByOwner: new Map([
        [
          'track:a',
          [
            mediaInfo('keyFrame', 1),
            mediaInfo('firstFrame', 2),
            mediaInfo('lastFrame', 3),
            mediaInfo('thumbnail', 4),
            mediaInfo('crop', 5),
          ],
        ],
      ]),
      eventsByTrack: new Map([['a', [event('a')]]]),
      ...(provenance === undefined
        ? {}
        : { thumbnailProvenanceByTrack: new Map([['a', provenance]]) }),
    }
  }

  it('reports BEST_SHOT_STANDIN for a face crop standing in for the subject', async () => {
    const out = await analyzeDebugTracks(makeDeps(completeWorld('standin')), { trackIds: ['a'] })

    expect(out.reports[0]?.findings.map((f) => f.code)).toContain('BEST_SHOT_STANDIN')
    expect(out.reports[0]?.thumbnailProvenance).toBe('standin')
  })

  it('reports BEST_SHOT_RASTER, at info, for a sub-native subject crop', async () => {
    const out = await analyzeDebugTracks(makeDeps(completeWorld('raster')), { trackIds: ['a'] })

    const raster = out.reports[0]?.findings.find((f) => f.code === 'BEST_SHOT_RASTER')
    expect(raster?.severity).toBe('info')
    expect(out.reports[0]?.thumbnailProvenance).toBe('raster')
  })

  it('says NOTHING for a native tile, and nothing for one it cannot classify', async () => {
    const native = await analyzeDebugTracks(makeDeps(completeWorld('native')), { trackIds: ['a'] })
    const unknown = await analyzeDebugTracks(makeDeps(completeWorld()), { trackIds: ['a'] })

    // Assert the report EXISTS first: an "absence" assertion passes against a
    // report that was never produced.
    expect(native.reports).toHaveLength(1)
    expect(unknown.reports).toHaveLength(1)
    for (const report of [native.reports[0], unknown.reports[0]]) {
      expect(report?.findings.map((f) => f.code)).not.toContain('BEST_SHOT_STANDIN')
      expect(report?.findings.map((f) => f.code)).not.toContain('BEST_SHOT_RASTER')
    }
    expect(native.reports[0]?.thumbnailProvenance).toBe('native')
    expect(unknown.reports[0]?.thumbnailProvenance).toBeUndefined()
  })

  it('carries the close’s own previewMissReason through onto the report', async () => {
    const world: FakeWorld = {
      tracksByDevice: new Map([
        [
          101,
          [
            track({
              trackId: 'a',
              deviceId: 101,
              previewMissReason: 'no-key-frame capture=keyframe:native-missx4',
            }),
          ],
        ],
      ]),
      eventsByTrack: new Map([['a', [event('a')]]]),
    }

    const out = await analyzeDebugTracks(makeDeps(world), { trackIds: ['a'] })

    expect(out.reports[0]?.previewMissReason).toBe('no-key-frame capture=keyframe:native-missx4')
  })
})

describe('analyzeDebugTracks', () => {
  it('counts a face crop as a crop — it hangs off the `face-` owner', async () => {
    const deps = makeDeps({
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101 })]]]),
      mediaByOwner: new Map([
        [
          'track:a',
          [
            mediaInfo('keyFrame', 1),
            mediaInfo('firstFrame', 2),
            mediaInfo('lastFrame', 3),
            mediaInfo('thumbnail', 4),
          ],
        ],
        ['face:face-a', [mediaInfo('faceCrop', 5)]],
      ]),
      eventsByTrack: new Map([['a', [event('a')]]]),
    })

    const out = await analyzeDebugTracks(deps, { trackIds: ['a'] })

    expect(out.reports[0]?.findings.map((f) => f.code)).not.toContain('MISSING_BEST_CROP')
    expect(out.reports[0]?.mediaCount).toBe(5)
    expect(out.reports[0]?.eventCount).toBe(1)
  })

  // D400: the finding is scoped to a track that OWED a crop — one whose face
  // detail actually ran. Without `hasFace` the absence is the normal shape and
  // reporting it made the code fire on 10 of 14 audited tracks, healthy ones
  // included.
  it('reports MISSING_BEST_CROP when a face ran and neither owner holds a crop', async () => {
    const deps = makeDeps({
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101, hasFace: true })]]]),
      mediaByOwner: new Map([
        [
          'track:a',
          [
            mediaInfo('keyFrame', 1),
            mediaInfo('firstFrame', 2),
            mediaInfo('lastFrame', 3),
            mediaInfo('thumbnail', 4),
          ],
        ],
      ]),
      eventsByTrack: new Map([['a', [event('a')]]]),
    })

    const out = await analyzeDebugTracks(deps, { trackIds: ['a'] })

    expect(out.reports[0]?.findings.map((f) => f.code)).toContain('MISSING_BEST_CROP')
  })

  it('is SILENT when no detail ran — the crop was never owed (D400)', async () => {
    const deps = makeDeps({
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101 })]]]),
      mediaByOwner: new Map([
        [
          'track:a',
          [
            mediaInfo('keyFrame', 1),
            mediaInfo('firstFrame', 2),
            mediaInfo('lastFrame', 3),
            mediaInfo('thumbnail', 4),
          ],
        ],
      ]),
      eventsByTrack: new Map([['a', [event('a')]]]),
    })

    const out = await analyzeDebugTracks(deps, { trackIds: ['a'] })

    expect(out.reports[0]?.findings.map((f) => f.code)).not.toContain('MISSING_BEST_CROP')
  })

  it('reports an id that no longer resolves as vanished, not as a missing row', async () => {
    const deps = makeDeps({
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101 })]]]),
    })

    const out = await analyzeDebugTracks(deps, { trackIds: ['a', 'evicted'] })

    expect(out.reports.map((r) => r.trackId)).toEqual(['a'])
    expect(out.vanished).toEqual(['evicted'])
  })
})

describe('buildDebugBundlePlan', () => {
  it('plans one entry per marked track, with its media names and its events', async () => {
    const ev = event('a')
    const deps = makeDeps({
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101 })]]]),
      mediaByOwner: new Map([['track:a', [mediaInfo('keyFrame', 1)]]]),
      eventsByTrack: new Map([['a', [ev]]]),
    })

    const plan = await buildDebugBundlePlan(deps, [])

    expect(plan.deviceIds).toEqual([101])
    expect(plan.tracks).toHaveLength(1)
    expect(plan.tracks[0]?.media.map((m) => m.name)).toEqual(['media/keyFrame.jpg'])
    expect(plan.tracks[0]?.events).toEqual([ev])
    expect(plan.tracks[0]?.report.eventCount).toBe(1)
  })

  it('asks for a track’s events exactly ONCE — they are needed twice', async () => {
    const deps = makeDeps({
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101 })]]]),
      eventsByTrack: new Map([['a', [event('a')]]]),
    })

    await buildDebugBundlePlan(deps, [])

    expect(deps.listEvents).toHaveBeenCalledTimes(1)
  })

  it('omits a camera that has nothing marked from the manifest’s device list', async () => {
    const deps = makeDeps({
      tracksByDevice: new Map([
        [101, [track({ trackId: 'a', deviceId: 101 })]],
        [102, []],
      ]),
    })

    expect((await buildDebugBundlePlan(deps, [])).deviceIds).toEqual([101])
  })
})

describe('the export bounds', () => {
  /** More marked tracks than one bundle may carry. */
  function crowdedWorld(count: number): FakeWorld {
    return {
      tracksByDevice: new Map([
        [
          101,
          Array.from({ length: count }, (_, i) =>
            track({ trackId: `t-${String(i)}`, deviceId: 101 }),
          ),
        ],
      ]),
    }
  }

  it('stops the plan at the per-export track cap, and SAYS it stopped', async () => {
    const deps = makeDeps(crowdedWorld(MAX_EXPORT_TRACKS + 5))

    const plan = await buildDebugBundlePlan(deps, [])

    expect(plan.tracks).toHaveLength(MAX_EXPORT_TRACKS)
    expect(plan.capped).toBe(true)
  })

  it('does not claim to be capped when everything marked fits', async () => {
    const plan = await buildDebugBundlePlan(makeDeps(crowdedWorld(3)), [])
    expect(plan.tracks).toHaveLength(3)
    expect(plan.capped).toBe(false)
  })

  it('re-reads each exported track at FULL projection', async () => {
    // The plan is built from `slim` list rows; without the re-read every bundled
    // track would carry an empty `positions` array and report ZERO_POSITIONS.
    const deps = makeDeps({
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101 })]]]),
    })
    const getTrack = vi.fn(deps.getTrack)

    const plan = await buildDebugBundlePlan({ ...deps, getTrack }, [])

    expect(getTrack).toHaveBeenCalledWith('a')
    expect(plan.tracks[0]?.report.positionCount).toBe(1)
    expect(plan.tracks[0]?.report.findings.map((f) => f.code)).not.toContain('ZERO_POSITIONS')
  })
})

describe('a media row whose blob cannot be read', () => {
  it('is reported, end to end, instead of being counted as media that exists', async () => {
    // The live shape, 2026-09-08: six index rows, every blob unreachable. The
    // report must still COUNT six (that is what the index holds) and say that
    // none of them can be drawn — a count silently reduced to zero would read
    // as eviction, and the bytes may be sitting on the disk under a location
    // the row no longer names.
    const rows: readonly MediaFileInfo[] = [
      makeTestMediaFileInfo({ mediaId: 1, kind: 'keyFrame', sizeBytes: 10, timestamp: T0 }),
      makeTestMediaFileInfo({ mediaId: 2, kind: 'thumbnail', sizeBytes: 10, timestamp: T0 }),
    ]
    const deps = makeDeps({
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101 })]]]),
      mediaByOwner: new Map([['track:a', rows]]),
      unreadableMediaIds: new Set([1, 2]),
    })

    const out = await analyzeDebugTracks(deps, { trackIds: ['a'] })

    const report = out.reports[0]
    expect(report?.mediaCount).toBe(2)
    const codes = report?.findings.map((f) => f.code) ?? []
    expect(codes).toContain('MEDIA_ROW_WITHOUT_BLOB')
    expect(codes).not.toContain('MEDIA_EVICTED_OR_NEVER')
  })

  it('says nothing when the blobs read', async () => {
    const rows: readonly MediaFileInfo[] = [
      makeTestMediaFileInfo({ mediaId: 1, kind: 'keyFrame', sizeBytes: 10, timestamp: T0 }),
    ]
    const deps = makeDeps({
      tracksByDevice: new Map([[101, [track({ trackId: 'a', deviceId: 101 })]]]),
      mediaByOwner: new Map([['track:a', rows]]),
    })

    const out = await analyzeDebugTracks(deps, { trackIds: ['a'] })

    expect(out.reports[0]?.findings.map((f) => f.code)).not.toContain('MEDIA_ROW_WITHOUT_BLOB')
  })
})
