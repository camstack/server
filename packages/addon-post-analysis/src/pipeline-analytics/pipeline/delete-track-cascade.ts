/**
 * Whole-track deletion cascade — the track is the ROOT of the analytics data
 * model, and deletion must reach EVERY entity derived from it (directly or via
 * its events): object events, event-owned media, track-owned media, unassigned
 * face rows + crops, per-track CLIP embeddings, and finally the persisted track
 * row.
 *
 * The cascade is EXTENSIBLE: each store holding track-scoped rows implements the
 * `TrackScopedStore` contract and is added to a single registry. Adding a future
 * track-related entity = implement `TrackScopedStore` + one line in the registry
 * — no caller edits, nothing to forget.
 *
 * INVARIANTS the registered stores uphold: ENROLLED (`assigned`) faces + plates
 * are exempt, `ownerKind:'identity'`/`ownerKind:'vehicle'` media is never
 * deleted, and the durable MATCHING data (`identity-samples` embeddings +
 * `vehicle-samples` text) is never touched — so recognition always persists
 * across retention.
 */

import type { EventOwnedMediaIds } from '../store/event-store.js'
import type { TrackFusibleStore, TrackLeafStore } from './track-fusion-leaf.js'

/** The leaf families a track cascade can remove. Mirrors `TrackCascadeCounts`
 *  so a store's self-report lands on the field the operator already reads.
 *  `aliases` (D683) is the one family with no operator-facing count of its
 *  own — the alias rows are bookkeeping, not media or recognition data. */
export type TrackCascadeFamily = 'events' | 'media' | 'faces' | 'plates' | 'embeddings' | 'aliases'

/**
 * What one leaf store actually removed — the receipt the cascade had none of.
 *
 * `bytes` is on-disk bytes RELEASED, and only the media family can know it; the
 * others report 0 because they hold no blobs, which is a different statement
 * from "0 because nobody counted". Until 2026-08-15 `deleteByTracks` returned
 * `void`, so `pruneTracksBefore` filled every leaf field with a literal zero and
 * wrote `bytesReclaimed: 0` on all 3,732 ops-log rows it had ever produced. A
 * counter that can only ever be 0 reads as "there was nothing to reclaim", and
 * that is how 18.9 GB accumulated in plain sight (D161).
 */
export interface TrackCascadeLeafCount {
  readonly family: TrackCascadeFamily
  readonly rows: number
  readonly bytes: number
}

/** Any store holding rows keyed/tagged by trackId. `deleteByTracks` removes ALL
 *  ephemeral (non-enrolled) rows for the given tracks + their owned media, and
 *  REPORTS what it removed. Each implementation is best-effort + per-track
 *  ISOLATED (one bad id never aborts the batch). Enrolled/`assigned` rows and
 *  `ownerKind:'identity'` media are exempt — never deleted. A store spanning two
 *  families (the event leg folds in event-owned media) returns one entry per
 *  family rather than blurring them into a single number. */
export interface TrackScopedStore {
  deleteByTracks(trackIds: readonly string[]): Promise<readonly TrackCascadeLeafCount[]>
}

/** Rows + bytes per family, summed across every leaf store in a cascade. */
export interface TrackCascadeTally {
  readonly tracks: number
  readonly events: number
  readonly media: number
  readonly faces: number
  readonly plates: number
  readonly embeddings: number
  readonly aliases: number
  readonly bytesReclaimed: number
}

export const EMPTY_CASCADE_TALLY: TrackCascadeTally = {
  tracks: 0,
  events: 0,
  media: 0,
  faces: 0,
  plates: 0,
  embeddings: 0,
  aliases: 0,
  bytesReclaimed: 0,
}

/** Fold a leaf store's receipts into a running tally. */
function addLeafCounts(
  tally: TrackCascadeTally,
  counts: readonly TrackCascadeLeafCount[],
): TrackCascadeTally {
  let next = tally
  for (const c of counts) {
    const bytesReclaimed = next.bytesReclaimed + c.bytes
    // A switch, not a computed key: a computed key widens the object to an index
    // signature and the tally would silently stop being a tally.
    switch (c.family) {
      case 'events':
        next = { ...next, events: next.events + c.rows, bytesReclaimed }
        break
      case 'media':
        next = { ...next, media: next.media + c.rows, bytesReclaimed }
        break
      case 'faces':
        next = { ...next, faces: next.faces + c.rows, bytesReclaimed }
        break
      case 'plates':
        next = { ...next, plates: next.plates + c.rows, bytesReclaimed }
        break
      case 'embeddings':
        next = { ...next, embeddings: next.embeddings + c.rows, bytesReclaimed }
        break
      case 'aliases':
        next = { ...next, aliases: next.aliases + c.rows, bytesReclaimed }
        break
    }
  }
  return next
}

