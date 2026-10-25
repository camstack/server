/**
 * `listEventMedia` — the byte-less twin `getEventMedia` never had.
 *
 * ## The surface this exists for
 *
 * The track DETAIL modal is the heaviest surface in the application and the
 * one most tempting to leave on base64, because it is the one that legitimately
 * renders the BIG kinds — `keyFrame`, `fullFrame`, `firstFrame`, `lastFrame`.
 * Measured on the live hub for one track: 6 rows / 3 597 219 B, `keyFrame`
 * alone 2 824 077 B.
 *
 * The admin UI's panel already paints every pixel from the `event-media` plane
 * by key. It nonetheless calls `getEventMedia`, whose docblock said in as many
 * words that the bytes are "never read for rendering… only because it has no
 * manifest twin yet". So the panel pays a full-resolution base64 payload, on
 * every open, for a list of keys — and then throws the bytes away.
 *
 * ## Why the assertion is a READ COUNT and not a byte count
 *
 * The obvious implementation is `getEventMedia` with `base64` deleted on the
 * way out. That shrinks the response and does exactly the same work: the path
 * reads every blob off disk and base64-encodes it first. A byte assertion
 * passes on that; a blob-read assertion does not. `media-manifest.spec.ts`
 * makes the same point for the track side — this is the event side of it.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AnalyticsQueryFacade } from '../analytics-query-facade.js'
import { MediaStore } from '../store/media-store.js'

/** An event id is a per-table SQLite rowid (D474/D482), never a string. */
const EVENT_ID = 918_273
const DEVICE_ID = 102
const PREFIX = '/addon/pipeline-analytics/event-media'

interface StoredRow {
  /** A media row's own id is a rowid (D482) — the generic store's shape keeps
   *  it as a string, and `MediaStore` converts with `Number(row.id)`, so a
   *  seeded row needs a NUMERIC string here. */
  readonly id: string
  readonly data: Record<string, unknown>
}

/** An old-style OBJECT event row set (D476: `ownerKind` is `object`, not the
 *  pre-migration `event`): the retired `crop` plus the native-resolution
 *  `fullFrameBoxed` that makes this response megabytes. */
const ROWS: readonly StoredRow[] = [
  {
    id: '701',
    data: {
      ownerKind: 'object',
      ownerId: String(EVENT_ID),
      deviceId: DEVICE_ID,
      kind: 'crop',
      sizeBytes: 44_100,
      timestamp: 20,
      slotTs: 20,
      path: 'a',
    },
  },
  {
    id: '702',
    data: {
      ownerKind: 'object',
      ownerId: String(EVENT_ID),
      deviceId: DEVICE_ID,
      kind: 'fullFrameBoxed',
      sizeBytes: 2_824_077,
      timestamp: 21,
      slotTs: 21,
      path: 'b',
    },
  },
  // Another camera's event media — the deviceId filter must not hand it over.
  {
    id: '703',
    data: {
      ownerKind: 'object',
      ownerId: 'other',
      deviceId: 104,
      kind: 'crop',
      sizeBytes: 1_000,
      timestamp: 22,
      slotTs: 22,
      path: 'c',
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

interface Harness {
  readonly facade: AnalyticsQueryFacade
  readonly blobReads: () => number
}

function harness(): Harness {
  let reads = 0
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
    eventMediaBaseUrl: () => PREFIX,
    eventMediaPathPrefix: () => PREFIX,
    logger: () => silentLogger,
  })
  return { facade, blobReads: () => reads }
}

describe('listEventMedia', () => {
  it('reads NO blob — the whole point', async () => {
    const { facade, blobReads } = harness()
    await facade.listEventMedia({ ownerType: 'object', eventId: EVENT_ID, deviceId: DEVICE_ID })
    expect(blobReads()).toBe(0)
  })

  it('reads a blob per row through getEventMedia — the cost this replaces', async () => {
    // Guards the claim above: without this, "0 reads" could mean the harness
    // never reads blobs at all and the manifest proves nothing.
    const { facade, blobReads } = harness()
    await facade.getEventMedia({ ownerType: 'object', eventId: EVENT_ID, deviceId: DEVICE_ID })
    expect(blobReads()).toBe(2)
  })

  it('still answers for every row the byte read would have', async () => {
    const { facade } = harness()
    const manifest = await facade.listEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
    })
    const bytes = await facade.getEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
    })
    expect(manifest.map((row) => row.mediaId).toSorted()).toEqual(
      bytes.map((row) => row.mediaId).toSorted(),
    )
  })

  it('keeps the kind and the size a `kinds` filter would destroy', async () => {
    const { facade } = harness()
    const byKind = new Map(
      (
        await facade.listEventMedia({ ownerType: 'object', eventId: EVENT_ID, deviceId: DEVICE_ID })
      ).map((row) => [row.kind, row]),
    )
    expect(byKind.get('fullFrameBoxed')?.sizeBytes).toBe(2_824_077)
    expect(byKind.get('crop')?.sizeBytes).toBe(44_100)
  })

  it('addresses every row on the plane, so the modal renders from the URL', async () => {
    const { facade } = harness()
    const manifest = await facade.listEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
    })
    expect(manifest.length).toBe(2)
    for (const row of manifest) {
      // The URL is built from the row's OWN id (D482), never a composite key.
      expect(row.url).toBe(`${PREFIX}/m/${row.mediaId}`)
    }
  })

  it('never exposes a base64 field', async () => {
    const { facade } = harness()
    for (const row of await facade.listEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      deviceId: DEVICE_ID,
    })) {
      expect(row).not.toHaveProperty('base64')
    }
  })

  it('honours deviceId as the authorization subject', async () => {
    const { facade } = harness()
    const manifest = await facade.listEventMedia({
      ownerType: 'object',
      eventId: EVENT_ID,
      deviceId: 104,
    })
    expect(manifest).toEqual([])
  })
})
