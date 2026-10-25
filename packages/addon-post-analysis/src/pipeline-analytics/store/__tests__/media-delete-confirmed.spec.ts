/**
 * `MediaStore.deleteConfirmed` — the only delete path the bulk reclaim uses,
 * and the reason it exists.
 *
 * Every other delete on the store is best-effort: `deleteByIdUnchecked`
 * swallows the unlink error and drops the row anyway. For a cascade whose
 * whole subtree is going that is fine. For a 1.14 M-row reclaim it is the
 * orphan factory — a forgotten row whose 95 KiB blob nothing will ever name
 * again.
 *
 * The fixtures below are built so the guard's presence and its absence produce
 * DIFFERENT observable states, not a difference between 0 and 1: each asserts
 * both the row and the blob, and the "survivor" case leaves a file behind that
 * a passing swallow-the-error implementation would orphan.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeSettingsStore,
  type FakeStorageProvider,
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeSilentLogger,
} from '../../__tests__/test-helpers.js'
import { MEDIA_COLLECTION, MediaStore } from '../media-store.js'

describe('MediaStore.deleteConfirmed', () => {
  let fake: FakeSettingsStore
  let storage: FakeStorageProvider
  let media: MediaStore

  beforeEach(async () => {
    fake = makeFakeSettingsStore()
    storage = makeFakeStorageProvider()
    media = new MediaStore({ storage, store: fake.client, logger: makeSilentLogger() })
    // Declares `id` as an INTEGER PRIMARY KEY (D482) — without this the fake
    // treats the collection as TEXT-keyed and `put` refuses (it cannot address
    // a row with a UUID under the new contract).
    await MediaStore.declare(fake.client)
    await media.put({
      deviceId: 103,
      ownerKind: 'object',
      ownerId: 'ev-1',
      kind: 'snapshot',
      timestamp: 1_788_000_000_000,
      data: Buffer.alloc(95_000, 7),
    })
  })

  const rows = async (): Promise<readonly { id: string }[]> =>
    fake.client.query.query({ collection: MEDIA_COLLECTION })

  it('removes the blob AND the row, and reports the bytes', async () => {
    const [row] = await rows()
    expect(row).toBeDefined()
    expect(storage.files.size).toBe(1)

    const gone = await media.deleteConfirmed(Number(row!.id))

    expect(gone.rows).toBe(1)
    expect(gone.bytes).toBe(95_000)
    expect(storage.files.size).toBe(0)
    expect(await rows()).toHaveLength(0)
  })

  /**
   * DISARM TARGET: the post-unlink `exists` re-probe.
   *
   * A storage whose `delete` silently does nothing — a read-only volume, a
   * permission fault, `fs.rm(force:true)` on a path the row got wrong — must
   * NOT cost the row. Without the re-probe this test's row vanishes and the
   * 95 KiB file stays on disk forever, which is precisely the state that
   * cannot be found again.
   */
  it('refuses when the blob survives its delete — the row is KEPT', async () => {
    const [row] = await rows()
    storage.delete = async () => {
      /* the volume accepted the call and did nothing */
    }

    await expect(media.deleteConfirmed(Number(row!.id))).rejects.toThrow(/survived its delete/)

    expect(storage.files.size).toBe(1)
    expect(await rows()).toHaveLength(1)
  })

  /**
   * DISARM TARGET: the absence of a `catch` around `storage.delete`.
   *
   * An unreachable volume is not an absent blob. The throw must reach the
   * caller so the pass counts a refusal and stops; swallowing it would delete
   * the row on the strength of an I/O error.
   */
  it('refuses when the volume cannot answer — the row is KEPT', async () => {
    const [row] = await rows()
    storage.delete = async () => {
      throw new Error('EIO: input/output error')
    }

    await expect(media.deleteConfirmed(Number(row!.id))).rejects.toThrow(/EIO/)

    expect(storage.files.size).toBe(1)
    expect(await rows()).toHaveLength(1)
  })

  it('a row that never had a blob is removable — there is nothing to confirm', async () => {
    await fake.client.insert.mutate({
      collection: MEDIA_COLLECTION,
      record: {
        // A numeric string — a media row's own id is a rowid (D482).
        id: '9001',
        data: {
          deviceId: 103,
          ownerKind: 'object',
          ownerId: 'ev-2',
          kind: 'snapshot',
          timestamp: 1,
          slotTs: 1,
          path: '',
          sizeBytes: 0,
        },
      },
    })
    const gone = await media.deleteConfirmed(9_001)
    expect(gone.rows).toBe(1)
    const remaining = await rows()
    expect(remaining.map((r) => r.id)).not.toContain('9001')
  })

  it('an unknown id is a no-op, not an error', async () => {
    expect(await media.deleteConfirmed(999_999)).toEqual({ rows: 0, bytes: 0 })
  })
})