/** Sum two tallies (per-track results into a per-device one). */
export function mergeCascadeTallies(a: TrackCascadeTally, b: TrackCascadeTally): TrackCascadeTally {
  return {
    tracks: a.tracks + b.tracks,
    events: a.events + b.events,
    media: a.media + b.media,
    faces: a.faces + b.faces,
    plates: a.plates + b.plates,
    embeddings: a.embeddings + b.embeddings,
    aliases: a.aliases + b.aliases,
    bytesReclaimed: a.bytesReclaimed + b.bytesReclaimed,
  }
}

/** The ROOT track store — its persisted row is deleted LAST, after every leaf
 *  store, so a mid-cascade failure never orphans leaves under a still-present
 *  root. */
export interface TrackRootStore {
  deletePersisted(trackId: string): Promise<void>
}

/**
 * Extensible whole-track deletion cascade. Runs every registered
 * `TrackScopedStore` (each removes its ephemeral rows + owned media for the
 * tracks), THEN deletes the track ROOT rows LAST.
 *
 * ORDER MATTERS: every leaf store first, the track row last. The intended
 * production registry (leaves first, root last):
 *
 *   [ eventStore,           // object events + their event-owned media
 *     mediaStore,           // track + unassigned face/plate crops (NEVER identity/vehicle)
 *     faceStore,            // unassigned face rows (assigned/enrolled exempt)
 *     plateStore,           // unassigned plate reads (assigned/enrolled exempt)
 *     objectEmbeddingStore, // per-track CLIP search vectors
 *   ]
 */
export async function cascadeDeleteTracks(
  registry: readonly TrackScopedStore[],
  trackStore: TrackRootStore,
  trackIds: readonly string[],
  opts?: {
    /**
     * D683 (review H4): every absorbed id a fusion ever pointed at ANY of
     * `trackIds` — so a late writer that only ever heard of the absorbed id
     * is reached too, never orphaned under a row this cascade is about to
     * delete. Absent ⇒ the pre-D683 behaviour (leaves see only `trackIds`).
     */
    readonly expandLeafIds?: (ids: readonly string[]) => Promise<readonly string[]>
  },
): Promise<TrackCascadeTally> {
  const leafIds =
    opts?.expandLeafIds === undefined
      ? trackIds
      : [...new Set([...trackIds, ...(await opts.expandLeafIds(trackIds))])]
  let tally = EMPTY_CASCADE_TALLY
  for (const store of registry) {
    tally = addLeafCounts(tally, await store.deleteByTracks(leafIds))
  }
  // Root LAST — per-track so the loop mirrors the leaf best-effort contract.
  // Never the WIDENED `leafIds`: an absorbed id has no persisted row of its
  // own (D683) — its aliases entry is the leaf that owns it, deleted above.
  for (const trackId of trackIds) {
    await trackStore.deletePersisted(trackId)
    tally = { ...tally, tracks: tally.tracks + 1 }
  }
  return tally
}

/**
 * The stores the PRODUCTION cascade registry is assembled from. Narrowed to
 * `TrackScopedStore` so the builder can be exercised with the real stores in a
 * test without booting the addon — which is the point: the addon calls this
 * function, so the cascade-completeness test is checking the shipped registry
 * and not a copy of it that agrees with it today.
 */
export interface AnalyticsCascadeStores {
  readonly eventStore: TrackLeafStore
  readonly mediaStore: TrackLeafStore
  readonly faceStore?: TrackLeafStore | null
  readonly plateStore?: TrackLeafStore | null
  readonly objectEmbeddingStore?: TrackLeafStore | null
  /** D683: the alias collection. Pushed LAST — every other leaf has already
   *  run against the widened (survivor + aliases) id set by the time this
   *  leg deletes the alias rows themselves. */
  readonly aliasStore?: TrackLeafStore | null
}

/**
 * The one registry, in the one order — leaves first, root deleted internally
 * last by {@link cascadeDeleteTracks}.
 *
 * ORDER IS LOAD-BEARING in exactly one place: `eventStore` must precede
 * `mediaStore`, because the event leg folds in the deletion of event-OWNED
 * media and it needs the event rows still present to learn their ids. Every
 * other position is free.
 *
 * The optional stores are optional because they are late-bound in
 * `onInitialize`, not because their families are optional — a missing one means
 * the addon is not fully up, and the sweep does not run in that state.
 */
