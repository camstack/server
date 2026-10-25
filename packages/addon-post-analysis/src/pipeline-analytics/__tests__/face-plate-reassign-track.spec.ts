/**
 * Face and plate rows on a fusion (spec §6.3): one row per track survives
 * under the survivor's id; an ENROLLED (`assigned`) row is never deleted —
 * when it loses, it stays under its own id; its media follows the row that
 * survives.
 *
 * Disarms (each alone, restored):
 *  - in `FaceStore.reassignTrack`, ignore `assigned` in the ranking:
 *    "an enrolled absorbed face wins over an unassigned survivor face" fails;
 *  - drop `|| survivor?.assigned === true` from the keep-the-survivor branch:
 *    "an enrolled survivor row is never deleted, even when the absorbed one
 *    ranks higher" fails;
 *  - use `getWithEmbedding` for the SURVIVOR's rank decision again: "an
 *    enrolled survivor face with no vector is still enrolled" fails (review M1);
 *  - reorder back to insert → delete(fromId) → moveOwner: "a crash during
 *    moveOwner leaves the absorbed row for a retry" fails (review H2);
 *  - drop the post-insert verify (`if ((await this.get(toId)) === null) throw`):
 *    "a swallowed insert failure never deletes the enrolled absorbed row" fails
 *    (review H2);
 *  - drop the `stillPresent` check on `keyFrameMediaId`: "a carried face row
 *    drops a keyFrameMediaId the media leg no longer has" fails (review M2);
 *  - in `PlateStore.reassignTrack`, remove both enrolled-row guards: "an
 *    enrolled survivor plate is never deleted…" fails (review M3);
 *  - drop the survivor's-own-reference check at the top of the keep-survivor
 *    branch: "the survivor's own keyFrameMediaId is cleared…" fails (review N2);
 *  - in the drop branch, swap back to row-then-media: "a crash during
 *    deleteOwner in the drop branch leaves the absorbed row for a retry" fails
 *    (review N3);
 *  - drop the verify after the final `delete(fromId)`: "a swallowed final
 *    delete failure is not silently accepted" fails (review N3);
 *  - drop the verify after `update(toId, { keyFrameMediaId: null })`: "a
 *    swallowed clear of the survivor's own stale keyFrameMediaId is not
 *    silently accepted" fails (review P3).
 */
import { describe, expect, it } from 'vitest'
import { buildMediaStoreForTest, putOwnedMedia } from './media-store-test-helpers.js'
import {
  buildFaceStoreForTest,
  buildFaceStoreForTestWithFailingDelete,
  buildFaceStoreForTestWithFailingSet,
  buildFaceStoreForTestWithFailingUpdate,
  buildPlateStoreForTest,
  buildPlateStoreForTestWithFailingDelete,
  buildPlateStoreForTestWithFailingSet,
  buildPlateStoreForTestWithFailingUpdate,
  faceRow,
  plateRow,
  type RecordingMediaPort,
  recordingMediaPort,
} from './face-plate-test-helpers.js'

const fuse = { deviceId: 1, survivorId: 'A', absorbedId: 'B', bestShotFrom: 'survivor' } as const

/** A media port whose `moveOwner` always throws — simulates a crash exactly
 *  at the step between `insert` and `delete(fromId)` (review H2). */
function crashingDuringMoveOwner(): RecordingMediaPort {
  return {
    calls: [],
    moveOwner: async () => {
      throw new Error('simulated crash mid-move')
    },
    deleteOwner: async () => 0,
    stillPresent: async () => true,
  }
}

/** A media port whose `deleteOwner` always throws — simulates a crash in the
 *  drop branch, between media and row (review N3). */
function crashingDuringDeleteOwner(): RecordingMediaPort {
  return {
    calls: [],
    moveOwner: async () => 0,
    deleteOwner: async () => {
      throw new Error('simulated crash mid-drop')
    },
    stillPresent: async () => true,
  }
}

