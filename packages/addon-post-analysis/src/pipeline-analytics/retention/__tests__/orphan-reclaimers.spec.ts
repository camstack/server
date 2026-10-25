/**
 * The audit's reclaim must go through whatever OWNS the row, not through a raw
 * collection delete.
 *
 * The defect this pins, measured on the live hub 2026-09-13: the audit reclaimed
 * an orphaned `faces` row with `settingsStore.delete`, while `FaceStore.delete`
 * is `store.delete` FOLLOWED BY `vectors.drop([faceId])`. So every face row the
 * sweep collected left its ArcFace vector behind — in an index whose rows are
 * reachable only by that face's id, in a store no sweep walks. 2 568 such
 * vectors were sitting in `vec_face_arcface_vector_chunks00` at 20 MB.
 *
 * It is the same shape the media branch was already hardened against — a
 * reclaim that "turns an orphan into bytes nothing names" — one layer over, and
 * it was invisible because the raw delete really did delete the row it was
 * asked about.
 */
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { FACES_COLLECTION } from '../../store/face-store.js'
import { TRACK_ALIASES_COLLECTION } from '../../store/track-alias-store.js'
import { auditableCollections } from '../collection-classification.js'
import { buildOrphanReclaimer, RECLAIMED_COLLECTIONS } from '../orphan-reclaimers.js'

function harness() {
  const deletedFaces: string[] = []
  const deletedPlates: Array<{ plateId: string; assert?: { trackId: string } }> = []
  const deletedRows: Array<{
    collection: string
    key: string
    assert?: { trackId: string }
  }> = []
  const confirmedMedia: number[] = []
  const deletedAliases: string[] = []
  const reclaim = buildOrphanReclaimer({
    deleteFace: async (faceId) => {
      deletedFaces.push(faceId)
    },
    deleteMediaConfirmed: async (mediaId) => {
      confirmedMedia.push(mediaId)
      return { rows: 1, bytes: 4_096 }
    },
    deleteTrackAlias: async (aliasId) => {
      deletedAliases.push(aliasId)
      return true
    },
    deletePlate: async (plateId, assert) => {
      deletedPlates.push({ plateId, ...(assert !== undefined ? { assert } : {}) })
      return true
    },
    deleteRow: async (collection, key, assert) => {
      deletedRows.push({ collection, key, ...(assert !== undefined ? { assert } : {}) })
      return true
    },
    logger: makeSilentLogger(),
  })
  return { reclaim, deletedFaces, deletedRows, deletedPlates, confirmedMedia, deletedAliases }
}

describe('the orphan audit reclaims through the owner', () => {
  it('takes a face vector with its face row', async () => {
    const h = harness()

    const out = await h.reclaim(FACES_COLLECTION, 'face-1')

    expect(h.deletedFaces, 'the face must go through the store that owns its vector').toEqual([
      'face-1',
    ])
    // And NOT through the raw path, which would leave the vector behind.
    expect(h.deletedRows).toEqual([])
    expect(out.rows).toBe(1)
  })

  it('confirms the blob is gone before forgetting a media row', async () => {
    const h = harness()

    const out = await h.reclaim('pipeline-analytics:media', '509')

    expect(h.confirmedMedia).toEqual([509])
    expect(out).toEqual({ rows: 1, bytes: 4_096 })
  })

  it('keeps a media row whose key it cannot read as a rowid', async () => {
    const h = harness()

    const out = await h.reclaim('pipeline-analytics:media', 'not-a-rowid')

    expect(h.confirmedMedia).toEqual([])
    expect(out).toEqual({ rows: 0, bytes: 0 })
  })

  it('deletes a plate through the plate ledger, never the raw collection delete', async () => {
    const h = harness()

    await h.reclaim('pipeline-analytics:plates', 'plate-1', { trackId: 'dead-1' })

    expect(h.deletedPlates).toEqual([{ plateId: 'plate-1', assert: { trackId: 'dead-1' } }])
    expect(h.deletedRows).toEqual([])
  })

  it('reasserts trackId on an object-events raw delete (D694 rowid-reuse race)', async () => {
    const h = harness()

    await h.reclaim('pipeline-analytics:object-events', '292786', { trackId: 'dead-track' })

    expect(h.deletedRows).toEqual([
      {
        collection: 'pipeline-analytics:object-events',
        key: '292786',
        assert: { trackId: 'dead-track' },
      },
    ])
  })

  it('keeps an object-events row when the reclaim has no trackId to assert', async () => {
    const h = harness()

    const out = await h.reclaim('pipeline-analytics:object-events', '292786', {})

    expect(h.deletedRows).toEqual([])
    expect(out).toEqual({ rows: 0, bytes: null })
  })

  it('refuses a collection nobody declared, rather than guessing the raw path', async () => {
    // The whole point of the map: a new auditable collection cannot quietly
    // inherit the path that caused this defect. It has to be declared.
    const h = harness()

    await expect(h.reclaim('pipeline-analytics:something-new', 'x')).rejects.toThrow(
      /not declared/i,
    )
  })

  it('reclaims an orphaned track alias through its store, not the raw delete', async () => {
    // `TrackAliasStore` keeps a RAM view (`recent`) that answers `resolve` /
    // `resolveSync` for up to an hour. A raw row delete leaves it resolving
    // the reclaimed alias; `deleteAlias` drops both.
    const h = harness()

    const out = await h.reclaim(TRACK_ALIASES_COLLECTION, 'prov-7')

    expect(h.deletedAliases).toEqual(['prov-7'])
    expect(h.deletedRows).toEqual([])
    expect(out).toEqual({ rows: 1, bytes: null })
  })

  it('declares a reclaimer for every collection the audit walks', () => {
    // The guard in script form; here so the failure is immediate rather than
    // waiting for CI. Compared against the audit's OWN list — a hand-written
    // copy stayed green while `track-aliases` became auditable without a
    // reclaimer, and only the script guard saw it.
    const walked = auditableCollections().map((c) => c.collection)
    expect([...RECLAIMED_COLLECTIONS].toSorted()).toEqual([...walked].toSorted())
  })
})
