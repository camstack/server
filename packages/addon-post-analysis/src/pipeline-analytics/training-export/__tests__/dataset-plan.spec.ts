/**
 * The plan is the "cheap question" (D56's third rule, which is not about
 * inference and applies to any bulk pass over stored media). What these tests
 * pin is that it stays cheap — index reads only — and that it walks the WHOLE
 * ownership fan-out, because a dataset silently missing its face crops is the
 * failure this module exists to avoid.
 */
import { describe, it, expect, vi } from 'vitest'
import type { Track } from '@camstack/types'
import { archivePathFor, buildTrainingExportPlan, type PlanReaders } from '../dataset-plan.js'

function track(partial: Partial<Track> & { trackId: string; deviceId: number }): Track {
  return {
    className: 'person',
    firstSeen: 1000,
    lastSeen: 2000,
    positions: [],
    snapshots: [],
    zonesVisited: [],
    totalDistance: 0,
    state: 'idle',
    active: false,
    ...partial,
  }
}

interface MediaRow {
  mediaId: number
  kind: string
  sizeBytes: number
  timestamp: number
}

function makeReaders(params: {
  tracksByDevice: Record<number, readonly Track[]>
  mediaByOwner?: Record<string, readonly MediaRow[]>
  eventsByTrack?: Record<string, readonly string[]>
}): PlanReaders & { readonly mediaCalls: string[] } {
  const mediaCalls: string[] = []
  return {
    mediaCalls,
    listMarkedTracks: vi.fn(async (deviceId: number, limit: number) =>
      (params.tracksByDevice[deviceId] ?? []).slice(0, limit),
    ),
    listMediaInfo: vi.fn(async (ownerKind: string, ownerId: string, _deviceId?: number) => {
      mediaCalls.push(`${ownerKind}:${ownerId}`)
      return params.mediaByOwner?.[`${ownerKind}:${ownerId}`] ?? []
    }),
    listEventIdsForTracks: vi.fn(async (trackIds: readonly string[]) =>
      trackIds.flatMap((trackId) =>
        (params.eventsByTrack?.[trackId] ?? []).map((eventId) => ({
          eventId,
          trackId,
          recordAt: 12,
        })),
      ),
    ),
    now: () => 5_000,
  }
}

describe('buildTrainingExportPlan — the ownership fan-out', () => {
  it('walks track, face, plate AND per-event owners', async () => {
    const readers = makeReaders({
      tracksByDevice: { 101: [track({ trackId: 't1', deviceId: 101 })] },
      eventsByTrack: { t1: ['ev-1'] },
    })

    await buildTrainingExportPlan(readers, { deviceIds: [101], maxTracks: 10 })

    // D476: per-event owners are 'object' now — listEventIdsForTracks returns
    // only OBJECT-event ids, and dataset-plan.ts owns them accordingly.
    expect(readers.mediaCalls).toEqual([
      'track:t1',
      'face:face-t1',
      'plate:plate-t1',
      'object:ev-1',
    ])
  })

  it('collects files from every scope into one track entry', async () => {
    const readers = makeReaders({
      tracksByDevice: { 101: [track({ trackId: 't1', deviceId: 101 })] },
      eventsByTrack: { t1: ['ev-1'] },
      mediaByOwner: {
        'track:t1': [{ mediaId: 101, kind: 'keyFrame', sizeBytes: 2000, timestamp: 10 }],
        'face:face-t1': [{ mediaId: 102, kind: 'faceCrop', sizeBytes: 300, timestamp: 11 }],
        'object:ev-1': [{ mediaId: 103, kind: 'crop', sizeBytes: 700, timestamp: 12 }],
      },
    })

    const plan = await buildTrainingExportPlan(readers, { deviceIds: [101], maxTracks: 10 })

    expect(plan.tracks[0]?.files.map((f) => f.archivePath)).toEqual([
      'tracks/101/t1/keyFrame.jpg',
      'tracks/101/t1/face/faceCrop-11.jpg',
      'tracks/101/t1/events/ev-1/crop-12.jpg',
    ])
    expect(plan.fileCount).toBe(3)
    expect(plan.byteCount).toBe(3000)
  })

  it('never reads a blob — the plan carries media IDS and sizes only', async () => {
    const readers = makeReaders({
      tracksByDevice: { 101: [track({ trackId: 't1', deviceId: 101 })] },
      mediaByOwner: {
        'track:t1': [{ mediaId: 101, kind: 'keyFrame', sizeBytes: 2000, timestamp: 10 }],
      },
    })

    const plan = await buildTrainingExportPlan(readers, { deviceIds: [101], maxTracks: 10 })

    const serialized = JSON.stringify(plan)
    expect(serialized).not.toContain('base64')
    expect(plan.tracks[0]?.files[0]?.mediaId).toBe(101)
  })

  it('refuses object media of another generation on a reused event id (D694)', async () => {
    const readers = makeReaders({
      tracksByDevice: { 101: [track({ trackId: 't1', deviceId: 101 })] },
      eventsByTrack: { t1: ['292786'] },
      mediaByOwner: {
        'object:292786': [
          { mediaId: 201, kind: 'crop', sizeBytes: 100, timestamp: 12 },
          { mediaId: 202, kind: 'crop', sizeBytes: 100, timestamp: 99 },
        ],
      },
    })

    const plan = await buildTrainingExportPlan(readers, { deviceIds: [101], maxTracks: 10 })

    expect(plan.tracks[0]?.files.map((f) => f.mediaId)).toEqual([201])
  })
})

