/**
 * A track's media listings must SEE its face and plate crops.
 *
 * ## The production shape this reproduces
 *
 * The plate crop of track `T` is stored as
 *
 *     key        plate:plate-T:crop:<ts>
 *     ownerKind  'plate'      ownerId 'plate-T'      kind 'crop'
 *
 * and the face crop the same way under `('face', 'face-T')`. Both listings
 * asked `listByOwner('track', T)` and therefore never saw either row: measured
 * on three live tracks, `listTrackMedia` answered 6-7 rows with no plate while
 * `plateGallery.getPlateByTrack` returned the crop for all three.
 *
 * What that cost: the viewer's detail added a synthetic `plateCrop` tile from
 * the plate gallery and then asked `getTrackMedia({ kinds: ['plateCrop'] })`
 * for its bytes. Wrong owner AND wrong kind — the answer was `[]`, which the
 * per-entry loader reports as a FAILED read (the red triangle) rather than as
 * absence. `faceCrop` sat in the same client-side list, one merged tile away
 * from the identical failure.
 *
 * These tests drive the REAL `MediaStore` (its own `where` matching, its own
 * blob reads) through the REAL facade, so the owner routing is exercised end to
 * end and not restated by a fake.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AnalyticsQueryFacade } from '../analytics-query-facade.js'
import { MediaStore } from '../store/media-store.js'

const TRACK_ID = 'a3019e7a-ff67-4098-aae4-20dd552dedbe'
const DEVICE_ID = 102

interface StoredRow {
  /** A media row's own id is a rowid (D482) — the generic store's shape keeps
   *  it as a string, and `MediaStore` converts with `Number(row.id)`, so a
   *  seeded row needs a NUMERIC string here. */
  readonly id: string
  readonly data: Record<string, unknown>
}

const THUMBNAIL_SMALL_ID = '801'
const KEY_FRAME_ID = '802'
const FACE_CROP_ID = '803'
const PLATE_CROP_ID = '804'
const OTHER_TRACK_PLATE_CROP_ID = '805'

/** The row set of a real vehicle track: its own media, plus BOTH detail crops
 *  under their prefixed owners, all with the stored `kind: 'crop'`. */
const ROWS: readonly StoredRow[] = [
  {
    id: THUMBNAIL_SMALL_ID,
    data: {
      ownerKind: 'track',
      ownerId: TRACK_ID,
      deviceId: DEVICE_ID,
      kind: 'thumbnailSmall',
      sizeBytes: 111_570,
      timestamp: 10,
      // Single-instance kind (D482): the write SLOT is `SINGLE_SLOT_TS`.
      slotTs: 0,
      path: 'a',
    },
  },
  {
    id: KEY_FRAME_ID,
    data: {
      ownerKind: 'track',
      ownerId: TRACK_ID,
      deviceId: DEVICE_ID,
      kind: 'keyFrame',
      sizeBytes: 1_861_758,
      timestamp: 12,
      slotTs: 0,
      path: 'b',
    },
  },
  {
    id: FACE_CROP_ID,
    data: {
      ownerKind: 'face',
      ownerId: `face-${TRACK_ID}`,
      deviceId: DEVICE_ID,
      kind: 'crop',
      sizeBytes: 8_204,
      timestamp: 14,
      // Accumulating kind: the slot IS the frame timestamp.
      slotTs: 14,
      path: 'c',
    },
  },
  {
    id: PLATE_CROP_ID,
    data: {
      ownerKind: 'plate',
      ownerId: `plate-${TRACK_ID}`,
      deviceId: DEVICE_ID,
      kind: 'crop',
      sizeBytes: 6_180,
      timestamp: 15,
      slotTs: 15,
      path: 'd',
    },
  },
  // A different track's plate — the owner filter must not hand it over.
  {
    id: OTHER_TRACK_PLATE_CROP_ID,
    data: {
      ownerKind: 'plate',
      ownerId: 'plate-other',
      deviceId: DEVICE_ID,
      kind: 'crop',
      sizeBytes: 5_000,
      timestamp: 16,
      slotTs: 16,
      path: 'e',
    },
  },
]

interface QueryFilter {
  readonly where?: Record<string, unknown>
}

interface QueryInput {
  readonly collection: string
  readonly filter?: QueryFilter
}

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

interface Harness {
  readonly facade: AnalyticsQueryFacade
  readonly blobReads: () => number
}

