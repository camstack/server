/**
 * MediaStore unit tests — P9.
 *
 * Covers:
 *  - declare: registers the media collection
 *  - put: writes blob to storage + registers a row in the index, keyed by an
 *    auto rowid (D482) — the id is a surrogate; the deterministic thing is the
 *    write SLOT (`slotTsFor`) and the blob PATH for single-instance kinds
 *  - listByOwner: round-trips rows + blobs for a given owner kind/id
 *  - listByOwner skips rows whose blob went missing (debug-log only,
 *    no throw)
 *  - evictBefore: deletes blob + row for rows older than cutoff
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
  type FakeSettingsStore,
  type FakeStorageProvider,
} from './test-helpers.js'
import {
  MediaStore,
  MEDIA_COLLECTION,
  MEDIA_INDEXES,
  mediaProvenanceRank,
} from '../store/media-store.js'

describe('MediaStore', () => {
  let fake: FakeSettingsStore
  let storage: FakeStorageProvider
  let store: MediaStore

  beforeEach(() => {
    fake = makeFakeSettingsStore()
    storage = makeFakeStorageProvider()
    store = new MediaStore({ storage, store: fake.client, logger: makeSilentLogger() })
  })

  describe('declare', () => {
    it('registers the media collection', async () => {
      await MediaStore.declare(fake.client)
      expect(fake.declared.has(MEDIA_COLLECTION)).toBe(true)
    })

    /**
     * `locationId` is a QUERY PREDICATE, not just a stored field.
     *
     * The migration seal gate asks `WHERE locationId IS NULL` on 1.25 M rows
     * while the hub serves live traffic. Without an index that is a full table
     * scan, and the version of this gate that walked the rows instead timed out
     * at 60 s on every call it ever made. `declareCollection` is the migration
     * path — the schema fingerprint changes and the backend emits
     * `CREATE INDEX IF NOT EXISTS` on the next declare — so losing the
     * declaration is how the index quietly stops existing on a fresh install.
     */
    it('declares an index on locationId, which the seal gate reads', () => {
      expect(MEDIA_INDEXES.map((index) => [...index.columns])).toContainEqual(['locationId'])
    })

    /**
     * The two COVERING indexes the events-management footprint reads.
     *
     * Same reasoning as `locationId` above, and the column ORDER is the whole
     * point rather than incidental: `sizeBytes` must be IN the index, last, or
     * the sum reads the table row behind every index entry it visits — a
     * scattered read of the entire 1.25 M-row table. Measured at production
     * scale on a warm local disk: 216 ms with these, 1 196 ms with only
     * `idx_media_device_ts`, and `SUM … WHERE kind = ?` degrades from
     * `SEARCH … USING COVERING INDEX` to a full `SCAN` per kind without
     * `idx_media_kind_device_size`.
     *
     * `toContainEqual` on the exact column tuple, not a name lookup: a
     * declaration that kept the name and dropped or reordered a column would
     * still pass a name check while serving nothing.
     */
    it('declares the covering indexes the footprint aggregates read', () => {
      const columns = MEDIA_INDEXES.map((index) => [...index.columns])
      expect(columns).toContainEqual(['deviceId', 'sizeBytes'])
      expect(columns).toContainEqual(['kind', 'deviceId', 'sizeBytes'])
    })

    /**
     * A new index must arrive under a NEW NAME.
     *
     * `declareCollection` emits `CREATE INDEX IF NOT EXISTS`, keyed on the
     * name. Widening an existing index in place — adding `sizeBytes` to
     * `idx_media_device_ts` — is therefore a silent no-op on every hub that
     * already has it: the declaration reads as done, and the query keeps
     * hitting the table. Index REMOVAL is not handled either, so a rename
     * leaves the old b-tree on disk forever.
     */
    it('gives every declared index a distinct name', () => {
      const names = MEDIA_INDEXES.map((index) => index.name)
      expect(new Set(names).size).toBe(names.length)
    })
  })

  describe('put', () => {
    beforeEach(async () => {
      await MediaStore.declare(fake.client)
    })

    it('writes the blob and registers an index row', async () => {
      const buf = Buffer.from('hello')
      const key = await store.put({
        deviceId: 4,
        ownerKind: 'object',
        ownerId: 'evt-1',
        kind: 'crop',
        timestamp: 1000,
        data: buf,
      })
      // The id is a surrogate rowid (D482) — an integer that names no owner
      // and no kind, never a re-derivable composite key.
      expect(Number.isInteger(key)).toBe(true)
      expect(key).toBeGreaterThan(0)

      // Blob landed on the storage provider.
      expect(storage.files.size).toBe(1)
      expect(Array.from(storage.files.keys())[0]).toBe(
        'eventMedia:4/events/object/evt-1/crop-1000.jpg',
      )
      expect(Array.from(storage.files.values())[0]!.toString()).toBe('hello')

      // Index row registered.
      expect(fake.size(MEDIA_COLLECTION)).toBe(1)
    })

    it('accumulating kinds get distinct keys per (kind, ts); single-instance kinds collapse', async () => {
      // Two SNAPSHOTS at different ts accumulate (filmstrip) → 2 distinct rows.
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'snapshot',
        timestamp: 1000,
        data: Buffer.from('a'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'snapshot',
        timestamp: 2000,
        data: Buffer.from('b'),
      })
      // Two THUMBNAILS (single-instance) at different ts collapse onto ONE row —
      // the deterministic `track:t1:thumbnail` id has no timestamp (RC-1).
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'thumbnail',
        timestamp: 1000,
        data: Buffer.from('c'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'thumbnail',
        timestamp: 2000,
        data: Buffer.from('d'),
      })
      expect(fake.size(MEDIA_COLLECTION)).toBe(3) // 2 snapshots + 1 thumbnail
      expect(storage.files.size).toBe(3)
    })

    it('single-instance kinds write to a deterministic BLOB PATH (no timestamp) — the id itself is a surrogate rowid', async () => {
      const key = await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'keyFrame',
        timestamp: 987654,
        data: Buffer.from('kf'),
      })
      // The id no longer encodes the timestamp (or anything else, D482) — the
      // PATH is what stays deterministic across recaptures, so an overwrite
      // reuses the same file.
      expect(Number.isInteger(key)).toBe(true)
      expect(storage.files.has('eventMedia:4/events/track/t1/keyFrame.jpg')).toBe(true)
    })

    it('re-put of a single-instance kind overwrites the row + blob (idempotent)', async () => {
      const k1 = await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'keyFrame',
        timestamp: 1000,
        data: Buffer.from('first'),
      })
      const k2 = await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'keyFrame',
        timestamp: 2000,
        data: Buffer.from('second'),
      })
      expect(k1).toBe(k2) // same deterministic id
      const files = await store.listByOwner('track', 't1')
      expect(files).toHaveLength(1)
      expect(Buffer.from(files[0]!.base64, 'base64').toString()).toBe('second')
      expect(storage.files.size).toBe(1)
      expect(fake.size(MEDIA_COLLECTION)).toBe(1)
    })
  })

  describe('putReplacing', () => {
    beforeEach(async () => {
      await MediaStore.declare(fake.client)
    })

    it('keeps exactly one entry per (owner, kind) — overwriting blob + row', async () => {
      await store.putReplacing({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'lastFrame',
        timestamp: 1000,
        data: Buffer.from('old'),
      })
      const key = await store.putReplacing({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'lastFrame',
        timestamp: 2000,
        data: Buffer.from('new'),
      })
      const files = await store.listByOwner('track', 't1')
      expect(files).toHaveLength(1)
      expect(files[0]!.mediaId).toBe(key)
      expect(files[0]!.timestamp).toBe(2000)
      expect(Buffer.from(files[0]!.base64, 'base64').toString()).toBe('new')
      // Old blob was deleted (only the fresh one remains on disk).
      expect(storage.files.size).toBe(1)
      expect(fake.size(MEDIA_COLLECTION)).toBe(1)
    })

    it('RC-1: N CONCURRENT putReplacing for the same (owner, kind) leave exactly ONE row', async () => {
      // The old non-atomic query→insert→delete left up to N survivors under a
      // race (13 keyFrame rows). The deterministic id + upsert collapses them.
      const N = 13
      await Promise.all(
        Array.from({ length: N }, (_, i) =>
          store.putReplacing({
            deviceId: 4,
            ownerKind: 'track',
            ownerId: 't1',
            kind: 'keyFrame',
            timestamp: 45_000 + i * 20, // distinct ts, as the retry burst had
            data: Buffer.from(`kf-${i}`),
          }),
        ),
      )
      const files = await store.listByOwner('track', 't1')
      expect(files).toHaveLength(1)
      expect(files[0]!.kind).toBe('keyFrame')
      expect(storage.files.size).toBe(1)
      expect(fake.size(MEDIA_COLLECTION)).toBe(1)
    })

    it('RC-1: concurrent thumbnail captures also collapse to one row', async () => {
      await Promise.all(
        Array.from({ length: 4 }, (_, i) =>
          store.putReplacing({
            deviceId: 4,
            ownerKind: 'track',
            ownerId: 't2',
            kind: 'thumbnail',
            timestamp: 100 + i,
            data: Buffer.from(`th-${i}`),
          }),
        ),
      )
      const files = await store.listByOwner('track', 't2')
      expect(files.filter((f) => f.kind === 'thumbnail')).toHaveLength(1)
    })

    it('RC-1: putReplacing reaps a STRAY row for the same (owner, kind) on the first slotted write', async () => {
      // Simulate a stray/orphan row for this (owner, kind) that predates the
      // slot column (D482) entirely — its `slotTs` is unset, so it does NOT
      // land in the same UPSERT conflict bucket as a fresh keyFrame write
      // (whose slot is always `SINGLE_SLOT_TS`, D482). That is deliberate: a
      // row whose slot cannot be known must never be assumed to collide with
      // one that can, so this exercises putReplacing's OWN reap pass —
      // querying by (ownerKind, ownerId, kind) and deleting everything that
      // isn't the row the upsert just landed on — rather than the upsert's
      // slot match doing the collapsing for it.
      const legacyKey = 'track:t3:keyFrame:41000'
      const legacyPath = 'pipeline-analytics/4/track/t3/keyFrame-41000.jpg'
      await storage.write({
        location: 'eventMedia',
        relativePath: legacyPath,
        data: Buffer.from('legacy'),
      })
      fake.seed(MEDIA_COLLECTION, [
        {
          id: legacyKey,
          data: {
            deviceId: 4,
            ownerKind: 'track',
            ownerId: 't3',
            kind: 'keyFrame',
            timestamp: 41000,
            // Deliberately no `slotTs` — see the comment above.
            path: legacyPath,
            sizeBytes: 6,
          },
        },
      ])
      const freshId = await store.putReplacing({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't3',
        kind: 'keyFrame',
        timestamp: 46000,
        data: Buffer.from('fresh'),
      })
      const files = await store.listByOwner('track', 't3')
      expect(files).toHaveLength(1)
      expect(files[0]!.mediaId).toBe(freshId)
      expect(Buffer.from(files[0]!.base64, 'base64').toString()).toBe('fresh')
      // Legacy blob is gone.
      expect(storage.files.has(`eventMedia:${legacyPath}`)).toBe(false)
    })

    it('does not disturb a different kind for the same owner', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'snapshot',
        timestamp: 500,
        data: Buffer.from('snap'),
      })
      await store.putReplacing({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'lastFrame',
        timestamp: 600,
        data: Buffer.from('last'),
      })
      await store.putReplacing({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'lastFrame',
        timestamp: 700,
        data: Buffer.from('last2'),
      })
      const files = await store.listByOwner('track', 't1')
      expect(files.map((f) => f.kind).toSorted()).toEqual(['lastFrame', 'snapshot'])
    })
  })

  describe('promoteToLastFrame', () => {
    beforeEach(async () => {
      await MediaStore.declare(fake.client)
    })

    it('rewrites the newest snapshot into the single lastFrame slot and drops the snapshot row', async () => {
      // A track with two snapshots + an OLDER lastFrame.
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'snapshot',
        timestamp: 1000,
        data: Buffer.from('snap-old'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'snapshot',
        timestamp: 3000,
        data: Buffer.from('snap-new'),
      })
      await store.putReplacing({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'lastFrame',
        timestamp: 2000,
        data: Buffer.from('stale-last'),
      })

      const before = await store.listByOwner('track', 't1')
      const newest = before.find((m) => m.kind === 'snapshot' && m.timestamp === 3000)!
      const newKey = await store.promoteToLastFrame({
        deviceId: 4,
        trackId: 't1',
        snapshot: newest,
      })

      const after = await store.listByOwner('track', 't1')
      const lastFrames = after.filter((m) => m.kind === 'lastFrame')
      const snapshots = after.filter((m) => m.kind === 'snapshot')
      // Exactly one lastFrame, carrying the promoted snapshot's bytes + ts.
      expect(lastFrames).toHaveLength(1)
      expect(lastFrames[0]!.mediaId).toBe(newKey)
      expect(lastFrames[0]!.timestamp).toBe(3000)
      expect(Buffer.from(lastFrames[0]!.base64, 'base64').toString()).toBe('snap-new')
      // The promoted (newest) snapshot row is gone — no duplicate pair — but the
      // OLDER snapshot filmstrip row is untouched.
      expect(snapshots.map((m) => m.timestamp)).toEqual([1000])
    })

    it('promotes a snapshot even when the track has NO lastFrame yet', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't2',
        kind: 'snapshot',
        timestamp: 5000,
        data: Buffer.from('only-snap'),
      })
      const before = await store.listByOwner('track', 't2')
      const snap = before.find((m) => m.kind === 'snapshot')!
      await store.promoteToLastFrame({ deviceId: 4, trackId: 't2', snapshot: snap })

      const after = await store.listByOwner('track', 't2')
      expect(after.map((m) => m.kind).toSorted()).toEqual(['lastFrame'])
      expect(after[0]!.timestamp).toBe(5000)
      expect(Buffer.from(after[0]!.base64, 'base64').toString()).toBe('only-snap')
    })
  })

  describe('listByOwner', () => {
    beforeEach(async () => {
      await MediaStore.declare(fake.client)
    })

    it('returns every file owned by (ownerKind, ownerId) ordered by ts asc', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'thumbnail',
        timestamp: 2000,
        data: Buffer.from('second'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't1',
        kind: 'snapshot',
        timestamp: 1000,
        data: Buffer.from('first'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 'other',
        kind: 'thumbnail',
        timestamp: 500,
        data: Buffer.from('unrelated'),
      })

      const files = await store.listByOwner('track', 't1')
      expect(files).toHaveLength(2)
      expect(files[0]!.timestamp).toBe(1000)
      expect(files[1]!.timestamp).toBe(2000)
      // Base64 content is decoded from the storage buffer.
      expect(Buffer.from(files[0]!.base64, 'base64').toString()).toBe('first')
      expect(Buffer.from(files[1]!.base64, 'base64').toString()).toBe('second')
    })

    it('skips rows whose blob is missing (tolerates orphan rows)', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'object',
        ownerId: 'e1',
        kind: 'crop',
        timestamp: 1000,
        data: Buffer.from('x'),
      })
      // Simulate blob deleted out-of-band.
      storage.files.clear()
      const files = await store.listByOwner('object', 'e1')
      expect(files).toHaveLength(0)
    })
  })

  describe('pageForAudit — and the DELETED evictBefore', () => {
    beforeEach(async () => {
      await MediaStore.declare(fake.client)
    })

    it('does NOT page across owner kinds — a shard sees only its own rows', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'object',
        ownerId: 'e-1',
        kind: 'crop',
        timestamp: 1,
        data: Buffer.from('a'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't-1',
        kind: 'keyFrame',
        timestamp: 2,
        data: Buffer.from('b'),
      })
      const objectRows = await store.pageForAudit('object', 0, 50)
      expect(objectRows.map((r) => r.data['ownerKind'])).toEqual(['object'])
      // And the count is the shard's own — the audit's coverage denominator.
      expect(await store.countForAudit('track')).toBe(1)
      expect(await store.countForAudit('mosaic')).toBe(0)
    })

    it('has no age-keyed eviction at all any more (D61)', () => {
      // `evictBefore(cutoffMs)` deleted media rows BY AGE and was blind to
      // `ownerKind`: it removed enrolled `identity` crops the cascade was
      // careful to exempt, and it needed a fleet-minimum fudge factor to avoid
      // deleting live media belonging to a longer-retention camera. Media has
      // no clock of its own; it lives exactly as long as its owner.
      expect('evictBefore' in store).toBe(false)
    })

    it('pages ONE owner kind stably, so an audit cursor means something', async () => {
      for (let i = 0; i < 5; i++) {
        await store.put({
          deviceId: 4,
          ownerKind: 'object',
          ownerId: `e-${i}`,
          kind: 'crop',
          timestamp: 1000 + i,
          data: Buffer.from(`b-${i}`),
        })
      }
      // Sharded by owner kind (D480): each kind has its own offset space.
      const first = await store.pageForAudit('object', 0, 2)
      const second = await store.pageForAudit('object', 2, 2)
      expect(first).toHaveLength(2)
      expect(second).toHaveLength(2)
      // Disjoint pages, ordered — a cursor of 2 resumes exactly after page one.
      expect(first.map((r) => r.mediaId)).not.toEqual(second.map((r) => r.mediaId))
      expect([...first, ...second].map((r) => r.mediaId)).toEqual(
        [...first, ...second].map((r) => r.mediaId).toSorted((a, b) => a - b),
      )
    })

    it('returns the index row WITHOUT reading a blob', async () => {
      await store.put({
        deviceId: 101,
        ownerKind: 'track',
        ownerId: 't-1',
        kind: 'keyFrame',
        timestamp: 4242,
        data: Buffer.from('pixels'),
      })
      const [row] = await store.pageForAudit('track', 0, 10)
      expect(row?.data['ownerKind']).toBe('track')
      expect(row?.data['ownerId']).toBe('t-1')
      expect(row?.data['timestamp']).toBe(4242)
      expect(row?.data['base64']).toBeUndefined()
    })
  })

  describe('deleteForEvents', () => {
    beforeEach(async () => {
      await MediaStore.declare(fake.client)
    })

    it('removes blob + row for the named events, leaving others', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'object',
        ownerId: 'e1',
        kind: 'thumbnail',
        timestamp: 1,
        data: Buffer.from('a'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'object',
        ownerId: 'e2',
        kind: 'thumbnail',
        timestamp: 2,
        data: Buffer.from('b'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'object',
        ownerId: 'keep',
        kind: 'thumbnail',
        timestamp: 3,
        data: Buffer.from('c'),
      })

      const removed = await store.deleteForEvents({ object: ['e1', 'e2'] })
      expect(removed).toBe(2)
      expect(fake.size(MEDIA_COLLECTION)).toBe(1)
      expect(storage.files.size).toBe(1)
      expect(await store.listByOwner('object', 'e1')).toHaveLength(0)
      expect(await store.listByOwner('object', 'keep')).toHaveLength(1)
    })

    // D476: a motion id and an object id can be the SAME number post-D474 —
    // the whole point of grouping ids by table is that deleting `motion: ['5']`
    // must never touch an unrelated `object: ['5']` row.
    it('deletes only the named kind, never a same-numbered row in another table', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'motion',
        ownerId: '5',
        kind: 'snapshot',
        timestamp: 1,
        data: Buffer.from('motion-still'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'object',
        ownerId: '5',
        kind: 'crop',
        timestamp: 2,
        data: Buffer.from('object-crop'),
      })

      const removed = await store.deleteForEvents({ motion: ['5'] })
      expect(removed).toBe(1)
      expect(await store.listByOwner('motion', '5')).toHaveLength(0)
      expect(await store.listByOwner('object', '5')).toHaveLength(1)
    })

    it('deletes across multiple kinds in one call', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'motion',
        ownerId: 'm1',
        kind: 'snapshot',
        timestamp: 1,
        data: Buffer.from('a'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'audio',
        ownerId: 'a1',
        kind: 'snapshot',
        timestamp: 2,
        data: Buffer.from('b'),
      })

      const removed = await store.deleteForEvents({ motion: ['m1'], audio: ['a1'] })
      expect(removed).toBe(2)
      expect(await store.listByOwner('motion', 'm1')).toHaveLength(0)
      expect(await store.listByOwner('audio', 'a1')).toHaveLength(0)
    })

    it('is a no-op for an empty ids record', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'object',
        ownerId: 'e1',
        kind: 'thumbnail',
        timestamp: 1,
        data: Buffer.from('a'),
      })
      expect(await store.deleteForEvents({})).toBe(0)
      expect(fake.size(MEDIA_COLLECTION)).toBe(1)
    })
  })

  describe('deleteForTracks', () => {
    beforeEach(async () => {
      await MediaStore.declare(fake.client)
    })

    it('removes blob + row for the named tracks, leaving others', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't-1',
        kind: 'keyFrame',
        timestamp: 1,
        data: Buffer.from('a'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't-1',
        kind: 'thumbnail',
        timestamp: 2,
        data: Buffer.from('b'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't-2',
        kind: 'thumbnail',
        timestamp: 3,
        data: Buffer.from('c'),
      })

      const removed = await store.deleteForTracks(['t-1'])
      expect(removed).toBe(2)
      expect(await store.listByOwner('track', 't-1')).toHaveLength(0)
      expect(await store.listByOwner('track', 't-2')).toHaveLength(1) // survives
      // The two deleted blobs are gone; only t-2's remains on disk.
      expect(storage.files.size).toBe(1)
      expect(fake.size(MEDIA_COLLECTION)).toBe(1)
    })

    it('is a no-op for an empty id list', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'track',
        ownerId: 't-1',
        kind: 'keyFrame',
        timestamp: 1,
        data: Buffer.from('a'),
      })
      expect(await store.deleteForTracks([])).toBe(0)
      expect(fake.size(MEDIA_COLLECTION)).toBe(1)
    })
  })
})

