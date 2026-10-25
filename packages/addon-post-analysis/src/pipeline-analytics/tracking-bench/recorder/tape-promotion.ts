/**
 * Promote a tracking-tape window (decision 11, spec §3.3).
 *
 * Budgets REFUSE, never evict: a promotion is the operator's labelling
 * material, and silently dropping an older one to make room would destroy
 * work in progress. The refusal names the budget it hit.
 *
 * **Durability (Task 12).** A promotion touches three stores — the promoted
 * file, the index row and the `benchPinned` flag on each named track — and no
 * write spans them. File → row (`pinsSettled: false`) → pins, in that order;
 * `tape-pin-ledger.ts` owns the row/pin invariant and its reconcile, which
 * runs before every promotion.
 *
 *  - A throw writing the file removes it. A throw from the index insert asks
 *    the index whether the row landed anyway (a timeout after commit, fix
 *    round L1): landed → the file is kept and the pins follow; absent → the
 *    file is removed; unknowable → the file is kept, because a row without
 *    its file is a listed promotion with no tape, and an orphan file is only
 *    bytes. A crash between file and row can leave an orphan FILE, never an
 *    orphan pin.
 *
 * Callers serialise tape operations through `TapeOperationQueue`: the budget
 * check and the "still named elsewhere" set are read-then-write. The queue's
 * `AbortSignal` is checked before every write — the rotation, the file, the
 * row, the pins (fix round 2, N1) — so a promotion abandoned at its deadline
 * leaves nothing behind but, at worst, the file it was writing, which it
 * removes before stopping.
 */
import { errMsg } from '@camstack/types'
import type {
  TrackingTapeIndexStore,
  TrackingTapeRow,
} from '../../store/tracking-tape-index-store.js'
import { encodeTapeGzipAsync } from '../tape-codec.js'
import type { TapeLighting } from '../tape-schema.js'
import { cutWindow } from './cut-window.js'
import {
  heldByUnreleased,
  reconcileTapePins,
  settleRow,
  type TapeDeleteDeps,
} from './tape-pin-ledger.js'
import { readWindowSegments, type TapeWindowReadDeps } from './tape-window-read.js'

export const MAX_PROMOTED_TAPES = 60
const MAX_PROMOTED_BYTES = 1024 ** 3
const MAX_BENCH_PINNED_TRACKS = 3_000
export const MAX_WINDOW_MS = 30 * 60_000
export const SCENARIO_SLUG = /^[a-z0-9][a-z0-9-]{2,63}$/

/** Everything a promotion needs: the pin ledger's deps (delete included, so
 *  one object serves every operation on a recording node), the shelf, and
 *  the recorder's rotation. */
export interface TapePromotionDeps extends TapeDeleteDeps, TapeWindowReadDeps {
  readonly index: Pick<
    TrackingTapeIndexStore,
    'insert' | 'get' | 'list' | 'setReleased' | 'setPinsSettled' | 'remove'
  >
  /**
   * Close the camera's open segment IF it holds time at or before `toMs`, so
   * the window's tail is on disk. A window wholly before the open segment
   * rotates nothing (fix round, H1).
   */
  readonly rotate: (deviceId: number, toMs: number) => Promise<void>
  readonly writeFile: (file: string, bytes: Buffer) => Promise<void>
  readonly mintTapeId: () => string
  /**
   * The running recorder's session, or null when none runs. With no segment
   * after the window, it says whether the recorder that wrote the window's
   * last segment is still the one running (fix round 2, N2).
   */
  readonly currentSession: () => string | null
}

export interface PromoteInput {
  readonly deviceId: number
  readonly fromMs: number
  readonly toMs: number
  readonly scenario: string
  readonly note?: string | undefined
  readonly lighting?: TapeLighting | undefined
}

export type PromoteRefusal =
  | 'window-too-long'
  | 'window-in-future'
  | 'window-not-recorded'
  | 'invalid-scenario'
  | 'promotion-budget'
  | 'empty-window'
  | 'shelf-unreadable'

