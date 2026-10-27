/**
 * track-flags — the body of the `setTrackFlags` cap method.
 *
 * Extracted from the addon class for the same reason `rankKeyEvents` and
 * `sweepTrackRetention` are: the interesting parts (partial-patch merge,
 * unknown-track rejection, the pin budget) are decidable from the store contract
 * alone, and a test that has to boot the addon to reach them would not be
 * written.
 *
 * `markForTrain` is the wire face of the retrain LIFECYCLE
 * (`none → staging → trained`, D81), and only `staging` pins the track against
 * retention. `debug` does not pin at all — it is attention, not durability. The
 * asymmetry is the whole reason the budget below exists on one flag and not the
 * other, and the lifecycle is why this body refuses two writes the old boolean
 * form had no way to refuse.
 */

import type { IScopedLogger, RetrainStatus, TrackFlags, TrackFlagsPatch } from '@camstack/types'
import { archiveNoteBeforeClear, type DebugNoteArchivePort } from './archive-debug-note.js'

/**
 * How many tracks ONE camera may hold in `staging`.
 *
 * Staging is unbounded in TIME by construction — the marked track never ages
 * out — so it has to be bounded in COUNT or the answer to "how much disk can
 * operator curation consume" is "all of it" (D59 asked for exactly this bound;
 * D81 sets it). The per-track cost is dominated by the native `keyFrame`: a 4K
 * JPEG at ~1.5–3 MB against ~30–150 KB for the thumbnail, first/last frames,
 * periodic snapshots and per-event crops together, so the ceiling is roughly
 * **1–1.5 GB per camera**.
 *
 * `trained` tracks do not count against it: they are evictable again, because
 * the retrain page copied the frames it wanted into the dataset. The budget is
 * about material still being held FOR the operator, not material they have
 * already used.
 *
 * PER DEVICE, not fleet-wide, so one busy camera's curation cannot consume the
 * budget of a camera nobody has looked at yet. Deliberately generous: this is a
 * guard rail against a stuck script or a mis-wired UI, not a curation policy.
 * Hand-marking 500 tracks on one camera is not something an operator does by
 * accident, and if they do it on purpose the refusal tells them the number.
 */
export const MAX_STAGING_TRACKS_PER_DEVICE = 500

/**
 * Resolved operator state, as the store reports it (absent already collapsed).
 *
 * The LIFECYCLE STATUS, not the derived boolean: this body has to tell `trained`
 * from `none`, and both report `markForTrain: false`.
 */
export interface ResolvedTrackFlags {
  readonly retrainStatus: RetrainStatus
  readonly debug: boolean
  readonly favourited: boolean
  /** The operator's note about what to check. `''` when there is none — the
   *  store resolves the absence, exactly as it does for the booleans. */
  readonly debugNote: string
  /**
   * The track's own context, as the row it was read from already carried it —
   * `firstSeen`, the detector class, the display label.
   *
   * OPTIONAL and read-only: these are not flags and nothing here writes them.
   * They exist so the note ARCHIVE (D405) can keep enough to identify what the
   * operator was looking at once the track is gone, WITHOUT a second read —
   * `readFlags` already has the row in its hand. A row that never knew one of
   * them omits it, and the archive stores `null`; nothing may render an
   * absence as a value.
   */
  readonly startedAt?: number
  readonly className?: string
  readonly label?: string
}

/** Arguments to the store's staging-track count. */
export interface StagingCountQuery {
  readonly deviceId: number
}

/** The `TrackStore` surface this needs — nothing more. */
export interface TrackFlagsStore {
  /** Current state, or `null` when neither the active map nor the table has it. */
  readonly readFlags: (trackId: string) => Promise<ResolvedTrackFlags | null>
  readonly setFlags: (trackId: string, patch: TrackFlagsPatch) => Promise<void>
  /** Tracks currently in `staging` on this device — the budget's input. */
  readonly countStaging: (query: StagingCountQuery) => Promise<number>
}

export interface ApplyTrackFlagsInput {
  readonly deviceId: number
  readonly trackId: string
  readonly flags: TrackFlagsPatch
}

export interface ApplyTrackFlagsDeps {
  readonly store: TrackFlagsStore
  readonly logger: IScopedLogger
  /**
   * Where a note goes when the review clears it (D405). OPTIONAL: a runner
   * without an archive must still be able to write flags — the button the
   * operator pressed can never depend on this addon's own bookkeeping.
   */
  readonly noteArchive?: DebugNoteArchivePort
}

