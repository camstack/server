/**
 * Which delete the orphan audit uses for each collection it walks.
 *
 * ## The defect this exists to make impossible
 *
 * The audit's reclaim was one `if` for media and a raw
 * `settingsStore.delete` for everything else. That raw delete really does
 * delete the row it is asked about, which is why nothing noticed that
 * `FaceStore.delete` is `store.delete` FOLLOWED BY `vectors.drop([faceId])`:
 * the sweep collected the face row and left its ArcFace vector behind, in an
 * index whose rows are reachable only by that face's id, walked by no sweep at
 * all. Measured on the live hub 2026-09-13: 2 568 such vectors, 20 MB, in
 * `vec_face_arcface_vector_chunks00`.
 *
 * It is exactly the shape the media branch was already hardened against —
 * "turns an orphan into bytes nothing names, which is strictly worse than the
 * state it was cleaning up" — one layer over, and with no blob to make it
 * visible on a disk.
 *
 * ## Why a map and not two more `if`s
 *
 * Because the next collection is the problem. A raw-delete DEFAULT means a
 * collection whose store grows side state later inherits the broken path
 * silently, and the only evidence is bytes in a table nobody is measuring. So
 * there is no default: a collection the audit walks and this map does not name
 * THROWS, and `scripts/check-orphan-reclaimers.ts` fails the build before it
 * can ever be reached at runtime.
 */
import type { IScopedLogger, SettingsStoreClient } from '@camstack/types'
import { FACES_COLLECTION } from '../store/face-store.js'
import { MEDIA_COLLECTION } from '../store/media-store.js'
import { TRACK_ALIASES_COLLECTION } from '../store/track-alias-store.js'
import type { OrphanReclaimOutcome } from './orphan-audit.js'

/** What a reclaimer needs. Each port is the OWNER's delete, never a raw one. */
export interface OrphanReclaimerPorts {
  /**
   * `FaceStore.delete` — the row AND its `face-arcface` vector. Never
   * `settingsStore.delete` on the faces collection.
   */
  readonly deleteFace: (faceId: string) => Promise<void>
  /**
   * `MediaStore.deleteConfirmed` — unlink, re-probe, then drop the row. Never
   * `deleteByKey`, whose `deleteByKeyUnchecked` swallows the unlink error and
   * drops the row anyway.
   */
  readonly deleteMediaConfirmed: (mediaId: number) => Promise<OrphanReclaimOutcome>
  /**
   * `TrackAliasStore.deleteAlias` — the row AND the store's RAM view
   * (`recent`), which a raw delete would leave resolving the reclaimed alias
   * for up to an hour. `true` only when a row went.
   */
  readonly deleteTrackAlias: (aliasId: string) => Promise<boolean>
  /**
   * The plate's delete through ITS LEDGER (the `plates` records kind on a hub)
   * — never a settings-store delete by collection name, which names a table a
   * migrated hub no longer has. `assert.trackId`, when given, must match the
   * row's own `trackId` or nothing is deleted. `true` only when a row went.
   */
  readonly deletePlate: (plateId: string, assert?: OrphanRawDeleteAssert) => Promise<boolean>
  /**
   * The plain collection delete, for a row whose store owns nothing else —
   * {@link settingsRowDeleter}. `true` only when a row went.
   *
   * `assert.trackId` re-states the orphanhood the audit already judged
   * (D694 follow-up): an object-events rowid can be reused by a new live
   * event between the probe and the delete; matching on the dead track's id
   * as well as the rowid refuses to delete the new holder.
   */
  readonly deleteRow: (
    collection: string,
    key: string,
    assert?: OrphanRawDeleteAssert,
  ) => Promise<boolean>
  readonly logger: IScopedLogger
}

/** What a raw-delete reclaim re-asserts at delete time (D694). */
export interface OrphanRawDeleteAssert {
  readonly trackId: string
}

const OBJECT_EVENTS_COLLECTION = 'pipeline-analytics:object-events'
const PLATES_COLLECTION = 'pipeline-analytics:plates'

/**
 * Every collection `auditableCollections()` yields, and nothing else. Kept as a
 * list so the guard can compare the two without importing the engine.
 *
 * `object-events` takes the raw delete because its store owns nothing outside
 * the row — checked, not assumed: the event store has no `delete` with a
 * second step. `plates` owns nothing outside the row either ("a plate is a
 * STRING and a score"), but its rows live in the `plates` records kind on a
 * hub, so it is deleted through the plate ledger (`deletePlate`), never by
 * collection name. `track-aliases` does NOT: its store keeps a RAM view of
 * recent fusions that a raw delete would leave answering for the reclaimed
 * alias, so it goes through `deleteTrackAlias`. When a store grows side state,
 * this list is where it has to be said.
 */
export const RECLAIMED_COLLECTIONS: readonly string[] = [
  MEDIA_COLLECTION,
  FACES_COLLECTION,
  OBJECT_EVENTS_COLLECTION,
  PLATES_COLLECTION,
  TRACK_ALIASES_COLLECTION,
]

const RAW_DELETE_COLLECTIONS: ReadonlySet<string> = new Set([OBJECT_EVENTS_COLLECTION])