describe('MediaStore — face owner kind', () => {
  let fake: FakeSettingsStore
  let storage: FakeStorageProvider
  let store: MediaStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    storage = makeFakeStorageProvider()
    store = new MediaStore({ storage, store: fake.client, logger: makeSilentLogger() })
    await MediaStore.declare(fake.client)
  })

  it('writes a face crop under the face path and lists it by owner', async () => {
    const key = await store.put({
      deviceId: 7,
      ownerKind: 'face',
      ownerId: 'face-1',
      kind: 'crop',
      timestamp: 2000,
      data: Buffer.from('jpg'),
    })
    expect(Number.isInteger(key)).toBe(true)
    expect(storage.files.has('eventMedia:7/events/face/face-1/crop-2000.jpg')).toBe(true)

    const files = await store.listByOwner('face', 'face-1')
    expect(files.map((f) => f.kind)).toEqual(['crop'])
  })

  it('deleteForOwner removes blobs + index rows for a face owner', async () => {
    await store.put({
      deviceId: 7,
      ownerKind: 'face',
      ownerId: 'face-1',
      kind: 'crop',
      timestamp: 1,
      data: Buffer.from('a'),
    })
    await store.put({
      deviceId: 7,
      ownerKind: 'face',
      ownerId: 'face-2',
      kind: 'crop',
      timestamp: 1,
      data: Buffer.from('b'),
    })

    const removed = await store.deleteForOwner('face', ['face-1'])
    expect(removed).toBe(1)
    expect(await store.listByOwner('face', 'face-1')).toHaveLength(0)
    expect(await store.listByOwner('face', 'face-2')).toHaveLength(1) // untouched
  })

  it('deleteForEvents still works (delegates to deleteForOwner)', async () => {
    await store.put({
      deviceId: 7,
      ownerKind: 'object',
      ownerId: 'evt-1',
      kind: 'crop',
      timestamp: 1,
      data: Buffer.from('a'),
    })
    const removed = await store.deleteForEvents({ object: ['evt-1'] })
    expect(removed).toBe(1)
    expect(await store.listByOwner('object', 'evt-1')).toHaveLength(0)
  })
})