export interface PromoteOk {
  readonly ok: true
  readonly tapeId: string
  readonly state: 'complete' | 'incomplete'
  readonly frames: number
  readonly gaps: number
  readonly pinnedTracks: number
  readonly bytes: number
}

export interface PromoteRefused {
  readonly ok: false
  readonly reason: PromoteRefusal
  readonly detail: string
}

export type PromoteResult = PromoteOk | PromoteRefused

/** Whether an insert that threw left its row behind. */
type RowLanded = 'landed' | 'absent' | 'unknown'

function refuse(reason: PromoteRefusal, detail: string): PromoteRefused {
  return { ok: false, reason, detail }
}

function budgetRefusal(
  rows: readonly TrackingTapeRow[],
  bytes: number,
  liveTrackIds: readonly string[],
): PromoteRefused | null {
  if (rows.length >= MAX_PROMOTED_TAPES) {
    return refuse(
      'promotion-budget',
      `${String(rows.length)} promoted tapes held (max ${String(MAX_PROMOTED_TAPES)})`,
    )
  }
  const heldBytes = rows.reduce((sum, r) => sum + r.bytes, 0)
  if (heldBytes + bytes > MAX_PROMOTED_BYTES) {
    return refuse('promotion-budget', `${String(heldBytes)} promoted bytes held (max 1 GiB)`)
  }
  const pinned = heldByUnreleased(rows)
  for (const id of liveTrackIds) pinned.add(id)
  if (pinned.size > MAX_BENCH_PINNED_TRACKS) {
    return refuse(
      'promotion-budget',
      `${String(pinned.size)} tracks would be pinned (max ${String(MAX_BENCH_PINNED_TRACKS)})`,
    )
  }
  return null
}

async function removeQuietly(
  deps: TapePromotionDeps,
  file: string,
  row: TrackingTapeRow,
): Promise<void> {
  await deps.removeFile(file).catch((rmErr: unknown) => {
    deps.logger.warn('tracking tape promotion rollback could not remove the file', {
      tags: { deviceId: row.deviceId },
      meta: { tapeId: row.id, file, error: errMsg(rmErr) },
    })
  })
}

async function rowLanded(deps: TapePromotionDeps, row: TrackingTapeRow): Promise<RowLanded> {
  try {
    return (await deps.index.get(row.id)) === null ? 'absent' : 'landed'
  } catch (err) {
    deps.logger.warn('tracking tape promotion could not tell whether its row landed', {
      tags: { deviceId: row.deviceId },
      meta: { tapeId: row.id, error: errMsg(err) },
    })
    return 'unknown'
  }
}

/** Write the file, then the (unsettled) row. See the file header for what a
 *  throw from either leaves behind. */
async function persistPromotion(
  deps: TapePromotionDeps,
  file: string,
  bytes: Buffer,
  row: TrackingTapeRow,
  signal: AbortSignal | undefined,
): Promise<void> {
  signal?.throwIfAborted()
  try {
    await deps.writeFile(file, bytes)
  } catch (err) {
    deps.logger.warn('tracking tape promotion could not write its file — removed', {
      tags: { deviceId: row.deviceId },
      meta: { tapeId: row.id, error: errMsg(err) },
    })
    await removeQuietly(deps, file, row)
    throw err
  }
  if (signal?.aborted === true) {
    // Abandoned while the file was being written: undo this op's own write
    // and stop — no row, no pin (N1).
    await removeQuietly(deps, file, row)
    signal.throwIfAborted()
  }
  try {
    await deps.index.insert(row)
  } catch (err) {
    const landed = await rowLanded(deps, row)
    deps.logger.warn('tracking tape promotion index write reported a failure', {
      tags: { deviceId: row.deviceId },
      meta: { tapeId: row.id, rowLanded: landed, error: errMsg(err) },
    })
    if (landed === 'landed') return
    if (landed === 'absent') await removeQuietly(deps, file, row)
    throw err
  }
}

