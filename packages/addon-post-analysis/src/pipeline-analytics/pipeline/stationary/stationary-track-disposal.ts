/**
 * stationary-track-disposal — the tracks go, the entity stays (D547).
 *
 * A parked object is represented ONCE, by its stationary registry entry. The
 * tracks that carried the evidence for it — at most two since D547 made
 * "undecided" neutral: the session that first saw it still, and the one that
 * tipped the ledger — are re-sightings of that entity, and the operator has
 * said what they are worth: "solo le tracce stazionarie persistite come
 * tracce non sono necessarie, abbiamo comunque l'occupancy salvata." [only the stationary tracks persisted as tracks are not needed, we have the saved occupancy anyway.]
 *
 * So promotion DISPOSES of them: row, object events, snapshots, thumbnails,
 * first/last frame, face/plate crops, CLIP vector. One thing is spared — the
 * key frame the entry was born with (`StationaryEntry.keyFrameMediaId`), which
 * stays a `track`-owned row under a track id that no longer exists and is
 * vouched for by the entry instead: the orphan audit asks the registry before
 * calling such a row an orphan (`keptMediaKeys`), and the registry releases it
 * when the entry retires. An entity pointing at bytes that are not there would
 * be D400's "names the reason" defect in reverse, which is why the spec proves
 * the key frame resolves after the cascade.
 *
 * This supersedes the SCOPE of D161 for promoted tracks only: D161 persisted
 * the promoted row so its media would keep an owner retention could reach.
 * The owner is now the entry, and the media that is not the entry's is deleted
 * here, at once, by the same cascade retention runs — not orphaned.
 *
 * Pure planning, then an executor over the cascade the retention paths already
 * use (`runTrackCascadeBatch`), with the media leaf wrapped to spare one id.
 */
import type { IScopedLogger } from '@camstack/types'

import type { TrackCascadeLeafCount } from '../delete-track-cascade.js'
import {
  runTrackCascadeBatch,
  type TrackRootStore,
  type TrackScopedStore,
} from '../delete-track-cascade.js'
import type { TrackFusibleStore } from '../track-fusion-leaf.js'

export interface StationaryTrackDisposalInput {
  /**
   * The tracks that NEVER MOVED among those that carried the promotion's
   * evidence — the live one on the tipping frame and/or the source of the
   * entry's best box (`planPromotionEffects`, D683 round 4). A track that
   * moved is kept and is never listed here.
   */
  readonly trackIds: readonly string[]
  /** The media row the ENTRY keeps. Absent = the entry has no key frame yet. */
  readonly entryKeyFrameMediaId?: number
}

export interface StationaryTrackDisposalPlan {
  /** Tracks to cascade, in the order given. Each id once. */
  readonly trackIds: readonly string[]
  /** Media ids the cascade must leave in place. */
  readonly keepMediaIds: ReadonlySet<number>
}

export function planStationaryTrackDisposal(
  input: StationaryTrackDisposalInput,
): StationaryTrackDisposalPlan {
  const trackIds = [...new Set(input.trackIds)]
  const keepMediaIds = new Set<number>()
  if (input.entryKeyFrameMediaId !== undefined) keepMediaIds.add(input.entryKeyFrameMediaId)
  return { trackIds, keepMediaIds }
}

/** The media leaf, with the one thing this disposal needs that the cascade
 *  interface does not carry: a set of ids to spare. Also fusible (D683 Task
 *  15): this is the SAME leaf `buildTrackCascadeRegistry` hands to
 *  `AnalyticsCascadeStores.mediaStore`, which is typed `TrackLeafStore` — a
 *  wrapper that dropped fusion would silently un-fuse the media leg. */
export interface SparingMediaLeaf extends TrackFusibleStore {
  deleteByTracks(
    trackIds: readonly string[],
    opts?: { readonly spare?: ReadonlySet<number> },
  ): Promise<readonly TrackCascadeLeafCount[]>
}

/**
 * The media leg every track cascade runs through (D683 round 4, review M2):
 * it never deletes a row a LIVE stationary entry vouches for.
 *
 * Before round 4 the only track that could own an entry's key frame was
 * disposed at promotion with that row spared, so the entry was its only
 * holder. A track that MOVED is now kept: it owns the entry's key frame and
 * closes normally, and retention's cascade — or a discard, or an operator
 * delete — would take the bytes from under a live entry (D400's defect in
 * reverse). The row stays `track`-owned; the orphan audit asks the registry
 * (`keptMediaKeys`) and `releaseStationaryKeyFrame` frees it when the entry
 * retires and no track still owns it.
 *
 * `held` is read on every call: the set of live entries changes between sweeps.
 */
export function sparingEntryHeldMedia(
  media: SparingMediaLeaf,
  held: () => ReadonlySet<number>,
): SparingMediaLeaf {
  return {
    deleteByTracks: (trackIds, opts?) => {
      const spare = new Set(held())
      for (const id of opts?.spare ?? []) spare.add(id)
      return media.deleteByTracks(trackIds, { spare })
    },
    // Fusion never spares media the way disposal deletion does (no `held()`
    // set is threaded through) — passed straight through to the real store.
    // That is safe, NOT because a fusion's absorbed/survivor track can't be
    // this entry's source track (fusion can drop the SURVIVOR's own
    // single-instance rows too, review L1), but because the media an entry
    // holds belongs to a CLOSED track, and a fusion only ever touches
    // rows that are not closed — Task 18's fusion service reads
    // `TrackStore.rowState` first and refuses a fusion naming a closed (or
    // closing) row on either side.
    reassignTrack: (req) => media.reassignTrack(req),
  }
}