describe('MediaStore — identity ownerKind + reown', () => {
  let fake: FakeSettingsStore
  let storage: FakeStorageProvider
  let store: MediaStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    storage = makeFakeStorageProvider()
    store = new MediaStore({ storage, store: fake.client, logger: makeSilentLogger() })
    await MediaStore.declare(fake.client)
  })

  it('writes an identity crop under the identity path and lists it by owner', async () => {
    const key = await store.put({
      deviceId: 5,
      ownerKind: 'identity',
      ownerId: 'id-1',
      kind: 'crop',
      timestamp: 3000,
      data: Buffer.from('face'),
    })
    expect(Number.isInteger(key)).toBe(true)
    // On `galleryMedia` (the declared gallery location), NOT `eventMedia`:
    // the enrolled gallery is exempt from every retention sweep, so it must
    // not live on the footage volume a wipe or a quota eviction can clear
    // (D197) — and not in the addon data dir either, which carries no media
    // (D341). This assertion used to read `eventMedia:` and that is exactly
    // what it was pinning.
    expect(storage.files.has('galleryMedia:5/events/identity/id-1/crop-3000.jpg')).toBe(true)

    const files = await store.listByOwner('identity', 'id-1')
    expect(files.map((f) => f.kind)).toEqual(['crop'])
  })

  it('reowns a media file from face to identity', async () => {
    const key = await store.put({
      deviceId: 99,
      ownerKind: 'face',
      ownerId: 'face-T1',
      kind: 'crop',
      timestamp: 1,
      data: Buffer.from([0xff, 0xd8, 0xff]),
    })
    const newKey = await store.reown({
      fromOwnerKind: 'face',
      fromOwnerId: 'face-T1',
      toOwnerKind: 'identity',
      toOwnerId: 'id-1',
      mediaId: key,
    })
    const idMedia = await store.listByOwner('identity', 'id-1')
    const faceMedia = await store.listByOwner('face', 'face-T1')
    expect(idMedia).toHaveLength(1)
    expect(idMedia[0]!.mediaId).toBe(newKey)
    expect(faceMedia).toHaveLength(0)
  })

  it('reown returns a new id distinct from the original — and (D482) the id encodes nothing about the owner', async () => {
    const key = await store.put({
      deviceId: 10,
      ownerKind: 'face',
      ownerId: 'face-X',
      kind: 'crop',
      timestamp: 5000,
      data: Buffer.from('data'),
    })
    const newKey = await store.reown({
      fromOwnerKind: 'face',
      fromOwnerId: 'face-X',
      toOwnerKind: 'identity',
      toOwnerId: 'person-1',
      mediaId: key,
    })
    expect(newKey).not.toBe(key)
    expect(Number.isInteger(newKey)).toBe(true)
    // Nothing about the new owner survives in the address — the whole point
    // of a surrogate id (D482): unlike the old composite key, it cannot name
    // the WRONG owner because it never names an owner at all.
    expect(String(newKey)).not.toContain('identity')
    expect(String(newKey)).not.toContain('person-1')
  })

  it('reown preserves blob data under the new owner path', async () => {
    const originalData = Buffer.from([0x01, 0x02, 0x03])
    const key = await store.put({
      deviceId: 7,
      ownerKind: 'face',
      ownerId: 'face-Y',
      kind: 'crop',
      timestamp: 2000,
      data: originalData,
    })
    const newKey = await store.reown({
      fromOwnerKind: 'face',
      fromOwnerId: 'face-Y',
      toOwnerKind: 'identity',
      toOwnerId: 'id-2',
      mediaId: key,
    })
    const files = await store.listByOwner('identity', 'id-2')
    expect(files).toHaveLength(1)
    expect(Buffer.from(files[0]!.base64, 'base64')).toEqual(originalData)
    void newKey
  })

  it('reown throws when source and destination paths are identical (same owner)', async () => {
    const key = await store.put({
      deviceId: 3,
      ownerKind: 'face',
      ownerId: 'face-same',
      kind: 'crop',
      timestamp: 9000,
      data: Buffer.from('data'),
    })
    await expect(
      store.reown({
        fromOwnerKind: 'face',
        fromOwnerId: 'face-same',
        toOwnerKind: 'face',
        toOwnerId: 'face-same',
        mediaId: key,
      }),
    ).rejects.toThrow('MediaStore.reown: source and destination paths are identical')
  })

  describe('footprintByDevice', () => {
    beforeEach(async () => {
      await MediaStore.declare(fake.client)
    })

    it('sums sizeBytes + rows per device across the whole collection', async () => {
      await store.put({
        deviceId: 4,
        ownerKind: 'object',
        ownerId: 'e1',
        kind: 'crop',
        timestamp: 1,
        data: Buffer.from('12345'),
      })
      await store.put({
        deviceId: 4,
        ownerKind: 'object',
        ownerId: 'e2',
        kind: 'crop',
        timestamp: 2,
        data: Buffer.from('123'),
      })
      await store.put({
        deviceId: 9,
        ownerKind: 'object',
        ownerId: 'e3',
        kind: 'crop',
        timestamp: 3,
        data: Buffer.from('1234567890'),
      })

      const fp = await store.footprintByDevice()
      expect(fp.get(4)).toEqual({ bytes: 8, rows: 2 })
      expect(fp.get(9)).toEqual({ bytes: 10, rows: 1 })
      expect(fp.size).toBe(2)
    })

    it('returns an empty map for an empty collection', async () => {
      const fp = await store.footprintByDevice()
      expect(fp.size).toBe(0)
    })
  })
})

