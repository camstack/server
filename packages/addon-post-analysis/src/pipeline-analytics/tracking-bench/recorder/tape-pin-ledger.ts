/**
 * The pins a promoted tape holds, kept in step with its index row (D681,
 * Task 12): settle, reconcile, release, delete.
 *
 * The index row and the `benchPinned` flags live in two tables, and no write
 * spans them. The invariant kept instead: every `benchPinned` flag is named by
 * an index row, and every row's pins are either settled or owed.
 *
 *  - A row is written `pinsSettled: false` and flipped only when every pin it
 *    implies has landed; a release flips it back in the same write that
 *    stamps `releasedAt`, then unpins.
 *  - {@link reconcileTapePins} re-applies what EVERY row implies, settled or
 *    not — re-pins an unreleased one, unpins a released one's exclusive
 *    tracks — and settles the owed ones. Settled rows are included because a
 *    write the queue abandoned at its deadline can land after the next
 *    operation (fix round 2, N1, probe P5): a late unpin over a live
 *    promotion's tracks leaves no row unsettled, and retention would delete
 *    labelled tracks. Pins are idempotent, so re-applying is harmless; the
 *    cost is bounded by the budget (60 rows, 3 000 pinned tracks) and paid
 *    once per operator action, never on a schedule (D447).
 *  - Every write phase checks the operation's `AbortSignal` first, so an
 *    operation abandoned at its deadline writes nothing more.
 *  - A row is deleted only once settled, so a pin never outlives its row.
 *
 * Nothing here needs the recorder or the shelf except `deleteTape`, which
 * removes the promoted file (fix round, M2): an operator can release a
 * promotion — and the hub reconciles — on a node whose recorder is down or
 * refused, so a moved artifacts location can never strand 3 000 pinned
 * tracks against retention.
 */
import { errMsg, type IScopedLogger } from '@camstack/types'
import type {
  TrackingTapeIndexStore,
  TrackingTapeRow,
} from '../../store/tracking-tape-index-store.js'

/** What settling, reconciling and releasing need: the index and the pins. */
export interface TapePinDeps {
  readonly index: Pick<TrackingTapeIndexStore, 'get' | 'list' | 'setReleased' | 'setPinsSettled'>
  /** Returns how many of `trackIds` were written; fewer means some failed. */
  readonly pin: (deviceId: number, trackIds: readonly string[], pinned: boolean) => Promise<number>
  readonly logger: IScopedLogger
  readonly now: () => number
}

/** Delete also removes the promoted file, which lives on the shelf. */
export interface TapeDeleteDeps extends TapePinDeps {
  readonly index: Pick<
    TrackingTapeIndexStore,
    'get' | 'list' | 'setReleased' | 'setPinsSettled' | 'remove'
  >
  readonly promotedFile: (deviceId: number, tapeId: string) => string
  readonly removeFile: (file: string) => Promise<void>
}

export interface ReconcileReport {
  /** Unsettled rows this pass finished. */
  readonly settled: number
  /** Unsettled rows still owed pins after this pass. */
  readonly unsettled: number
}

export interface TapeReleased {
  readonly status: 'released'
  readonly unpinned: number
  /** False when some unpin did not land: the row stays owed and the next
   *  tape operation retries it. */
  readonly pinsSettled: boolean
}

export interface TapeAlreadyReleased {
  readonly status: 'already-released'
}

export interface TapeNotFound {
  readonly status: 'not-found'
}

/** The node cannot answer — distinct from every answer (D393). Produced by
 *  the caller that could not build the deps, never by these functions. */
export interface TapeOperationUnavailable {
  readonly status: 'unavailable'
  readonly reason: string
}

export type ReleaseResult =
  | TapeReleased
  | TapeAlreadyReleased
  | TapeNotFound
  | TapeOperationUnavailable

export interface TapeDeleted {
  readonly status: 'deleted'
}

/** Refused: the row is the only thing naming pins not yet taken back. */
export interface TapePinsOwed {
  readonly status: 'pins-owed'
}

export type DeleteResult = TapeDeleted | TapePinsOwed | TapeNotFound | TapeOperationUnavailable

export interface SettleOutcome {
  /** Pins (or unpins) that landed. */
  readonly applied: number
  readonly settled: boolean
}

export function heldByUnreleased(rows: readonly TrackingTapeRow[], except?: string): Set<string> {
  return new Set(
    rows.filter((r) => r.releasedAt === null && r.id !== except).flatMap((r) => r.trackIds),
  )
}

