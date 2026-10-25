/**
 * `listInfoByOwner` — a track's media manifest.
 *
 * The detail view needs the SHAPE of a track's media to build its strip, then
 * fetches each tile as an image over the data plane. Measured on the live hub:
 * the full `getTrackMedia` is 5.3-7.7 MB of base64 across 7-23 files and blocks
 * the whole view.
 *
 * **The assertion that matters is that no blob is read.** The obvious
 * implementation — `listByOwner` with `base64` stripped — shrinks the response
 * while doing exactly the same work: that path reads every blob off disk and
 * base64-encodes it first. A byte-count assertion would pass on it; a
 * read-count assertion does not.
 */

import { describe, it, expect } from 'vitest'
import { MediaStore } from '../store/media-store.js'

interface Row {
  /** A media row's own id is a rowid (D482) — the generic store's shape keeps
   *  it as a string (`SettingsRecord.id`), and `MediaStore` converts with
   *  `Number(row.id)`, so a seeded row needs a NUMERIC string here. */
  readonly id: string
  readonly data: Record<string, unknown>
}

/** The real per-track file set measured on camera 102. */
const ROWS: Row[] = [
  { id: '101', data: { kind: 'thumbnailSmall', sizeBytes: 111_570, timestamp: 10, path: 'a' } },
  { id: '102', data: { kind: 'thumbnail', sizeBytes: 237_393, timestamp: 11, path: 'b' } },
  { id: '103', data: { kind: 'keyFrameSmall', sizeBytes: 142_560, timestamp: 12, path: 'c' } },
  { id: '104', data: { kind: 'keyFrame', sizeBytes: 1_861_758, timestamp: 13, path: 'd' } },
  { id: '105', data: { kind: 'snapshot', sizeBytes: 3_039_261, timestamp: 14, path: 'e' } },
]

function makeStore(rows: Row[]): { store: MediaStore; blobReads: () => number } {
  let reads = 0
  const settings = {
    query: { query: async () => rows },
    declareCollection: { mutate: async () => undefined },
    set: { mutate: async () => undefined },
    delete: { mutate: async () => undefined },
  }
  const storage = {
    read: async () => {
      reads += 1
      return Buffer.alloc(1024)
    },
    write: async () => undefined,
    delete: async () => undefined,
  }
  const logger = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }
  const store = new MediaStore({
    store: settings,
    storage,
    logger,
  } as unknown as ConstructorParameters<typeof MediaStore>[0])
  return { store, blobReads: () => reads }
}

describe('listInfoByOwner', () => {
  it('reads NO blob at all', async () => {
    // The whole point. `listByOwner` on the same rows reads one blob per row.
    const { store, blobReads } = makeStore(ROWS)
    await store.listInfoByOwner('track', 't1')
    expect(blobReads()).toBe(0)
  })

  it('still answers for every row', async () => {
    const { store } = makeStore(ROWS)
    const info = await store.listInfoByOwner('track', 't1')
    expect(info).toHaveLength(ROWS.length)
  })

  it('carries the kind and the size — what a kinds filter would destroy', async () => {
    // Without these the client cannot tell that a full-resolution variant
    // exists, and the affordance that opens it disappears.
    const { store } = makeStore(ROWS)
    const byKind = new Map((await store.listInfoByOwner('track', 't1')).map((r) => [r.kind, r]))

    expect(byKind.get('keyFrame')?.sizeBytes).toBe(1_861_758)
    expect(byKind.get('keyFrameSmall')?.sizeBytes).toBe(142_560)
    expect(byKind.get('snapshot')?.sizeBytes).toBe(3_039_261)
  })

  it('carries the mediaId (its own rowid, D482), which is what the data-plane URL is built from', async () => {
    const { store } = makeStore(ROWS)
    const info = await store.listInfoByOwner('track', 't1')
    expect(info.map((r) => r.mediaId)).toEqual([101, 102, 103, 104, 105])
  })

  it('never exposes a base64 field', async () => {
    const { store } = makeStore(ROWS)
    for (const row of await store.listInfoByOwner('track', 't1')) {
      expect(row).not.toHaveProperty('base64')
    }
  })

  it('is empty for a track with no media', async () => {
    const { store } = makeStore([])
    await expect(store.listInfoByOwner('track', 't1')).resolves.toEqual([])
  })
})