/**
 * The `deleteRow` port: ONE row by its primary key `id` (what every
 * raw-delete collection above declares), answering whether a row went.
 *
 * Through `deleteWhere`, because it is the delete that SAYS: `delete`'s output
 * is `z.void()`, and reading it as `!== undefined` answered `false` for every
 * row it really deleted — the audit counted every plates/object-events reclaim
 * as "found nothing", and the per-scope reclaim ceiling never tripped.
 *
 * When `assert.trackId` is set, the delete also requires that column: an
 * object-events rowid alone is not an identity across the row's life (D694).
 */
export function settingsRowDeleter(
  store: Pick<SettingsStoreClient, 'deleteWhere'>,
): OrphanReclaimerPorts['deleteRow'] {
  return async (collection, key, assert) => {
    const where = assert !== undefined ? { id: key, trackId: assert.trackId } : { id: key }
    const { deleted } = await store.deleteWhere.mutate({
      collection,
      filter: { where },
    })
    return deleted > 0
  }
}

/**
 * The `deleteRow` port AS PRODUCTION WIRES IT: {@link settingsRowDeleter} over
 * a store that may not be bound yet. Unbound THROWS — the engine counts that as
 * `reclaimFailed` and keeps the row — rather than answering "nothing deleted",
 * which is indistinguishable from a row already gone. A named factory so the
 * wiring itself is under test (D695 T7 review M1: the inline wiring could be
 * reverted to the original bug with every spec green);
 * `scripts/check-orphan-reclaimers.ts` checks `index.ts` uses it.
 */
export function settingsRowDeleterOf(
  getStore: () => Pick<SettingsStoreClient, 'deleteWhere'> | null,
): OrphanReclaimerPorts['deleteRow'] {
  return async (collection, key, assert) => {
    const store = getStore()
    if (store === null) throw new Error('orphan audit: settings store not bound')
    return await settingsRowDeleter(store)(collection, key, assert)
  }
}

/** Pull the trackId the raw delete must re-assert, or `null` when absent. */
function trackIdAssertOf(data: Record<string, unknown>): OrphanRawDeleteAssert | null {
  const trackId = data['trackId']
  return typeof trackId === 'string' && trackId.length > 0 ? { trackId } : null
}

export function buildOrphanReclaimer(
  ports: OrphanReclaimerPorts,
): (
  collection: string,
  key: string,
  data?: Record<string, unknown>,
) => Promise<OrphanReclaimOutcome> {
  return async (collection, key, data = {}) => {
    if (collection === MEDIA_COLLECTION) {
      // A key this audit cannot read as a rowid is NOT reclaimed: deleting a
      // row we could not address is the one mistake a bulk sweep must never
      // make (D482). Zero rather than nothing — the engine sums what it is
      // told, and `undefined` would read as a reclaim of unknown size.
      const mediaId = Number(key)
      if (!Number.isInteger(mediaId) || mediaId <= 0) {
        ports.logger.warn('orphan audit: media row id is unreadable — row kept', {
          meta: { collection, key },
        })
        return { rows: 0, bytes: 0 }
      }
      return await ports.deleteMediaConfirmed(mediaId)
    }
    if (collection === FACES_COLLECTION) {
      await ports.deleteFace(key)
      // A settings row has no blob to weigh, so `bytes` is unknown, not 0. The
      // vector it also freed lives in another store and has no byte answer here
      // either — claiming one would make `bytesReclaimed` a guess.
      return { rows: 1, bytes: null }
    }
    if (collection === TRACK_ALIASES_COLLECTION) {
      const deleted = await ports.deleteTrackAlias(key)
      return { rows: deleted ? 1 : 0, bytes: null }
    }
    if (collection === PLATES_COLLECTION) {
      // Plates are TEXT-keyed (no rowid reuse); the dead track's id is still
      // re-asserted when the row carries one (same column, same shape).
      const assert = trackIdAssertOf(data)
      const deleted = await ports.deletePlate(key, assert === null ? undefined : assert)
      return { rows: deleted ? 1 : 0, bytes: null }
    }
    if (RAW_DELETE_COLLECTIONS.has(collection)) {
      // Object-events ids are reusable rowids (D474/D694). Delete by id alone
      // can hit a NEW live row minted between the orphan probe and this
      // statement; the dead track's id closes that race.
      const assert = trackIdAssertOf(data)
      if (collection === OBJECT_EVENTS_COLLECTION && assert === null) {
        ports.logger.warn(
          'orphan audit: object-events reclaim without trackId — row kept (id-only delete refused)',
          { meta: { collection, key } },
        )
        return { rows: 0, bytes: null }
      }
      const deleted = await ports.deleteRow(collection, key, assert === null ? undefined : assert)
      return { rows: deleted ? 1 : 0, bytes: null }
    }
    throw new Error(
      `orphan audit: '${collection}' is not declared in RECLAIMED_COLLECTIONS — ` +
        'a collection walked by the audit must say how its rows are deleted, because ' +
        'the raw path leaves behind anything its store owns outside the row',
    )
  }
}