/**
 * The optional legs that are NOT in the registry this call would build.
 *
 * `buildAnalyticsCascadeRegistry` pushes each optional store only `if` it is
 * there, and that `if` is silent. A hub whose `vector-store` capability was
 * unavailable at boot builds an embedding-less cascade and then prunes tracks
 * with it — every pass, for the whole life of the process — while the only
 * evidence is one warn at startup that scrolled away hours earlier. Every CLIP
 * vector for every track deleted in that window becomes an orphan that nothing
 * can reach by ownership again, because its owner is gone.
 *
 * So the omission is named and returned, and the caller LOGS it. A branch that
 * drops work says so; silence reads as "there was nothing to drop".
 */
export function absentCascadeLegs(stores: AnalyticsCascadeStores): readonly string[] {
  const absent: string[] = []
  if (!stores.faceStore) absent.push('faces')
  if (!stores.plateStore) absent.push('plates')
  if (!stores.objectEmbeddingStore) absent.push('embeddings')
  if (!stores.aliasStore) absent.push('aliases')
  return absent
}

export function buildAnalyticsCascadeRegistry(
  stores: AnalyticsCascadeStores,
): readonly TrackLeafStore[] {
  const registry: TrackLeafStore[] = [stores.eventStore, stores.mediaStore]
  if (stores.faceStore) registry.push(stores.faceStore)
  if (stores.plateStore) registry.push(stores.plateStore)
  if (stores.objectEmbeddingStore) registry.push(stores.objectEmbeddingStore)
  // LAST: every other leaf has already run against the widened id set
  // (survivor + its aliases); only now do the alias rows themselves go.
  if (stores.aliasStore) registry.push(stores.aliasStore)
  return registry
}

/** The same stores, the same order, seen as fusible (D683 §6.1 invariant 4).
 *  An absent optional leg is absent here too — `absentCascadeLegs` names it,
 *  and the fusion service logs it with every fusion it could not complete. */
export function buildAnalyticsFusionRegistry(
  stores: AnalyticsCascadeStores,
): readonly TrackFusibleStore[] {
  return buildAnalyticsCascadeRegistry(stores)
}

/** The stores a legacy single-track deletion touches, narrowed to the methods
 *  the cascade needs so the helper stays testable with plain recording fakes. */
export interface TrackDeletionStores {
  readonly eventStore: { deleteByTrack(trackId: string): Promise<readonly string[]> }
  readonly mediaStore: {
    deleteForEvents(ids: EventOwnedMediaIds): Promise<number>
    deleteForTracks(ids: readonly string[]): Promise<number>
  }
  readonly trackStore: TrackRootStore
  /** D683 (review H2): the alias leg, so rows a late fusion left under an
   *  absorbed id go with this legacy single-track path too. Absent ⇒ no
   *  alias collection bound (version-skew/test callers). Pushed LAST, same
   *  rule as every other registry. */
  readonly aliasStore?: TrackScopedStore | null
}

/**
 * Full whole-track cascade for ONE track: events → their media + track media
 * → the alias leg (if bound) → track row. Delegates to the generalized
 * `cascadeDeleteTracks` so the shipped `deleteTracks` provider path flows
 * through the same engine while preserving the exact legacy call order (event
 * ids stay local to the delete). Adapts the narrow legacy store shapes onto
 * `TrackScopedStore` — a superset store (faces / embeddings) is opted in by
 * the CALLER's registry, not by this legacy shim.
 */
export async function cascadeDeleteTrack(
  stores: TrackDeletionStores,
  trackId: string,
  opts?: {
    /** D683 (review H2): see {@link cascadeDeleteTracks}'s own doc. */
    readonly expandLeafIds?: (ids: readonly string[]) => Promise<readonly string[]>
  },
): Promise<TrackCascadeTally> {
  const registry: readonly TrackScopedStore[] = [
    {
      // Events + their event-owned media (eventId set stays local to the delete).
      deleteByTracks: async (ids) => {
        let events = 0
        let media = 0
        for (const id of ids) {
          // `deleteByTrack` only ever drains OBJECT events — motion/audio
          // carry no `trackId` and are never touched here (D476).
          const eventIds = await stores.eventStore.deleteByTrack(id)
          events += eventIds.length
          if (eventIds.length > 0) {
            media += await stores.mediaStore.deleteForEvents({ object: [...eventIds] })
          }
        }
        return [
          { family: 'events', rows: events, bytes: 0 },
          { family: 'media', rows: media, bytes: 0 },
        ]
      },
    },
    {
      // The track's OWN media (crops / boxed frames).
      deleteByTracks: async (ids) => [
        { family: 'media', rows: await stores.mediaStore.deleteForTracks([...ids]), bytes: 0 },
      ],
    },
    ...(stores.aliasStore ? [stores.aliasStore] : []),
  ]
  return cascadeDeleteTracks(registry, stores.trackStore, [trackId], opts)
}

