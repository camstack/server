/**
 * Every media row a cap hands out names WHERE its bytes are, by URL.
 *
 * ## Why this is a contract test and not a byte-size test
 *
 * `getTrackMedia {trackId, deviceId}` with no `kinds` measured **3 597 219 B**
 * on the live hub across 6 rows, of which `keyFrame` alone was 2 824 077 B — a
 * full-resolution frame, base64, so +33 % on the wire, uncacheable,
 * unstreamable, and materialised in hub-main's heap on the way past. The same
 * track's `thumbnailSmall` is 31 155 B.
 *
 * A byte assertion cannot express the fix, because the fix is not "smaller":
 * it is that the bytes leave the tRPC envelope entirely and are addressed
 * instead. So the assertion is on the ADDRESS — that every row, of every kind,
 * from every media method, carries a resolvable `event-media` plane URL built
 * from the row's OWN id.
 *
 * ## The id is the address, and the relabel must not change it (D482)
 *
 * A track's face/plate crops are STORED as `kind: 'crop'` under
 * `('face', 'face-<trackId>')` / `('plate', 'plate-<trackId>')` and PUBLISHED
 * as `faceCrop` / `plateCrop` (`track-media-scope.ts`). The plane resolves a
 * media row through `MediaStore.getById`, which knows only the row's own
 * surrogate id — so the URL built from `row.mediaId` (never from the
 * published `kind`) is what keeps a relabelled row resolvable. This is the
 * same hazard the old composite key carried under a different name: there the
 * url had to come from `row.key` verbatim or it 404'd exactly the face/plate
 * rows whose stored kind is `crop`; under D482 the id no longer spells the
 * kind at all, so the hazard is structurally gone rather than merely avoided.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AnalyticsQueryFacade } from '../analytics-query-facade.js'
import { MediaStore } from '../store/media-store.js'

const TRACK_ID = 'a3019e7a-ff67-4098-aae4-20dd552dedbe'
/** An event id is a per-table SQLite rowid (D474/D482), never a string. */
const EVENT_ID = 918_273
const DEVICE_ID = 102
/** What the addon serves the plane under: `/addon/<addonId>/event-media`. */
const PREFIX = '/addon/pipeline-analytics/event-media'

interface StoredRow {
  /** A media row's own id is a rowid (D482) — the generic store's shape keeps
   *  it as a string (`SettingsRecord.id`), and `MediaStore` converts with
   *  `Number(row.id)`, so a seeded row needs a NUMERIC string here. It is
   *  deliberately unrelated to the row's owner/kind (that is the whole point
   *  of D482) — these are arbitrary distinct rowids, not a re-derived key. */
  readonly id: string
  readonly data: Record<string, unknown>
}

const THUMBNAIL_SMALL_ID = '301'
const KEY_FRAME_ID = '302'
const PLATE_CROP_ID = '303'
const OBJECT_SNAPSHOT_ID = '304'

const ROWS: readonly StoredRow[] = [
  {
    id: THUMBNAIL_SMALL_ID,
    data: {
      ownerKind: 'track',
      ownerId: TRACK_ID,
      deviceId: DEVICE_ID,
      kind: 'thumbnailSmall',
      sizeBytes: 31_155,
      timestamp: 10,
      // Single-instance kind (D482): the write SLOT is `SINGLE_SLOT_TS`, not
      // the frame timestamp.
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
      sizeBytes: 2_824_077,
      timestamp: 12,
      slotTs: 0,
      path: 'b',
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
      // Accumulating kind: the slot IS the frame timestamp.
      slotTs: 15,
      path: 'd',
    },
  },
  {
    id: OBJECT_SNAPSHOT_ID,
    data: {
      ownerKind: 'object',
      ownerId: String(EVENT_ID),
      deviceId: DEVICE_ID,
      kind: 'snapshot',
      sizeBytes: 44_100,
      timestamp: 20,
      slotTs: 20,
      path: 'e',
    },
  },
]

const silentLogger: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
  withTags: () => silentLogger,
}

interface QueryFilter {
  readonly where?: Record<string, unknown>
}

interface QueryInput {
  readonly collection: string
  readonly filter?: QueryFilter
}