/**
 * The media rows among `held` (what live entries vouch for) that `trackIds`
 * own — i.e. what a cascade of those tracks will SPARE (review R6). An
 * operator who deletes a track and finds a row left behind is told why, and
 * which row. Read per held id: the set is one key frame per live entry.
 */
export async function entryHeldMediaOf(
  trackIds: readonly string[],
  held: ReadonlySet<number>,
  ownerOf: (
    mediaId: number,
  ) => Promise<{ readonly ownerKind: string; readonly ownerId: string } | null>,
): Promise<readonly number[]> {
  const deleted = new Set(trackIds)
  const spared: number[] = []
  for (const mediaId of held) {
    const owner = await ownerOf(mediaId)
    if (owner?.ownerKind === 'track' && deleted.has(owner.ownerId)) spared.push(mediaId)
  }
  return spared
}

export interface StationaryTrackDisposalDeps {
  readonly deviceId: number
  readonly entryId: string
  /** Every cascade leaf EXCEPT the media store AND the alias leg, in the
   *  shipped order. */
  readonly leaves: readonly TrackScopedStore[]
  readonly media: SparingMediaLeaf
  /** D683 (review H2): the alias leg, kept separate (like `media`) so it can
   *  be re-appended LAST — every other leaf must see the widened id set
   *  before the alias rows themselves go. Absent ⇒ no alias collection
   *  bound. */
  readonly aliasLeg?: TrackScopedStore | null
  /**
   * D683 (review H2, re-shaped by review L-R2): widens every leaf's
   * `trackIds` to include the rows a late fusion left under an absorbed id
   * of one of `plan.trackIds` — GROUPED by which of `plan.trackIds` each
   * widened id belongs to, same shape `runTrackCascadeBatch` itself wants
   * (review N6). The two tracks a promotion disposes of can be DIFFERENT
   * subjects (`sameChainAsLive: false`), so sharing one flat union between
   * them would be N6's cross-track leak in miniature — the first track's
   * leaves deleting the second track's own straggler rows.
   */
  readonly expandLeafIdsGrouped?: (
    ids: readonly string[],
  ) => Promise<ReadonlyMap<string, readonly string[]>>
  readonly trackStore: TrackRootStore & { dropActive(trackId: string): void }
  /** Live per-track state teardown, per successfully cascaded track. */
  readonly onTrackCleanup: (deviceId: number, trackId: string) => void
  readonly logger: IScopedLogger
}

export interface StationaryTrackDisposalResult {
  readonly deleted: number
  readonly failed: readonly string[]
}

/**
 * Run the plan. Every listed track is dropped from RAM FIRST so none can be
 * persisted by a sweep racing this call (a still-active source included — it
 * would otherwise land later as an empty row); the cascade then removes what
 * every track owned, sparing the entry's key frame, and deletes the row (a
 * no-op for a never-persisted track).
 *
 * Never silent: the line names the entity, what went and what was kept — a
 * deleted track is dropped work, and the operator asked for it by name.
 */
export async function disposeStationaryTracks(
  deps: StationaryTrackDisposalDeps,
  plan: StationaryTrackDisposalPlan,
): Promise<StationaryTrackDisposalResult> {
  for (const trackId of plan.trackIds) deps.trackStore.dropActive(trackId)
  const sparingMedia: TrackScopedStore = {
    deleteByTracks: (trackIds) => deps.media.deleteByTracks(trackIds, { spare: plan.keepMediaIds }),
  }
  const result = await runTrackCascadeBatch(
    {
      // The alias leg stays LAST (D683 review H2): every other leaf runs
      // against the widened id set before the alias rows themselves go.
      registry: [...deps.leaves, sparingMedia, ...(deps.aliasLeg ? [deps.aliasLeg] : [])],
      trackStore: deps.trackStore,
      deviceId: deps.deviceId,
      onTrackCleanup: deps.onTrackCleanup,
      // D683 review L-R2: passed straight through, no flat-to-grouped
      // adapter — the two tracks this disposal cascades can be different
      // subjects, so each gets only ITS OWN widened aliases, same as any
      // other `runTrackCascadeBatch` caller (N6).
      ...(deps.expandLeafIdsGrouped !== undefined
        ? { expandLeafIdsGrouped: deps.expandLeafIdsGrouped }
        : {}),
      // D683 review L-R3: the one BATCH-level line when the grouped alias
      // lookup itself throws, ahead of the per-track `onFailure` lines below.
      onExpandBatchFailure: (failedIds, err) => {
        deps.logger.warn(
          'stationary promotion: alias lookup failed for the whole batch — nothing in it was widened',
          {
            tags: { deviceId: deps.deviceId },
            meta: {
              deviceId: deps.deviceId,
              entryId: deps.entryId,
              failedCount: failedIds.length,
              error: String(err),
            },
          },
        )
      },
      onFailure: (trackId, err) => {
        deps.logger.warn('stationary promotion: a source track could not be disposed of', {
          tags: { deviceId: deps.deviceId },
          meta: { deviceId: deps.deviceId, entryId: deps.entryId, trackId, error: String(err) },
        })
      },
    },
    plan.trackIds,
  )
  deps.logger.info(
    'stationary promotion: source tracks discarded — the entity keeps its key frame',
    {
      tags: { deviceId: deps.deviceId },
      meta: {
        deviceId: deps.deviceId,
        entryId: deps.entryId,
        trackIds: plan.trackIds,
        keptMediaIds: [...plan.keepMediaIds],
        deleted: result.deleted,
        failed: result.failed,
        mediaRows: result.tally.media,
      },
    },
  )
  return { deleted: result.deleted, failed: result.failed }
}
