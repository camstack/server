/**
 * Media on a fusion (spec §6.3): accumulating kinds move in place (same id,
 * same blob — `/event-media/m/<id>` links survive); single-instance kinds
 * keep firstFrame from the survivor, lastFrame from the absorbed piece, and
 * the best shot from whichever piece the merged ranking chose.
 *
 * Disarms (each alone, restored):
 *  - move every row regardless of kind: "a single-instance kind keeps one row" fails;
 *  - ignore `bestShotFrom`: "the best shot follows the merged ranking" fails;
 *  - in `moveOwner`, filter on `ownerKind: 'track'`: "face-owned media follows its row" fails;
 *  - ignore `keepMediaIds`: "at close, the survivor's current best shot beats a stale ranking" fails;
 *  - skip the blob relocation in `relocateAndReassign` (leave `newPath = oldPath`
 *    unconditionally): "a late write under the absorbed id never destroys the
 *    survivor's moved blob" fails (review H1);
 *  - drop the survivor's row BEFORE reading the winning blob (read the
 *    survivor's row into `dropLosingSingleInstanceRow` unconditionally,
 *    ahead of the `storage.read` attempt): both N1/P1 specs fail.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_MEDIA_LOCATION } from '../store/media-store.js'
import { buildMediaStoreForTest, putOwnedMedia } from './media-store-test-helpers.js'

const fuse = (survivorId: string, absorbedId: string, bestShotFrom: 'survivor' | 'absorbed') =>
  ({ deviceId: 1, survivorId, absorbedId, bestShotFrom }) as const

describe('MediaStore.reassignTrack', () => {
  it('moves accumulating kinds in place, keeping their ids', async () => {
    const { store } = await buildMediaStoreForTest()
    const id = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'B',
      kind: 'crop',
      timestamp: 1000,
    })
    await store.reassignTrack({ ...fuse('A', 'B', 'survivor'), media: store })
    expect(await store.ownerOf(id)).toMatchObject({ ownerKind: 'track', ownerId: 'A' })
  })

  it('a single-instance kind keeps one row, by the rule of its kind', async () => {
    const { store } = await buildMediaStoreForTest()
    const aFirst = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'A',
      kind: 'firstFrame',
      timestamp: 100,
    })
    const bFirst = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'B',
      kind: 'firstFrame',
      timestamp: 6000,
    })
    const aLast = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'A',
      kind: 'lastFrame',
      timestamp: 500,
    })
    const bLast = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'B',
      kind: 'lastFrame',
      timestamp: 9000,
    })
    await store.reassignTrack({ ...fuse('A', 'B', 'survivor'), media: store })
    expect(await store.ownerOf(aFirst)).toMatchObject({ ownerId: 'A' })
    expect(await store.ownerOf(bFirst)).toBeNull()
    expect(await store.ownerOf(aLast)).toBeNull()
    expect(await store.ownerOf(bLast)).toMatchObject({ ownerId: 'A' })
  })

  it('the best shot follows the merged ranking', async () => {
    const { store } = await buildMediaStoreForTest()
    const aKey = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'A',
      kind: 'keyFrame',
      timestamp: 100,
    })
    const bKey = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'B',
      kind: 'keyFrame',
      timestamp: 7000,
    })
    await store.reassignTrack({ ...fuse('A', 'B', 'absorbed'), media: store })
    expect(await store.ownerOf(aKey)).toBeNull()
    expect(await store.ownerOf(bKey)).toMatchObject({ ownerId: 'A' })
  })

  it("at close, the survivor's current best shot beats a stale ranking (review 2 M2)", async () => {
    // Fused with bestShotFrom 'absorbed'; afterwards A (now carrying the
    // subject) produced a better keyFrame, and B's queued capture landed late.
    const { store } = await buildMediaStoreForTest()
    const aNewer = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'A',
      kind: 'keyFrame',
      timestamp: 9000,
    })
    const bLate = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'B',
      kind: 'keyFrame',
      timestamp: 7000,
    })
    await store.reassignTrack({
      ...fuse('A', 'B', 'absorbed'),
      keepMediaIds: new Set([aNewer]),
      media: store,
    })
    expect(await store.ownerOf(aNewer)).toMatchObject({ ownerId: 'A' })
    expect(await store.ownerOf(bLate)).toBeNull()
  })

  it('face-owned media follows its row: crops and D644 source frames alike', async () => {
    const { store } = await buildMediaStoreForTest()
    const crop = await putOwnedMedia(store, {
      ownerKind: 'face',
      ownerId: 'face-B',
      kind: 'faceCrop',
      timestamp: 100,
    })
    const source = await putOwnedMedia(store, {
      ownerKind: 'face',
      ownerId: 'face-B',
      kind: 'fullFrame',
      timestamp: 100,
    })
    expect(await store.moveOwner('face', 'face-B', 'face-A')).toBe(2)
    expect(await store.ownerOf(crop)).toMatchObject({ ownerKind: 'face', ownerId: 'face-A' })
    expect(await store.ownerOf(source)).toMatchObject({ ownerKind: 'face', ownerId: 'face-A' })
  })

  it("a late write under the absorbed id never destroys the survivor's moved blob (review H1)", async () => {
    const { store } = await buildMediaStoreForTest()
    const aKey = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'A',
      kind: 'keyFrame',
      timestamp: 100,
      data: Buffer.from('a-original'),
    })
    const bKey = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'B',
      kind: 'keyFrame',
      timestamp: 7000,
      data: Buffer.from('b-original'),
    })
    // B's keyFrame wins and moves to A, replacing A's row.
    await store.reassignTrack({ ...fuse('A', 'B', 'absorbed'), media: store })
    expect(await store.ownerOf(aKey)).toBeNull()
    expect(await store.ownerOf(bKey)).toMatchObject({ ownerId: 'A' })
    const movedBefore = await store.getById(bKey)
    expect(movedBefore?.base64).toBe(Buffer.from('b-original').toString('base64'))

    // A queued capture for B's keyFrame, in flight before the fusion, lands
    // LATE — under the ABSORBED id, at what used to be the moved row's
    // deterministic path (pre-fix: the same path the moved row still named).
    const lateId = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'B',
      kind: 'keyFrame',
      timestamp: 9000,
      data: Buffer.from('late'),
    })
    expect(lateId).not.toBe(bKey)

    // The moved row's bytes must be untouched by the late write (pre-fix:
    // they silently became "late" — same physical file, two logical rows).
    const movedAfterLateWrite = await store.getById(bKey)
    expect(movedAfterLateWrite?.base64).toBe(Buffer.from('b-original').toString('base64'))

    // The sweep-up re-runs fusion for the same pair, pinning the already-moved
    // row as the keeper (exactly as Task 17/18's sweep-up would).
    await store.reassignTrack({
      ...fuse('A', 'B', 'survivor'),
      keepMediaIds: new Set([bKey]),
      media: store,
    })
    // The kept row survives, still readable with its ORIGINAL bytes — the
    // late row is gone. Pre-fix: `getById(bKey)` returned `null` here, because
    // dropping the late row unlinked the blob the kept row still pointed at.
    const keptAfterSweepUp = await store.getById(bKey)
    expect(keptAfterSweepUp).not.toBeNull()
    expect(keptAfterSweepUp?.base64).toBe(Buffer.from('b-original').toString('base64'))
    expect(await store.ownerOf(lateId)).toBeNull()
  })

  it('stillPresent answers the TrackFusionMediaPort contract other legs check before carrying a reference (review M2)', async () => {
    const { store } = await buildMediaStoreForTest()
    const id = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'A',
      kind: 'keyFrame',
      timestamp: 100,
    })
    expect(await store.stillPresent(id)).toBe(true)
    await store.deleteById(id)
    expect(await store.stillPresent(id)).toBe(false)
  })

  it("an unreadable absorbed blob never touches the survivor's row — nor the absorbed row (review N1/P1)", async () => {
    const { store, storage } = await buildMediaStoreForTest()
    const aLast = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'A',
      kind: 'lastFrame',
      timestamp: 500,
      data: Buffer.from('a-last'),
    })
    const bLast = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'B',
      kind: 'lastFrame',
      timestamp: 9000,
      data: Buffer.from('b-last'),
    })
    // B's file goes missing (D148's orphan-audit class) before the fusion
    // runs. `lastFrame` always keeps the ABSORBED piece by kind rule
    // (`MediaStore.keepAbsorbed`), regardless of `bestShotFrom` — exactly why
    // the reviewer picked this kind for the repro.
    storage.files.delete(`${DEFAULT_MEDIA_LOCATION}:1/events/track/B/lastFrame.jpg`)
    const counts = await store.reassignTrack({ ...fuse('A', 'B', 'survivor'), media: store })
    // review P1: the pair is DEFERRED — the survivor keeps its own row and
    // blob, but the absorbed row is NEVER dropped either (a read failure is
    // never treated as an answer). Pre-N1: the survivor's row+blob were
    // dropped before the winning blob was read, and the leaf threw on the
    // missing file, so the survivor ended with nothing, permanently. Pre-P1
    // (N1 as first shipped): a "confirmed missing" read flipped the decision
    // and deleted the absorbed row instead — also wrong, since `exists()`
    // cannot tell "gone" from "the location is offline".
    expect(await store.ownerOf(aLast)).toMatchObject({ ownerKind: 'track', ownerId: 'A' })
    expect(await store.ownerOf(bLast)).toMatchObject({ ownerKind: 'track', ownerId: 'B' })
    const survivorBlob = await store.getById(aLast)
    expect(survivorBlob?.base64).toBe(Buffer.from('a-last').toString('base64'))
    expect(counts).toEqual([{ family: 'media', moved: 0, dropped: 0, kept: 1 }])
  })

  it("a location that answers exists:false while read throws never reads as 'confirmed missing' (review P1)", async () => {
    const { store, storage } = await buildMediaStoreForTest()
    const aLast = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'A',
      kind: 'lastFrame',
      timestamp: 500,
      data: Buffer.from('a-last'),
    })
    const bLast = await putOwnedMedia(store, {
      ownerKind: 'track',
      ownerId: 'B',
      kind: 'lastFrame',
      timestamp: 9000,
      data: Buffer.from('b-last'),
    })
    // The file is still THERE — the location is merely unreachable right
    // now (a stale network mount, an unresolvable root). Both real
    // `exists()` implementations answer `false` for this exactly as they do
    // for a genuinely missing file (EIO/EACCES/ENOENT are indistinguishable
    // through a bare boolean), which is why the fix never consults `exists`
    // at all — only whether the READ itself succeeded.
    const bPath = '1/events/track/B/lastFrame.jpg'
    const realRead = storage.read.bind(storage)
    storage.read = async (input) => {
      if (input.location === DEFAULT_MEDIA_LOCATION && input.relativePath === bPath) {
        throw new Error('location offline')
      }
      return realRead(input)
    }
    storage.exists = async () => false
    const counts = await store.reassignTrack({ ...fuse('A', 'B', 'survivor'), media: store })
    expect(await store.ownerOf(aLast)).toMatchObject({ ownerKind: 'track', ownerId: 'A' })
    expect(await store.ownerOf(bLast)).toMatchObject({ ownerKind: 'track', ownerId: 'B' })
    expect(counts).toEqual([{ family: 'media', moved: 0, dropped: 0, kept: 1 }])
  })
})
