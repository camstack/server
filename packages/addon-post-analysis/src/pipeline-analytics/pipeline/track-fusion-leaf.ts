/**
 * The fusion half of the track-leaf contract (D683 §6.1 invariant 4).
 *
 * A store holding rows keyed by a trackId must be able to DELETE them with
 * the track (`TrackScopedStore`, the retention cascade) and to RE-POINT them
 * when L2 fuses two pieces of one subject (`TrackFusibleStore`). One registry
 * carries both, typed as the intersection, so a leaf that forgets fusion does
 * not compile.
 *
 * Both rows of a fusion are ACTIVE tracks (a fusion never touches a closed
 * one), so nothing here reopens history; every step is idempotent — running a
 * fusion twice moves nothing the second time.
 */
import type { TrackCascadeFamily, TrackScopedStore } from './delete-track-cascade.js'

export type TrackMediaOwnerKind = 'face' | 'plate'

/** The media operations a face/plate leaf needs for ITS rows' media. */
export interface TrackFusionMediaPort {
  moveOwner(ownerKind: TrackMediaOwnerKind, fromOwnerId: string, toOwnerId: string): Promise<number>
  deleteOwner(ownerKind: TrackMediaOwnerKind, ownerId: string): Promise<number>
  /**
   * Is this media id still a live row (review M2)? The media leg can drop the
   * LOSING side of a single-instance pair before a later leaf (face/plate,
   * the CLIP vector) carries a row that still names that id in
   * `keyFrameMediaId` / `mediaId` — a later leaf checks this and clears the
   * stale reference (logged) rather than pointing at nothing.
   */
  stillPresent(mediaId: number): Promise<boolean>
}

export interface TrackFusionRequest {
  readonly deviceId: number
  readonly survivorId: string
  readonly absorbedId: string
  /** Which piece's best shot the merged ranking kept (D400). */
  readonly bestShotFrom: 'survivor' | 'absorbed'
  /**
   * The best-shot media rows the survivor's resident state holds NOW (its
   * current `keyFrameMediaId` and small variant). Set by the sweep-up at close
   * (review 2 M2): a single-instance row whose id is here wins over
   * `bestShotFrom`, which was decided at fusion time and may be stale — the
   * survivor can have produced a better shot since.
   */
  readonly keepMediaIds?: ReadonlySet<number>
  readonly media: TrackFusionMediaPort
}

export interface TrackFusionLeafCount {
  readonly family: TrackCascadeFamily
  /** Rows now owned by the survivor. */
  readonly moved: number
  /** Rows (and their blobs) removed because the survivor kept its own. */
  readonly dropped: number
  /** Rows left under the absorbed id on purpose (an enrolled face or plate). */
  readonly kept?: number
}

export interface TrackFusibleStore {
  reassignTrack(req: TrackFusionRequest): Promise<readonly TrackFusionLeafCount[]>
}

export type TrackLeafStore = TrackScopedStore & TrackFusibleStore

export interface FusionLeafFailure {
  readonly index: number
  readonly error: string
}

export interface FusionLeafReport {
  readonly counts: readonly TrackFusionLeafCount[]
  readonly failures: readonly FusionLeafFailure[]
}

/** A stored row's `data` as a record — the guard the leaves use instead of a cast. */
export function isRowData(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Every leaf, in registry order, each isolated: one failure is reported and the rest still run. */
export async function fuseTrackLeaves(
  registry: readonly TrackFusibleStore[],
  req: TrackFusionRequest,
): Promise<FusionLeafReport> {
  const counts: TrackFusionLeafCount[] = []
  const failures: FusionLeafFailure[] = []
  for (const [index, store] of registry.entries()) {
    try {
      counts.push(...(await store.reassignTrack(req)))
    } catch (err) {
      failures.push({ index, error: String(err) })
    }
  }
  return { counts, failures }
}