/**
 * Apply the pins `row`'s state implies — all of its tracks for an unreleased
 * row, those no unreleased row in `held` names for a released one. An owed
 * row is marked settled when every one landed; a settled row whose re-apply
 * comes up short is marked owed again, so delete will not drop it. A failed
 * write never throws — the row is left owed and the next pass retries — but
 * an aborted operation does: it must write nothing more.
 */
export async function settleRow(
  deps: TapePinDeps,
  row: TrackingTapeRow,
  held: ReadonlySet<string>,
  signal?: AbortSignal,
): Promise<SettleOutcome> {
  const pinned = row.releasedAt === null
  const ids = pinned ? row.trackIds : row.trackIds.filter((id) => !held.has(id))
  signal?.throwIfAborted()
  let applied = 0
  try {
    applied = await deps.pin(row.deviceId, ids, pinned)
  } catch (err) {
    deps.logger.warn('tracking tape pins could not be written — the row stays unsettled', {
      tags: { deviceId: row.deviceId },
      meta: { tapeId: row.id, pinned, error: errMsg(err) },
    })
    return { applied: 0, settled: false }
  }
  const complete = applied === ids.length
  if (!complete) {
    deps.logger.warn('tracking tape pins short — the row stays unsettled and is retried', {
      tags: { deviceId: row.deviceId },
      meta: { tapeId: row.id, pinned, applied, expected: ids.length },
    })
  }
  if (complete === row.pinsSettled) return { applied, settled: complete }
  signal?.throwIfAborted()
  try {
    await deps.index.setPinsSettled(row.id, complete)
  } catch (err) {
    deps.logger.warn('tracking tape pins state could not be written to the row', {
      tags: { deviceId: row.deviceId },
      meta: { tapeId: row.id, pinned, settled: complete, error: errMsg(err) },
    })
    return { applied, settled: false }
  }
  return { applied, settled: complete }
}

/** Re-apply every row's pins and settle the owed ones (see the file header). */
export async function reconcileTapePins(
  deps: TapePinDeps,
  signal?: AbortSignal,
): Promise<ReconcileReport> {
  const rows = await deps.index.list()
  const held = heldByUnreleased(rows)
  let settled = 0
  let unsettled = 0
  for (const row of rows) {
    const outcome = await settleRow(deps, row, held, signal)
    if (!outcome.settled) unsettled += 1
    else if (!row.pinsSettled) {
      settled += 1
      deps.logger.info('tracking tape pins reconciled', {
        tags: { deviceId: row.deviceId },
        meta: { tapeId: row.id, released: row.releasedAt !== null, applied: outcome.applied },
      })
    }
  }
  return { settled, unsettled }
}

export async function releaseTape(
  deps: TapePinDeps,
  tapeId: string,
  signal?: AbortSignal,
): Promise<ReleaseResult> {
  await reconcileTapePins(deps, signal)
  const row = await deps.index.get(tapeId)
  if (row === null) return { status: 'not-found' }
  if (row.releasedAt !== null) return { status: 'already-released' }
  const releasedAt = deps.now()
  signal?.throwIfAborted()
  await deps.index.setReleased(tapeId, releasedAt)
  const held = heldByUnreleased(await deps.index.list(), tapeId)
  // `setReleased` unsettled the row in the same write.
  const outcome = await settleRow(deps, { ...row, releasedAt, pinsSettled: false }, held, signal)
  deps.logger.info('tracking tape released', {
    tags: { deviceId: row.deviceId },
    meta: { tapeId, unpinned: outcome.applied, pinsSettled: outcome.settled },
  })
  return { status: 'released', unpinned: outcome.applied, pinsSettled: outcome.settled }
}

export async function deleteTape(
  deps: TapeDeleteDeps,
  tapeId: string,
  signal?: AbortSignal,
): Promise<DeleteResult> {
  const row = await deps.index.get(tapeId)
  if (row === null) return { status: 'not-found' }
  if (row.releasedAt === null) await releaseTape(deps, tapeId, signal)
  else await reconcileTapePins(deps, signal)
  const current = await deps.index.get(tapeId)
  if (current === null) return { status: 'not-found' }
  if (!current.pinsSettled) {
    // The row is the only thing naming the pins still owed; dropping it now
    // would leave them pinned forever.
    deps.logger.warn('tracking tape not deleted — its unpins have not all landed', {
      tags: { deviceId: row.deviceId },
      meta: { tapeId },
    })
    return { status: 'pins-owed' }
  }
  signal?.throwIfAborted()
  await deps.removeFile(deps.promotedFile(row.deviceId, tapeId))
  signal?.throwIfAborted()
  await deps.index.remove(tapeId)
  deps.logger.info('tracking tape deleted', {
    tags: { deviceId: row.deviceId },
    meta: { tapeId, scenario: row.scenario },
  })
  return { status: 'deleted' }
}