/** Injected side-effects for the widened batch runner, isolating the loop from
 *  the provider. Shared by all three §5 entry points (operator delete, time
 *  prune, clean-slate wipe). */
export interface TrackCascadeBatchDeps {
  /** The widened, extensible cascade registry (leaves first — the track root is
   *  deleted internally by `cascadeDeleteTracks`). */
  readonly registry: readonly TrackScopedStore[]
  readonly trackStore: TrackRootStore
  readonly deviceId: number
  /** Runs ONLY after a track's cascade succeeded — clears live scheduler/overlay
   *  state so a pruned track can't linger in dispatch. */
  readonly onTrackCleanup: (deviceId: number, trackId: string) => void
  /** Optional per-track failure sink (logging). */
  readonly onFailure?: (trackId: string, err: unknown) => void
  /**
   * D683 (review H4, re-shaped by review N6): ONE query for the WHOLE batch
   * — same perf win as a flat `expandLeafIds` — but GROUPED by which track
   * in the batch each alias belongs to, so one track's cascade is never
   * widened with a sibling's rows. A track absent from the returned map
   * gets no widening. A throwing call fails every id in the batch (reported
   * through `onFailure`, same as any other per-track failure) rather than
   * rejecting before the loop starts.
   */
  readonly expandLeafIdsGrouped?: (
    ids: readonly string[],
  ) => Promise<ReadonlyMap<string, readonly string[]>>
  /**
   * D683 review L-R3: fired ONCE, before the per-track `onFailure` loop,
   * when `expandLeafIdsGrouped` itself throws. Production callers log
   * `onFailure` at DEBUG per id — a persistently failing alias store then
   * fails every id in every batch (correctly fail-closed, N6), but an
   * operator watching INFO/WARN would see retention silently reclaim
   * nothing with no line explaining why. This is the one BATCH-level line.
   */
  readonly onExpandBatchFailure?: (failedIds: readonly string[], err: unknown) => void
}

/** What a batch removed: how many roots went, which ids refused, and the
 *  per-family receipt the ops log reports as `bytesReclaimed`. */
export interface TrackCascadeBatchResult {
  readonly deleted: number
  readonly failed: readonly string[]
  readonly tally: TrackCascadeTally
}

/**
 * Widened batch whole-track deletion — the ONE engine behind the three §5 entry
 * points. Runs the FULL registry cascade per track (via `cascadeDeleteTracks`
 * with a single-id list so the track root is deleted last), fires cleanup on
 * success only, and collects the ids whose cascade threw. Per-track ISOLATED —
 * one bad id never aborts the rest of the batch.
 */
export async function runTrackCascadeBatch(
  deps: TrackCascadeBatchDeps,
  trackIds: readonly string[],
): Promise<TrackCascadeBatchResult> {
  let deleted = 0
  let tally = EMPTY_CASCADE_TALLY
  const failed: string[] = []
  // D683 review L3/N6: resolved ONCE for the WHOLE batch (a drain page, a
  // disposal's ≤2 ids, an operator's named set), not once per track —
  // `cascadeDeleteTracks` otherwise pays one alias query per track in a
  // batch retention drains by the hundred. GROUPED by survivor (N6): a flat,
  // shared union let one track's leaves delete a SIBLING's absorbed-id rows
  // early, and a throwing flat call rejected before the loop ran at all —
  // no per-track `onFailure`, no `failed` list. A grouped failure instead
  // fails every id in the batch through the SAME per-track reporting path
  // every other failure uses.
  let expandedByTrack: ReadonlyMap<string, readonly string[]> | undefined
  if (deps.expandLeafIdsGrouped !== undefined) {
    try {
      expandedByTrack = await deps.expandLeafIdsGrouped(trackIds)
    } catch (err) {
      deps.onExpandBatchFailure?.(trackIds, err)
      for (const trackId of trackIds) {
        deps.onFailure?.(trackId, err)
        failed.push(trackId)
      }
      return { deleted, failed, tally }
    }
  }
  for (const trackId of trackIds) {
    try {
      const expanded = expandedByTrack?.get(trackId)
      tally = mergeCascadeTallies(
        tally,
        await cascadeDeleteTracks(deps.registry, deps.trackStore, [trackId], {
          ...(expanded !== undefined ? { expandLeafIds: () => Promise.resolve(expanded) } : {}),
        }),
      )
      deps.onTrackCleanup(deps.deviceId, trackId)
      deleted += 1
    } catch (err) {
      deps.onFailure?.(trackId, err)
      failed.push(trackId)
    }
  }
  return { deleted, failed, tally }
}