describe('buildTrainingExportPlan — totals and bounds', () => {
  it('aggregates per device as well as overall', async () => {
    const readers = makeReaders({
      tracksByDevice: {
        101: [track({ trackId: 'a', deviceId: 101 })],
        102: [track({ trackId: 'b', deviceId: 102 })],
      },
      mediaByOwner: {
        'track:a': [{ mediaId: 104, kind: 'keyFrame', sizeBytes: 100, timestamp: 1 }],
        'track:b': [{ mediaId: 105, kind: 'keyFrame', sizeBytes: 250, timestamp: 1 }],
      },
    })

    const plan = await buildTrainingExportPlan(readers, { deviceIds: [101, 102], maxTracks: 10 })

    expect(plan.totals.toSorted((x, y) => x.deviceId - y.deviceId)).toEqual([
      { deviceId: 101, tracks: 1, files: 1, bytes: 100 },
      { deviceId: 102, tracks: 1, files: 1, bytes: 250 },
    ])
    expect(plan.byteCount).toBe(350)
  })

  it('stops at maxTracks and SAYS it was truncated', async () => {
    const readers = makeReaders({
      tracksByDevice: {
        101: [
          track({ trackId: 'a', deviceId: 101 }),
          track({ trackId: 'b', deviceId: 101 }),
          track({ trackId: 'c', deviceId: 101 }),
        ],
      },
    })

    const plan = await buildTrainingExportPlan(readers, { deviceIds: [101], maxTracks: 2 })

    expect(plan.trackCount).toBe(2)
    expect(plan.truncated).toBe(true)
  })

  it('reports truncated=false when everything fits', async () => {
    const readers = makeReaders({
      tracksByDevice: { 101: [track({ trackId: 'a', deviceId: 101 })] },
    })

    const plan = await buildTrainingExportPlan(readers, { deviceIds: [101], maxTracks: 2 })

    expect(plan.truncated).toBe(false)
  })

  it('spends the ceiling across devices rather than per device', async () => {
    const readers = makeReaders({
      tracksByDevice: {
        101: [track({ trackId: 'a', deviceId: 101 }), track({ trackId: 'b', deviceId: 101 })],
        102: [track({ trackId: 'c', deviceId: 102 })],
      },
    })

    const plan = await buildTrainingExportPlan(readers, { deviceIds: [101, 102], maxTracks: 2 })

    expect(plan.tracks.map((t) => t.trackId)).toEqual(['a', 'b'])
  })
})

describe('archivePathFor', () => {
  it('omits the timestamp for a single-instance kind', () => {
    expect(
      archivePathFor({
        deviceId: 101,
        trackId: 't1',
        scope: '',
        kind: 'keyFrame',
        timestamp: 99,
        singleInstance: true,
      }),
    ).toBe('tracks/101/t1/keyFrame.jpg')
  })

  it('keeps a scope segment so a track crop and an event crop cannot collide', () => {
    const trackCrop = archivePathFor({
      deviceId: 101,
      trackId: 't1',
      scope: '',
      kind: 'crop',
      timestamp: 42,
      singleInstance: false,
    })
    const eventCrop = archivePathFor({
      deviceId: 101,
      trackId: 't1',
      scope: 'events/ev-1',
      kind: 'crop',
      timestamp: 42,
      singleInstance: false,
    })

    expect(trackCrop).not.toBe(eventCrop)
  })
})