export async function promoteTapeWindow(
  deps: TapePromotionDeps,
  input: PromoteInput,
  signal?: AbortSignal,
): Promise<PromoteResult> {
  const { deviceId } = input
  if (!SCENARIO_SLUG.test(input.scenario)) {
    return refuse('invalid-scenario', 'a scenario is a lower-case slug: letters, digits and dashes')
  }
  if (input.toMs <= input.fromMs || input.toMs - input.fromMs > MAX_WINDOW_MS) {
    return refuse(
      'window-too-long',
      `a window is 1 ms to ${String(MAX_WINDOW_MS / 60_000)} minutes`,
    )
  }
  if (input.toMs > deps.now())
    return refuse('window-in-future', 'promote a window after it has happened')

  await reconcileTapePins(deps, signal)
  signal?.throwIfAborted()
  await deps.rotate(deviceId, input.toMs)
  const tapeId = deps.mintTapeId()
  const read = await readWindowSegments(deps, {
    deviceId,
    fromMs: input.fromMs,
    toMs: input.toMs,
  })
  if (!read.ok) {
    deps.logger.warn('tracking tape promotion refused — the shelf could not be listed', {
      tags: { deviceId },
      meta: { reason: read.reason },
    })
    return refuse('shelf-unreadable', read.reason)
  }
  const cut = await cutWindow({
    segments: read.segments,
    before: read.before,
    after: read.after,
    liveSession: deps.currentSession(),
    fromMs: input.fromMs,
    toMs: input.toMs,
    tapeId,
    ...(input.lighting !== undefined ? { lighting: input.lighting } : {}),
  })
  if (!cut.ok) {
    const span =
      cut.recordedFromMs === null || cut.recordedToMs === null
        ? 'no segment is held for this camera'
        : `segments cover ${new Date(cut.recordedFromMs).toISOString()} – ${new Date(cut.recordedToMs).toISOString()}`
    return refuse('window-not-recorded', span)
  }
  const end = cut.tape.end
  if (end === null || end.frames === 0)
    return refuse('empty-window', 'no frame was recorded in the window')

  const bytes = await encodeTapeGzipAsync(cut.tape)
  const overBudget = budgetRefusal(await deps.index.list(), bytes.byteLength, cut.liveTrackIds)
  if (overBudget !== null) {
    deps.logger.info('tracking tape promotion refused over budget', {
      tags: { deviceId },
      meta: { detail: overBudget.detail },
    })
    return overBudget
  }

  const state: PromoteOk['state'] = end.gaps > 0 ? 'incomplete' : 'complete'
  const row: TrackingTapeRow = {
    id: tapeId,
    deviceId,
    scenario: input.scenario,
    note: input.note ?? null,
    lighting: cut.tape.header.lighting,
    fromMs: input.fromMs,
    toMs: input.toMs,
    state,
    frames: end.frames,
    skips: end.skips,
    gaps: end.gaps,
    bytes: bytes.byteLength,
    reviewed: false,
    trackIds: [...cut.liveTrackIds],
    createdAt: deps.now(),
    releasedAt: null,
    pinsSettled: false,
  }
  await persistPromotion(deps, deps.promotedFile(deviceId, tapeId), bytes, row, signal)
  const { applied: pinnedTracks } = await settleRow(deps, row, new Set(), signal)
  deps.logger.info('tracking tape promoted', {
    tags: { deviceId },
    meta: {
      tapeId,
      scenario: input.scenario,
      frames: end.frames,
      gaps: end.gaps,
      pinnedTracks,
      bytes: bytes.byteLength,
    },
  })
  return {
    ok: true,
    tapeId,
    state,
    frames: end.frames,
    gaps: end.gaps,
    pinnedTracks,
    bytes: bytes.byteLength,
  }
}
