/**
 * A `kinds` filter must narrow the WORK, not just the wire.
 *
 * `getTrackMedia` / `getEventMedia` both accept a kind filter, and both used to
 * apply it to the ANSWER — `listByOwner` read every blob the owner holds, and
 * base64-encoded every one of them, before a single row was discarded. Measured
 * on the live hub (2026-08-30, storage drain stopped): one track's six kinds are
 * 3 597 219 bytes, of which `thumbnailSmall` is 31 155. Asking for
 * `kinds:['thumbnailSmall']` cost 0.37-0.96 s — the same as asking for all six —
 * because the same 3.6 MB was read and ~4.8 MB of base64 allocated either way.
 *
 * The load-bearing assertion here is on the REQUEST SHAPE — which blobs are
 * opened — never wall clock. `get-event-media-kind-filter.spec.ts` asserts the
 * returned rows and is green on both implementations; it cannot see this.
 *
 * The safety half matters as much: an unfiltered call must still open
 * everything, and a filtered call must still answer with the identical rows. A
 * read that quietly drops rows is how this repo lost 2 131 segments for 13 days.
 */

import type { IScopedLogger, MediaFile, MediaFileKind } from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { AnalyticsQueryFacade } from '../analytics-query-facade.js'
import { MediaStore } from '../store/media-store.js'
import {
  type FakeStorageProvider,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
} from './test-helpers.js'

const DEVICE_ID = 102
const TRACK_ID = 'trk-read-amplification'
/** An event id is a per-table SQLite rowid (D474/D482), never a string. */
const EVENT_ID = 501_314

/** The real six-kind set one track returns, with the measured byte sizes. */
const TRACK_KINDS: ReadonlyArray<readonly [MediaFileKind, number]> = [
  ['firstFrame', 187_000],
  ['keyFrame', 2_824_077],
  ['keyFrameSmall', 177_000],
  ['thumbnail', 200_000],
  ['thumbnailSmall', 31_155],
  ['lastFrame', 177_000],
]

interface Harness {
  readonly facade: AnalyticsQueryFacade
  readonly storage: FakeStorageProvider
}

async function makeHarness(): Promise<Harness> {
  const fake = makeFakeSettingsStore()
  const storage = makeFakeStorageProvider()
  const logger: IScopedLogger = makeSilentLogger()

  const mediaStore = new MediaStore({ storage, store: fake.client, logger })
  await MediaStore.declare(fake.client)

  for (const [kind, sizeBytes] of TRACK_KINDS) {
    await mediaStore.put({
      deviceId: DEVICE_ID,
      ownerKind: 'track',
      ownerId: TRACK_ID,
      kind,
      timestamp: 1_000 + TRACK_KINDS.findIndex(([k]) => k === kind),
      data: Buffer.alloc(sizeBytes, 1),
    })
  }
  for (const kind of ['crop', 'fullFrameBoxed', 'snapshot'] as const) {
    await mediaStore.put({
      deviceId: DEVICE_ID,
      ownerKind: 'object',
      ownerId: String(EVENT_ID),
      kind,
      timestamp: 2_000,
      data: Buffer.alloc(4_096, 2),
    })
  }

  const facade = new AnalyticsQueryFacade({
    trackStore: () => null,
    eventStore: () => null,
    mediaStore: () => mediaStore,
    sensorEventStore: () => null,
    opsLog: () => null,
    eventMediaBaseUrl: () => null,
    eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
    logger: () => logger,
  })
  // Writes read nothing; every read this spec counts is the one under test.
  storage.reads.length = 0
  return { facade, storage }
}

describe('a kinds filter narrows the blobs that are OPENED', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  it('getTrackMedia({kinds:[thumbnailSmall]}) opens exactly one blob', async () => {
    const rows = await h.facade.getTrackMedia({
      trackId: TRACK_ID,
      kinds: ['thumbnailSmall'],
      deviceId: DEVICE_ID,
    })

    expect(rows.map((r) => r.kind)).toEqual(['thumbnailSmall'])
    // The defect: all six are opened and base64'd, then five are thrown away.
    expect(h.storage.reads).toHaveLength(1)
  })

  it('getTrackMedia({kinds:[thumbnailSmall]}) does not read the 2.8 MB keyFrame', async () => {
    await h.facade.getTrackMedia({
      trackId: TRACK_ID,
      kinds: ['thumbnailSmall'],
      deviceId: DEVICE_ID,
    })
    expect(h.storage.reads.some((p) => p.includes('keyFrame'))).toBe(false)
  })

  it('getEventMedia({kind:crop}) opens exactly one blob', async () => {
    const rows = await h.facade.getEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      kind: 'crop',
      deviceId: DEVICE_ID,
    })

    expect(rows.map((r) => r.kind)).toEqual(['crop'])
    expect(h.storage.reads).toHaveLength(1)
  })
})

describe('narrowing the work never narrows the answer', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  it('an UNFILTERED getTrackMedia still opens every blob and answers with all six', async () => {
    const rows = await h.facade.getTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })

    expect(rows.map((r) => r.kind).toSorted()).toEqual(
      TRACK_KINDS.map(([k]) => k).toSorted() as MediaFileKind[],
    )
    expect(h.storage.reads).toHaveLength(TRACK_KINDS.length)
  })

  it('a filtered row is byte-identical to the same row from an unfiltered read', async () => {
    const filtered = await h.facade.getTrackMedia({
      trackId: TRACK_ID,
      kinds: ['thumbnailSmall'],
      deviceId: DEVICE_ID,
    })
    const all = await h.facade.getTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })

    const pick = (rows: readonly MediaFile[]): MediaFile | undefined =>
      rows.find((r) => r.kind === 'thumbnailSmall')
    expect(pick(filtered)?.base64).toBe(pick(all)?.base64)
    expect(pick(filtered)?.mediaId).toBe(pick(all)?.mediaId)
    expect(pick(filtered)?.sizeBytes).toBe(31_155)
  })

  it('a kind the track does not have answers empty without opening anything', async () => {
    const rows = await h.facade.getTrackMedia({
      trackId: TRACK_ID,
      kinds: ['plateCrop'],
      deviceId: DEVICE_ID,
    })
    expect(rows).toHaveLength(0)
    expect(h.storage.reads).toHaveLength(0)
  })
})