/** Thrown when the device is already holding its full staging budget. Distinct
 *  type so a surface can tell "you are out of room" from "that track is gone". */
export class StagingBudgetExceededError extends Error {
  constructor(
    readonly deviceId: number,
    readonly staging: number,
  ) {
    super(
      `setTrackFlags: device ${deviceId} already has ${staging} tracks in retrain staging (limit ${MAX_STAGING_TRACKS_PER_DEVICE}). Un-mark some tracks before marking more.`,
    )
    this.name = 'StagingBudgetExceededError'
  }
}

/**
 * Thrown when a `markForTrain` write — in EITHER direction — targets a track
 * that has already been trained.
 *
 * Its own error type, next to the budget's, because the two refusals need
 * different sentences on the surface: one says "make room", the other says "this
 * track is already in the dataset". Collapsing them into a generic failure is
 * how a toggle ends up flipping back with nothing to explain it.
 */
export class TrackAlreadyTrainedError extends Error {
  constructor(readonly trackId: string) {
    super(
      `setTrackFlags: track ${trackId} is already trained — its frames are copies in the retrain dataset. Re-staging it is an action of the retrain page, not this toggle.`,
    )
    this.name = 'TrackAlreadyTrainedError'
  }
}

/** Why the retrain lifecycle refused a mark, in the words a caller can branch on. */
export type RetrainRefusalReason = 'trained' | 'budget' | 'unknown-track'

/**
 * Classify a failed `setTrackFlags` as one of the lifecycle's DELIBERATE
 * refusals, or `null` when it is a failure of the call itself.
 *
 * Needed because the caller that matters (a notification button) reaches the
 * method over `ctx.api`, where the error class does not survive the hop and
 * only the message does. The class check comes first; the message check is the
 * transported form, and `track-flags.spec.ts` pins it against the real
 * messages so a reworded refusal cannot silently turn into a generic failure.
 */
export function retrainRefusalReason(err: unknown): RetrainRefusalReason | null {
  if (err instanceof TrackAlreadyTrainedError) return 'trained'
  if (err instanceof StagingBudgetExceededError) return 'budget'
  const message = err instanceof Error ? err.message : ''
  if (message.includes('is already trained')) return 'trained'
  if (message.includes('in retrain staging')) return 'budget'
  if (message.includes('unknown track')) return 'unknown-track'
  return null
}

/**
 * The `debugNote` half of the patch — `{}` when nothing should be written.
 *
 * The note is not an independent column: it is the operator's sentence about
 * why `debug` is on, so it exists exactly as long as the flag does. Three
 * cases, and the order matters:
 *
 *  1. **`debug: false` in the patch → the note is CLEARED**, whatever the
 *     caller sent with it. A note surviving the flag is a leftover that reads
 *     as a live request, and the invariant belongs here rather than in the
 *     three surfaces that write this patch — one of which is a browser grid
 *     that has no note UI at all and would never think to clear it. Since
 *     D405 the clear is not a DELETE: `applyTrackFlags` ARCHIVES the note
 *     first, into a table that outlives the track. The invariant above is
 *     unchanged — only where the words go.
 *  2. **No note in the patch → nothing is written.** This is what makes a
 *     cancelled prompt free: the app turns debug on, the operator declines to
 *     type, and the flag still lands. Refusing to write a note must never cost
 *     the capture that was asked for.
 *  3. **A note, on a track whose debug is off and is not being turned on →
 *     DROPPED.** Storing it would put the operator's words somewhere no reader
 *     of a debug set will ever look. Dropped work is logged, per-camera: a
 *     branch that silently discards a sentence is indistinguishable from one
 *     that stored it.
 *
 * `''` is a WRITE, not an absence — clearing a note the operator no longer
 * stands behind is a real edit.
 */
function resolveNotePatch(
  deps: ApplyTrackFlagsDeps,
  input: ApplyTrackFlagsInput,
  current: ResolvedTrackFlags,
): { debugNote?: string } {
  if (input.flags.debug === false) return { debugNote: '' }
  if (input.flags.debugNote === undefined) return {}
  const debugWillBeOn = input.flags.debug === true || current.debug
  if (!debugWillBeOn) {
    deps.logger.warn('setTrackFlags dropped a debug note — the track is not flagged for debug', {
      tags: { deviceId: input.deviceId },
      meta: {
        deviceId: input.deviceId,
        trackId: input.trackId,
        noteLength: input.flags.debugNote.length,
      },
    })
    return {}
  }
  return { debugNote: input.flags.debugNote }
}

