/**
 * The bodies of `debug.tape.release`, `debug.tape.delete` and the hub-start
 * reconcile (D681, Task 12 fix round 2, N3) — lifted out of `index.ts` so what
 * they answer is tested rather than asserted.
 *
 *  - Pin deps are built from the index and the track store ALONE: a node with
 *    no shelf (recorder down, refused, artifacts elsewhere) still releases and
 *    reconciles, so a moved location never strands pinned tracks (M2).
 *  - Delete also needs the shelf — the promoted file lives there — and
 *    without it names why.
 *  - An operation that cannot run answers `unavailable` with that reason. It
 *    is never folded into `already-released` / `not-found`, which are answers
 *    about a tape, not about the node (D393).
 */
import type { IScopedLogger } from '@camstack/types'
import type { TrackingTapeIndexStore } from '../../store/tracking-tape-index-store.js'
import type { TapeOperationQueue } from './tape-operation-queue.js'
import {
  type DeleteResult,
  deleteTape,
  type ReconcileReport,
  type ReleaseResult,
  reconcileTapePins,
  releaseTape,
  type TapeDeleteDeps,
  type TapeOperationUnavailable,
  type TapePinDeps,
} from './tape-pin-ledger.js'

/** What `index.ts` holds; any of the stores may not exist yet. */
export interface TapeDepsSources {
  readonly index: Pick<
    TrackingTapeIndexStore,
    'get' | 'list' | 'setReleased' | 'setPinsSettled' | 'remove'
  > | null
  readonly trackStore: { readonly setBenchPinned: TapePinDeps['pin'] } | null
  readonly shelf: { readonly promotedFile: TapeDeleteDeps['promotedFile'] } | null
  /** Why the shelf is absent: the node's refusal, or a recorder not started. */
  readonly shelfAbsence: () => string
  readonly removeFile: (file: string) => Promise<void>
  readonly logger: IScopedLogger
  readonly now: () => number
}

const TRACK_STORE_NOT_READY = 'the track store is not ready'

export function buildTapePinDeps(src: TapeDepsSources): TapePinDeps | string {
  const { index, trackStore } = src
  if (index === null || trackStore === null) return TRACK_STORE_NOT_READY
  return {
    index,
    pin: (deviceId, trackIds, pinned) => trackStore.setBenchPinned(deviceId, trackIds, pinned),
    logger: src.logger,
    now: src.now,
  }
}

export function buildTapeDeleteDeps(src: TapeDepsSources): TapeDeleteDeps | string {
  const pins = buildTapePinDeps(src)
  if (typeof pins === 'string') return pins
  const { index, shelf } = src
  if (index === null || shelf === null) return src.shelfAbsence()
  return {
    ...pins,
    index,
    promotedFile: (deviceId, tapeId) => shelf.promotedFile(deviceId, tapeId),
    removeFile: src.removeFile,
  }
}

function unavailable(reason: string): TapeOperationUnavailable {
  return { status: 'unavailable', reason }
}

export async function releaseOrUnavailable(
  deps: TapePinDeps | string,
  tapeId: string,
  queue: TapeOperationQueue,
): Promise<ReleaseResult> {
  if (typeof deps === 'string') return unavailable(deps)
  return queue.run((signal) => releaseTape(deps, tapeId, signal), { name: 'release' })
}

export async function deleteOrUnavailable(
  deps: TapeDeleteDeps | string,
  tapeId: string,
  queue: TapeOperationQueue,
): Promise<DeleteResult> {
  if (typeof deps === 'string') return unavailable(deps)
  return queue.run((signal) => deleteTape(deps, tapeId, signal), { name: 'delete' })
}

export async function reconcileOrUnavailable(
  deps: TapePinDeps | string,
  queue: TapeOperationQueue,
): Promise<ReconcileReport | TapeOperationUnavailable> {
  if (typeof deps === 'string') return unavailable(deps)
  return queue.run((signal) => reconcileTapePins(deps, signal), { name: 'reconcile' })
}

/** What `debug.tape.review` needs from the index. */
export type TapeReviewDeps = Pick<TrackingTapeIndexStore, 'get' | 'setReviewed'>

export type TapeReviewResult =
  | { readonly status: 'reviewed'; readonly reviewed: boolean }
  | { readonly status: 'not-found' }

/**
 * `debug.tape.review` (fix round, L2). `update.mutate` is a silent no-op on
 * a missing primary key, so the old shape answered `{ reviewed }` — success —
 * for a write that did nothing, on an unknown or already-deleted `tapeId`.
 * `get` first, like `releaseTape` / `deleteTape` already do, and refuse
 * `not-found` rather than claim a write landed that did not.
 */
export async function reviewOrNotFound(
  deps: TapeReviewDeps,
  tapeId: string,
  reviewed: boolean,
): Promise<TapeReviewResult> {
  const row = await deps.get(tapeId)
  if (row === null) return { status: 'not-found' }
  await deps.setReviewed(tapeId, reviewed)
  return { status: 'reviewed', reviewed }
}
