/**
 * The `face-arcface` wiring of the vector-index orphan leg.
 *
 * ## The one thing that must not be copied
 *
 * A CLIP row is owned by a TRACK and its row id IS the track id, so
 * `ObjectEmbeddingStore.scanRefs` can fall back to the id when the metadata is
 * missing. A face vector's id is the FACE id, and it carries a `trackId` in its
 * metadata because a face was cut from a track's frame.
 *
 * Judging a face vector on that `trackId` would be wrong twice, and the second
 * way is severe:
 *
 *  1. The fallback would ask "is this FACE id a live track?", get `no` for
 *     every row, and empty the whole facial index.
 *  2. An ENROLLED face is exempt from retention (`assigned` on the row) and
 *     outlives its track by design. A scan keyed on the track would delete the
 *     vectors of precisely the people the operator registered by hand, the
 *     moment their track aged out — degrading recognition in silence, for the
 *     identities that matter most.
 *
 * The owner of a face vector is the FACE ROW. `existingFaceIds` answers exactly
 * that question and throws rather than under-reporting, because "I could not
 * find out" and "it is not there" must never be the same answer here.
 *
 * ## Why this leg exists at all
 *
 * D486 made the audit reclaim through the owner, so a face row collected by the
 * sweep now takes its vector with it: the CONTINUOUS leak is closed. What
 * remains is the case `delete-track-cascade.ts` documents about itself — a hub
 * that boots without the `vector-store` capability builds a cascade with no
 * vector leg and prunes for the life of the process, and every vector for every
 * row deleted in that window becomes unreachable by ownership. Plus whatever a
 * maintenance window deleted in raw SQL. Both are reachable only by walking the
 * index, which is what this does.
 */
import type { IScopedLogger } from '@camstack/types'
import type { FaceStore } from '../store/face-store.js'
import type { EmbeddingOrphanScanDeps } from './embedding-orphan-scan.js'

/** The scope id this leg reports and persists its cursor under. */
export const FACE_VECTOR_ORPHAN_SCOPE = 'vector-index:face-arcface'

export interface FaceVectorOrphanDeps {
  readonly faces: FaceStore
  readonly now: () => number
  readonly logger: IScopedLogger
  readonly breathe?: () => Promise<void>
}

/** The scan deps for the face index. A wiring, not an algorithm. */
export function faceVectorOrphanDeps(deps: FaceVectorOrphanDeps): EmbeddingOrphanScanDeps {
  return {
    scope: FACE_VECTOR_ORPHAN_SCOPE,
    scanPage: async (cursor, limit) => {
      const page = await deps.faces.scanVectorRefs(cursor, limit)
      return {
        rows: page.rows.map((r) => ({
          id: r.id,
          // The row id IS the face id. Deliberately not the metadata's
          // `trackId` — see this file's header.
          ownerId: r.id.length > 0 ? r.id : null,
          deviceId: r.deviceId,
          timestamp: r.timestamp,
        })),
        nextCursor: page.nextCursor,
      }
    },
    liveOwnerIds: (ids) => deps.faces.existingFaceIds(ids),
    reclaim: (ids) => deps.faces.dropVectorsVerified(ids),
    now: deps.now,
    logger: deps.logger,
    ...(deps.breathe !== undefined ? { breathe: deps.breathe } : {}),
  }
}