/** A real `MediaStore` over an in-memory collection that honours `where`. */
function harness(rows: readonly StoredRow[] = ROWS): Harness {
  let reads = 0
  const settings = {
    query: {
      query: async (input: QueryInput): Promise<readonly StoredRow[]> => {
        const where = input.filter?.where ?? {}
        return rows.filter((row) =>
          Object.entries(where).every(([field, value]) => row.data[field] === value),
        )
      },
    },
    declareCollection: { mutate: async (): Promise<void> => undefined },
    set: { mutate: async (): Promise<void> => undefined },
    delete: { mutate: async (): Promise<void> => undefined },
  }
  const storage = {
    read: async (): Promise<Buffer> => {
      reads += 1
      return Buffer.from('jpeg-bytes')
    },
    write: async (): Promise<void> => undefined,
    delete: async (): Promise<void> => undefined,
  }
  const store = new MediaStore({
    store: settings,
    storage,
    logger: silentLogger,
  } as unknown as ConstructorParameters<typeof MediaStore>[0])

  const facade = new AnalyticsQueryFacade({
    trackStore: () => null,
    eventStore: () => null,
    mediaStore: () => store,
    sensorEventStore: () => null,
    opsLog: () => null,
    eventMediaBaseUrl: () => null,
    eventMediaPathPrefix: () => '/addon/pipeline-analytics/event-media',
    logger: () => silentLogger,
  })
  return { facade, blobReads: () => reads }
}

// ─── The manifest ────────────────────────────────────────────────────────────

describe('listTrackMedia sees the detail crops', () => {
  it('lists the plate crop — the row the strip could never find', async () => {
    const { facade } = harness()
    const info = await facade.listTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    expect(info.map((row) => row.kind)).toContain('plateCrop')
  })

  it('lists the face crop under the same rule', async () => {
    const { facade } = harness()
    const info = await facade.listTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    expect(info.map((row) => row.kind)).toContain('faceCrop')
  })

  it('publishes them as faceCrop / plateCrop, never as the stored `crop`', async () => {
    // A wire row carries no `ownerKind`, so `crop` here would be
    // indistinguishable from the track's own body crop — and the `kinds`
    // filter the viewer's per-entry fetch is built on could not name one
    // without the other.
    const { facade } = harness()
    const info = await facade.listTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    expect(info.map((row) => row.kind)).not.toContain('crop')
  })

  it('keeps the media id (D482) the data plane serves the tile from', async () => {
    const { facade } = harness()
    const info = await facade.listTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    const plate = info.find((row) => row.kind === 'plateCrop')
    expect(plate?.mediaId).toBe(Number(PLATE_CROP_ID))
  })

  it('never hands over another track’s plate', async () => {
    const { facade } = harness()
    const info = await facade.listTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    expect(info.map((row) => row.mediaId)).not.toContain(Number(OTHER_TRACK_PLATE_CROP_ID))
  })

  it('still reads no blob — the manifest is index rows only', async () => {
    const { facade, blobReads } = harness()
    await facade.listTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    expect(blobReads()).toBe(0)
  })
})

// ─── The byte read the viewer actually issues ────────────────────────────────

describe('getTrackMedia answers the kind the manifest advertised', () => {
  it('serves the plate crop for kinds: [plateCrop] — it used to answer []', async () => {
    const { facade } = harness()
    const rows = await facade.getTrackMedia({
      trackId: TRACK_ID,
      deviceId: DEVICE_ID,
      kinds: ['plateCrop'],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('plateCrop')
    expect(rows[0]?.base64.length).toBeGreaterThan(0)
  })

  it('serves the face crop for kinds: [faceCrop]', async () => {
    const { facade } = harness()
    const rows = await facade.getTrackMedia({
      trackId: TRACK_ID,
      deviceId: DEVICE_ID,
      kinds: ['faceCrop'],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('faceCrop')
  })

  it('every manifest kind can be fetched back — the two listings agree', async () => {
    // The disagreement IS the defect: an entry the manifest vouched for whose
    // byte read comes back empty is reported to the operator as a failed read.
    const { facade } = harness()
    const info = await facade.listTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    for (const row of info) {
      const rows = await facade.getTrackMedia({
        trackId: TRACK_ID,
        deviceId: DEVICE_ID,
        kinds: [row.kind],
      })
      expect(rows.map((r) => r.mediaId)).toContain(row.mediaId)
    }
  })

  it('a request naming no detail kind never opens the face/plate owners', async () => {
    // The common per-entry fetch. Those owners can only ever publish
    // faceCrop/plateCrop, so reading them here would be pure cost.
    const { facade, blobReads } = harness()
    const rows = await facade.getTrackMedia({
      trackId: TRACK_ID,
      deviceId: DEVICE_ID,
      kinds: ['keyFrame'],
    })
    expect(rows.map((r) => r.kind)).toEqual(['keyFrame'])
    expect(blobReads()).toBe(2) // the track's own two rows, and nothing else
  })

  it('an unfiltered read returns the whole set, oldest first', async () => {
    const { facade } = harness()
    const rows = await facade.getTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    expect(rows.map((r) => r.kind)).toEqual(['thumbnailSmall', 'keyFrame', 'faceCrop', 'plateCrop'])
  })
})