/**
 * D276 — thumbnail provenance: the column that separates a genuinely-ranked
 * native tile from a stand-in, and the rank order the upgrade ladder obeys.
 */
describe('MediaStore — thumbnail provenance (D276)', () => {
  let fake: FakeSettingsStore
  let storage: FakeStorageProvider
  let store: MediaStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    storage = makeFakeStorageProvider()
    store = new MediaStore({ storage, store: fake.client, logger: makeSilentLogger() })
    await MediaStore.declare(fake.client)
  })

  it('a put with provenance stores it and listByOwner reads it back', async () => {
    await store.put({
      deviceId: 108,
      ownerKind: 'track',
      ownerId: 't-1',
      kind: 'thumbnail',
      timestamp: 1_000,
      data: Buffer.from('standin-bytes'),
      provenance: 'standin',
    })
    const rows = await store.listByOwner('track', 't-1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.provenance).toBe('standin')
  })

  it('a put WITHOUT provenance reads back with the field absent (legacy shape)', async () => {
    await store.put({
      deviceId: 108,
      ownerKind: 'track',
      ownerId: 't-legacy',
      kind: 'thumbnail',
      timestamp: 1_000,
      data: Buffer.from('legacy-bytes'),
    })
    const rows = await store.listByOwner('track', 't-legacy')
    expect(rows[0]?.provenance).toBeUndefined()
  })

  it('a re-put of the single-instance thumbnail REPLACES the provenance with it', async () => {
    // The standin lands first; a native capture overwrites the SAME row
    // (deterministic id) — the row must now read native, not keep standin.
    await store.put({
      deviceId: 108,
      ownerKind: 'track',
      ownerId: 't-up',
      kind: 'thumbnail',
      timestamp: 1_000,
      data: Buffer.from('standin'),
      provenance: 'standin',
    })
    await store.put({
      deviceId: 108,
      ownerKind: 'track',
      ownerId: 't-up',
      kind: 'thumbnail',
      timestamp: 2_000,
      data: Buffer.from('native'),
      provenance: 'native',
    })
    const rows = await store.listByOwner('track', 't-up')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.provenance).toBe('native')
  })

  describe('trackThumbnailProvenance', () => {
    it('answers null when the track has no thumbnail row', async () => {
      expect(await store.trackThumbnailProvenance('t-none')).toBeNull()
    })

    it('answers the stored provenance', async () => {
      await store.put({
        deviceId: 108,
        ownerKind: 'track',
        ownerId: 't-s',
        kind: 'thumbnail',
        timestamp: 1_000,
        data: Buffer.from('x'),
        provenance: 'standin',
      })
      expect(await store.trackThumbnailProvenance('t-s')).toBe('standin')
    })

    it('answers native for a legacy row with no provenance — never auto-replaced', async () => {
      await store.put({
        deviceId: 108,
        ownerKind: 'track',
        ownerId: 't-l',
        kind: 'thumbnail',
        timestamp: 1_000,
        data: Buffer.from('x'),
      })
      expect(await store.trackThumbnailProvenance('t-l')).toBe('native')
    })
  })

  it('the rank order is standin < raster < native, and absent ranks native', () => {
    expect(mediaProvenanceRank('standin')).toBeLessThan(mediaProvenanceRank('raster'))
    expect(mediaProvenanceRank('raster')).toBeLessThan(mediaProvenanceRank('native'))
    expect(mediaProvenanceRank(undefined)).toBe(mediaProvenanceRank('native'))
  })
})