/**
 * Apply a partial flag patch and report the RESOLVED state of both flags.
 *
 * Existence is checked BEFORE the write: a patch against a track that no longer
 * exists (evicted between the operator opening the card and pressing the toggle)
 * would otherwise be a write that lands nowhere and a response that claims it
 * succeeded — the toggle would flip and revert on the next refetch with nothing
 * to explain it. Throwing gives the surface something to show.
 *
 * An empty patch is a pure read, not an error: the three calling surfaces build
 * the patch from their own toggle, and "nothing changed" is a legitimate outcome
 * that must not surface as a failure.
 *
 * **`trained` is TERMINAL for this toggle, in both directions.** A trained
 * track's chosen frames are already copies inside the retrain dataset; staging
 * it again from a generic checkbox is how the same material gets annotated twice
 * under two different ground truths, and un-marking it would claim to undo a
 * training pass it cannot undo. The deliberate return to staging belongs to the
 * retrain page, which is also the only thing that produces `trained`. A `debug`
 * patch on a trained track is untouched by this — `debug` is not the lifecycle.
 *
 * **The budget is checked only when STAGING is being entered.** Un-marking is
 * always allowed and so is a `debug` patch — a limit that blocked the way OUT of
 * the limit would be a trap, and a device at its ceiling would become unable to
 * release the very storage the ceiling exists to protect. Re-marking a track
 * that is already staging is not a new hold either, so it does not consume
 * budget and cannot be refused by it.
 */
export async function applyTrackFlags(
  deps: ApplyTrackFlagsDeps,
  input: ApplyTrackFlagsInput,
): Promise<TrackFlags> {
  const { store, logger } = deps
  const current = await store.readFlags(input.trackId)
  if (current === null) {
    throw new Error(`setTrackFlags: unknown track ${input.trackId}`)
  }
  if (input.flags.markForTrain !== undefined && current.retrainStatus === 'trained') {
    // A refused lifecycle move is work dropped at the operator's request; it
    // never reaches the store, so without this line the only evidence is an
    // error string in one browser.
    logger.warn('setTrackFlags refused — track already trained', {
      tags: { deviceId: input.deviceId },
      meta: {
        deviceId: input.deviceId,
        trackId: input.trackId,
        requested: input.flags.markForTrain,
      },
    })
    throw new TrackAlreadyTrainedError(input.trackId)
  }
  const entersStaging = input.flags.markForTrain === true && current.retrainStatus !== 'staging'
  if (entersStaging) {
    const staging = await store.countStaging({ deviceId: input.deviceId })
    if (staging >= MAX_STAGING_TRACKS_PER_DEVICE) {
      logger.warn('setTrackFlags refused — device staging budget full', {
        tags: { deviceId: input.deviceId },
        meta: {
          deviceId: input.deviceId,
          trackId: input.trackId,
          staging,
          limit: MAX_STAGING_TRACKS_PER_DEVICE,
        },
      })
      throw new StagingBudgetExceededError(input.deviceId, staging)
    }
  }
  const patch: TrackFlagsPatch = {
    ...(input.flags.markForTrain !== undefined ? { markForTrain: input.flags.markForTrain } : {}),
    ...(input.flags.debug !== undefined ? { debug: input.flags.debug } : {}),
    ...(input.flags.favourited !== undefined ? { favourited: input.flags.favourited } : {}),
    ...resolveNotePatch(deps, input, current),
  }
  // The note is ARCHIVED before the statement that clears it, never after: a
  // crash between the two must cost a duplicate archive row (idempotent, per
  // `(track, note)`), not the operator's words. The archiver never throws and
  // never blocks — see `archiveNoteBeforeClear` for which way this fails.
  if (patch.debugNote === '' && current.debugNote !== '') {
    await archiveNoteBeforeClear({
      deviceId: input.deviceId,
      trackId: input.trackId,
      logger,
      archive: deps.noteArchive,
      current,
    })
  }
  if (Object.keys(patch).length > 0) await store.setFlags(input.trackId, patch)
  // The status the write LANDS on, mirroring `TrackStore.setFlags`'s mapping —
  // the only two moves this surface can make.
  const retrainStatus: RetrainStatus =
    patch.markForTrain === undefined
      ? current.retrainStatus
      : patch.markForTrain
        ? 'staging'
        : 'none'
  return {
    trackId: input.trackId,
    markForTrain: retrainStatus === 'staging',
    debug: patch.debug ?? current.debug,
    debugNote: patch.debugNote ?? current.debugNote,
    favourited: patch.favourited ?? current.favourited,
    retrainStatus,
  }
}