function harness(): AnalyticsQueryFacade {
  const settings = {
    query: {
      query: async (input: QueryInput): Promise<readonly StoredRow[]> => {
        const where = input.filter?.where ?? {}
        return ROWS.filter((row) =>
          Object.entries(where).every(([field, value]) => row.data[field] === value),
        )
      },
    },
    declareCollection: { mutate: async (): Promise<void> => undefined },
    set: { mutate: async (): Promise<void> => undefined },
    delete: { mutate: async (): Promise<void> => undefined },
  }
  const storage = {
    read: async (): Promise<Buffer> => Buffer.from('jpeg-bytes'),
    write: async (): Promise<void> => undefined,
    delete: async (): Promise<void> => undefined,
  }
  const store = new MediaStore({
    store: settings,
    storage,
    logger: silentLogger,
  } as unknown as ConstructorParameters<typeof MediaStore>[0])

  return new AnalyticsQueryFacade({
    trackStore: () => null,
    eventStore: () => null,
    mediaStore: () => store,
    sensorEventStore: () => null,
    opsLog: () => null,
    eventMediaBaseUrl: () => PREFIX,
    eventMediaPathPrefix: () => PREFIX,
    logger: () => silentLogger,
  })
}

describe('getTrackMedia addresses every row on the event-media plane', () => {
  it('gives every row a URL', async () => {
    const rows = await harness().getTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(row.url).toMatch(/^\/addon\/pipeline-analytics\/event-media\//)
  })

  it("builds the URL from the row's OWN id (D482), so the plane can resolve it", async () => {
    const rows = await harness().getTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    const keyFrame = rows.find((row) => row.kind === 'keyFrame')
    expect(keyFrame?.mediaId).toBe(Number(KEY_FRAME_ID))
    expect(keyFrame?.url).toBe(`${PREFIX}/m/${KEY_FRAME_ID}`)
  })

  it('addresses a RELABELLED detail crop by its OWN id (D482), not its published kind', async () => {
    // `MediaStore.getById` knows only the row's own id. A URL derived from
    // the published `plateCrop` name would 404 the one row this repo already
    // lost once to a red triangle — under D482 the id cannot spell the kind
    // at all, so this is now structural rather than merely tested.
    const rows = await harness().getTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    const plate = rows.find((row) => row.kind === 'plateCrop')
    expect(plate).toBeDefined()
    expect(plate?.mediaId).toBe(Number(PLATE_CROP_ID))
    expect(plate?.url).toBe(`${PREFIX}/m/${PLATE_CROP_ID}`)
  })

  it('addresses the 2.8 MB keyFrame the same way as the 31 KB thumbnail — no kind is bytes-only', async () => {
    const rows = await harness().getTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    const addressed = rows.filter((row) => row.url.length > 0)
    expect(addressed).toHaveLength(rows.length)
  })
})

describe('getEventMedia addresses every row on the event-media plane', () => {
  it('gives the event row a URL built from its own id (D482)', async () => {
    const rows = await harness().getEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.mediaId).toBe(Number(OBJECT_SNAPSHOT_ID))
    expect(rows[0]?.url).toBe(`${PREFIX}/m/${OBJECT_SNAPSHOT_ID}`)
  })

  // The merge seam. The `kind` filter is pushed INTO the query
  // (`media-read-amplification.spec.ts`), so the filtered read is a different
  // code path from the unfiltered one above — and the stamp has to survive it.
  // Neither half's own suite crosses here: the amplification spec counts blobs
  // and never looks at `url`, this one only ever asked unfiltered.
  it('still addresses the row when the kind is pushed into the query', async () => {
    const rows = await harness().getEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      kind: 'snapshot',
      deviceId: DEVICE_ID,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.url).toBe(`${PREFIX}/m/${OBJECT_SNAPSHOT_ID}`)
  })
})

describe('listTrackMedia carries the same URL as the byte read', () => {
  it('so a client never has to build the plane path itself', async () => {
    const facade = harness()
    const manifest = await facade.listTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    const bytes = await facade.getTrackMedia({ trackId: TRACK_ID, deviceId: DEVICE_ID })
    const manifestUrls = new Map(manifest.map((row) => [row.mediaId, row.url]))
    expect(bytes.length).toBeGreaterThan(0)
    for (const row of bytes) {
      // Assert the VALUE first. `undefined === undefined` is how a migration
      // test reports success on a field neither side has.
      expect(row.url.startsWith(PREFIX)).toBe(true)
      expect(manifestUrls.get(row.mediaId)).toBe(row.url)
    }
  })
})