describe('reassignTrack on face and plate rows', () => {
  it('an absorbed face alone is re-keyed to the survivor, with its media', async () => {
    const faces = await buildFaceStoreForTest()
    await faces.insert(faceRow({ trackId: 'B' }))
    const media = recordingMediaPort()
    await faces.reassignTrack({ ...fuse, media })
    expect(await faces.get('face-A')).not.toBeNull()
    expect(await faces.get('face-B')).toBeNull()
    expect(media.calls).toEqual(['move face face-B face-A'])
  })

  it('an enrolled absorbed face wins over an unassigned survivor face', async () => {
    const faces = await buildFaceStoreForTest()
    // The survivor's row is recognised and NEWER: only `assigned` puts the absorbed row ahead.
    await faces.insert(faceRow({ trackId: 'A', recognizedIdentityId: 'id-3', timestamp: 9000 }))
    await faces.insert(
      faceRow({ trackId: 'B', assigned: true, recognizedIdentityId: 'id-7', timestamp: 1000 }),
    )
    const media = recordingMediaPort()
    await faces.reassignTrack({ ...fuse, media })
    expect((await faces.get('face-A'))?.assigned).toBe(true)
    expect(media.calls).toEqual(['delete face face-A', 'move face face-B face-A'])
  })

  it('an enrolled survivor row is never deleted, even when the absorbed one ranks higher', async () => {
    const faces = await buildFaceStoreForTest()
    await faces.insert(faceRow({ trackId: 'A', assigned: true }))
    await faces.insert(faceRow({ trackId: 'B', assigned: true, recognizedIdentityId: 'id-7' }))
    const media = recordingMediaPort()
    const counts = await faces.reassignTrack({ ...fuse, media })
    expect((await faces.get('face-A'))?.assigned).toBe(true)
    expect((await faces.get('face-B'))?.assigned).toBe(true)
    expect(media.calls).toEqual([])
    expect(counts).toEqual([{ family: 'faces', moved: 0, dropped: 0, kept: 1 }])
  })

  it('the higher-scoring plate read survives', async () => {
    const plates = await buildPlateStoreForTest()
    await plates.insert(plateRow({ trackId: 'A', score: 0.6 }))
    await plates.insert(plateRow({ trackId: 'B', score: 0.9 }))
    const media = recordingMediaPort()
    await plates.reassignTrack({ ...fuse, media })
    expect((await plates.get('plate-A'))?.score).toBe(0.9)
    expect(await plates.get('plate-B')).toBeNull()
  })

  it('an enrolled survivor face with no vector is still enrolled, never overwritten (review M1)', async () => {
    const faces = await buildFaceStoreForTest()
    // Exists, but no vector in either home (the drained legacy column plus a
    // `put` that refuses an empty embedding) — `getWithEmbedding` would answer
    // `null` for this row, which is exactly the trap: presence/rank must come
    // from `get()`, never from the vector fetch.
    await faces.insert(faceRow({ trackId: 'A', assigned: true, embedding: [] }))
    await faces.insert(faceRow({ trackId: 'B' }))
    const media = recordingMediaPort()
    const counts = await faces.reassignTrack({ ...fuse, media })
    expect((await faces.get('face-A'))?.assigned).toBe(true)
    expect(media.calls).toEqual(['delete face face-B'])
    expect(counts).toEqual([{ family: 'faces', moved: 0, dropped: 1 }])
  })

  it('a crash during moveOwner leaves the absorbed face row for a retry (review H2)', async () => {
    const faces = await buildFaceStoreForTest()
    await faces.insert(faceRow({ trackId: 'B' }))
    await expect(
      faces.reassignTrack({ ...fuse, media: crashingDuringMoveOwner() }),
    ).rejects.toThrow('simulated crash mid-move')
    // fromId must still be there — a retry can still find it and finish the
    // job. Pre-fix (insert → delete(fromId) → moveOwner), the row would
    // already be gone here, and a retry could never move its media.
    expect(await faces.get('face-B')).not.toBeNull()
  })

  it('a crash during moveOwner leaves the absorbed plate row for a retry (review H2)', async () => {
    const plates = await buildPlateStoreForTest()
    await plates.insert(plateRow({ trackId: 'B' }))
    await expect(
      plates.reassignTrack({ ...fuse, media: crashingDuringMoveOwner() }),
    ).rejects.toThrow('simulated crash mid-move')
    expect(await plates.get('plate-B')).not.toBeNull()
  })

  it('a swallowed insert failure never deletes the enrolled absorbed face row (review H2)', async () => {
    const { store: faces, armFailNextSet } = await buildFaceStoreForTestWithFailingSet()
    await faces.insert(faceRow({ trackId: 'B', assigned: true, recognizedIdentityId: 'id-9' }))
    // No survivor row: the absorbed row is unconditionally carried, which is
    // exactly the path whose `insert` must be verified before anything else
    // touches the source.
    armFailNextSet()
    const media = recordingMediaPort()
    await expect(faces.reassignTrack({ ...fuse, media })).rejects.toThrow()
    expect((await faces.get('face-B'))?.assigned).toBe(true)
    expect(media.calls).toEqual([])
  })

  it('a swallowed insert failure never deletes the enrolled absorbed plate row (review H2)', async () => {
    const { store: plates, armFailNextSet } = await buildPlateStoreForTestWithFailingSet()
    await plates.insert(plateRow({ trackId: 'B', assigned: true }))
    armFailNextSet()
    const media = recordingMediaPort()
    await expect(plates.reassignTrack({ ...fuse, media })).rejects.toThrow()
    expect((await plates.get('plate-B'))?.assigned).toBe(true)
    expect(media.calls).toEqual([])
  })

  it('a carried face row drops a keyFrameMediaId the media leg no longer has (review M2)', async () => {
    const faces = await buildFaceStoreForTest()
    await faces.insert(faceRow({ trackId: 'B', keyFrameMediaId: 999 }))
    const media = recordingMediaPort({ absentMediaIds: new Set([999]) })
    await faces.reassignTrack({ ...fuse, media })
    expect((await faces.get('face-A'))?.keyFrameMediaId).toBeUndefined()
  })

  it('a carried face row keeps a keyFrameMediaId the media leg still has (review M2)', async () => {
    const faces = await buildFaceStoreForTest()
    await faces.insert(faceRow({ trackId: 'B', keyFrameMediaId: 777 }))
    const media = recordingMediaPort()
    await faces.reassignTrack({ ...fuse, media })
    expect((await faces.get('face-A'))?.keyFrameMediaId).toBe(777)
  })

  it('a carried plate row drops a keyFrameMediaId the media leg no longer has (review M2)', async () => {
    const plates = await buildPlateStoreForTest()
    await plates.insert(plateRow({ trackId: 'B', keyFrameMediaId: 999 }))
    const media = recordingMediaPort({ absentMediaIds: new Set([999]) })
    await plates.reassignTrack({ ...fuse, media })
    expect((await plates.get('plate-A'))?.keyFrameMediaId).toBeUndefined()
  })

  it('media survives a re-run once moveOwner has already landed (review H2)', async () => {
    const faces = await buildFaceStoreForTest()
    const { store: media } = await buildMediaStoreForTest()
    // Both rows hold IDENTICAL data, as `insert({...carried, id: toId})`
    // leaves them right after a first run's insert — and the crop is
    // already under the survivor, as a first run's `moveOwner` would leave
    // it. Only `delete(fromId)` remains.
    const common = { assigned: false, timestamp: 1000, embedding: [0.1, 0.2, 0.3, 0.4] } as const
    await faces.insert(faceRow({ trackId: 'B', ...common }))
    await faces.insert(faceRow({ trackId: 'A', ...common }))
    const cropId = await putOwnedMedia(media, {
      ownerKind: 'face',
      ownerId: 'face-A',
      kind: 'faceCrop',
      timestamp: 1000,
    })
    await faces.reassignTrack({ ...fuse, media })
    expect(await faces.get('face-B')).toBeNull()
    expect(await media.ownerOf(cropId)).toMatchObject({ ownerKind: 'face', ownerId: 'face-A' })
  })

  it('an enrolled absorbed plate wins over an unassigned survivor plate (review M3)', async () => {
    const plates = await buildPlateStoreForTest()
    await plates.insert(plateRow({ trackId: 'A', corrected: true, score: 0.9 }))
    await plates.insert(plateRow({ trackId: 'B', assigned: true, score: 0.1 }))
    const media = recordingMediaPort()
    await plates.reassignTrack({ ...fuse, media })
    expect((await plates.get('plate-A'))?.assigned).toBe(true)
    expect(media.calls).toEqual(['delete plate plate-A', 'move plate plate-B plate-A'])
  })

  it('an enrolled survivor plate is never deleted, even when the absorbed one ranks higher (review M3)', async () => {
    const plates = await buildPlateStoreForTest()
    await plates.insert(plateRow({ trackId: 'A', assigned: true }))
    await plates.insert(plateRow({ trackId: 'B', assigned: true, corrected: true }))
    const media = recordingMediaPort()
    const counts = await plates.reassignTrack({ ...fuse, media })
    expect((await plates.get('plate-A'))?.assigned).toBe(true)
    expect((await plates.get('plate-B'))?.assigned).toBe(true)
    expect(media.calls).toEqual([])
    expect(counts).toEqual([{ family: 'plates', moved: 0, dropped: 0, kept: 1 }])
  })

  it("the survivor's own keyFrameMediaId is cleared when the media leg no longer has it, face (review N2)", async () => {
    const faces = await buildFaceStoreForTest()
    await faces.insert(faceRow({ trackId: 'A', assigned: true, keyFrameMediaId: 999 }))
    await faces.insert(faceRow({ trackId: 'B' }))
    const media = recordingMediaPort({ absentMediaIds: new Set([999]) })
    const counts = await faces.reassignTrack({ ...fuse, media })
    expect((await faces.get('face-A'))?.assigned).toBe(true)
    expect((await faces.get('face-A'))?.keyFrameMediaId).toBeUndefined()
    expect(counts).toEqual([{ family: 'faces', moved: 0, dropped: 1 }])
  })

  it("the survivor's own keyFrameMediaId is cleared when the media leg no longer has it, plate (review N2)", async () => {
    const plates = await buildPlateStoreForTest()
    await plates.insert(plateRow({ trackId: 'A', assigned: true, keyFrameMediaId: 999 }))
    await plates.insert(plateRow({ trackId: 'B' }))
    const media = recordingMediaPort({ absentMediaIds: new Set([999]) })
    const counts = await plates.reassignTrack({ ...fuse, media })
    expect((await plates.get('plate-A'))?.assigned).toBe(true)
    expect((await plates.get('plate-A'))?.keyFrameMediaId).toBeUndefined()
    expect(counts).toEqual([{ family: 'plates', moved: 0, dropped: 1 }])
  })

  it('a crash during deleteOwner in the drop branch leaves the absorbed face row for a retry (review N3)', async () => {
    const faces = await buildFaceStoreForTest()
    await faces.insert(faceRow({ trackId: 'A', assigned: true }))
    await faces.insert(faceRow({ trackId: 'B' }))
    await expect(
      faces.reassignTrack({ ...fuse, media: crashingDuringDeleteOwner() }),
    ).rejects.toThrow('simulated crash mid-drop')
    // fromId must still be there — a retry can still find it and finish the
    // drop. Pre-fix (row before media), the row would already be gone here.
    expect(await faces.get('face-B')).not.toBeNull()
  })

  it('a crash during deleteOwner in the drop branch leaves the absorbed plate row for a retry (review N3)', async () => {
    const plates = await buildPlateStoreForTest()
    await plates.insert(plateRow({ trackId: 'A', assigned: true }))
    await plates.insert(plateRow({ trackId: 'B' }))
    await expect(
      plates.reassignTrack({ ...fuse, media: crashingDuringDeleteOwner() }),
    ).rejects.toThrow('simulated crash mid-drop')
    expect(await plates.get('plate-B')).not.toBeNull()
  })

  it('a swallowed final delete failure is not silently accepted, face (review N3)', async () => {
    const { store: faces, armFailNextDelete } = await buildFaceStoreForTestWithFailingDelete()
    await faces.insert(faceRow({ trackId: 'B' }))
    armFailNextDelete()
    const media = recordingMediaPort()
    await expect(faces.reassignTrack({ ...fuse, media })).rejects.toThrow()
    // The carry itself landed (insert + moveOwner) — only the cleanup delete failed.
    expect(await faces.get('face-A')).not.toBeNull()
    expect(media.calls).toEqual(['move face face-B face-A'])
  })

  it('a swallowed final delete failure is not silently accepted, plate (review N3)', async () => {
    const { store: plates, armFailNextDelete } = await buildPlateStoreForTestWithFailingDelete()
    await plates.insert(plateRow({ trackId: 'B' }))
    armFailNextDelete()
    const media = recordingMediaPort()
    await expect(plates.reassignTrack({ ...fuse, media })).rejects.toThrow()
    expect(await plates.get('plate-A')).not.toBeNull()
    expect(media.calls).toEqual(['move plate plate-B plate-A'])
  })

  it("a swallowed clear of the survivor's own stale keyFrameMediaId is not silently accepted, face (review P3)", async () => {
    const { store: faces, armFailNextUpdate } = await buildFaceStoreForTestWithFailingUpdate()
    await faces.insert(faceRow({ trackId: 'A', assigned: true, keyFrameMediaId: 999 }))
    await faces.insert(faceRow({ trackId: 'B' }))
    armFailNextUpdate()
    const media = recordingMediaPort({ absentMediaIds: new Set([999]) })
    await expect(faces.reassignTrack({ ...fuse, media })).rejects.toThrow()
    // The clear never landed — the stale id is still there, and the leaf
    // says so instead of silently moving on.
    expect((await faces.get('face-A'))?.keyFrameMediaId).toBe(999)
  })

  it("a swallowed clear of the survivor's own stale keyFrameMediaId is not silently accepted, plate (review P3)", async () => {
    const { store: plates, armFailNextUpdate } = await buildPlateStoreForTestWithFailingUpdate()
    await plates.insert(plateRow({ trackId: 'A', assigned: true, keyFrameMediaId: 999 }))
    await plates.insert(plateRow({ trackId: 'B' }))
    armFailNextUpdate()
    const media = recordingMediaPort({ absentMediaIds: new Set([999]) })
    await expect(plates.reassignTrack({ ...fuse, media })).rejects.toThrow()
    expect((await plates.get('plate-A'))?.keyFrameMediaId).toBe(999)
  })
})
