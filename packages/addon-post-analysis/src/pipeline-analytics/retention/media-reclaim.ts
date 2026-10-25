/**
 * Bulk reclaim of DEBUG media that should never have accumulated.
 *
 * ## What this is for
 *
 * Measured on the live hub 2026-08-30: `pipeline-analytics:media` holds
 * 1 257 140 rows / 152.6 GB, of which **1 136 601 rows / 111.1 GB (73 %)** are
 * one ~95 KiB JPEG per motion off→on edge — an edge that fires at the
 * provider's ~1 Hz keepalive rate, not with the scene (see
 * `services/motion-marker-policy.ts`). Track filmstrips add another 3.4 GB.
 * Retention has never deleted one of these rows: the oldest is the 08-17
 * volume wipe, so the follow-recordings window has not yet reached anything.
 *
 * 1.14 M rows is not a loop of deletes. This is the shape that survives being
 * interrupted:
 *
 * - **Device-scoped and timestamp-cursored.** `(deviceId, timestamp)` is
 *   `idx_media_device_ts`; a fleet-wide `kind = 'snapshot'` predicate has no
 *   index and would table-scan on hub-main's single synchronous SQLite thread.
 * - **Resumable.** Each device returns `nextCursor`, and a cursor only ever
 *   advances past rows the pass has *finished with*. A pass that stops mid-way
 *   leaves rows and blobs consistent — every row it forgot, it first proved
 *   gone.
 * - **Bounded four ways**: rows examined, rows reclaimed, bytes reclaimed and
 *   wall-clock budget. The recordings volume runs at ~4 MB/s; `pace` sleeps
 *   proportionally to the bytes released so the reclaim never competes with
 *   the archive for the same spindle.
 * - **Report is the default.** `mode: 'report'` counts and answers; nothing is
 *   deleted until the operator asks for `'reclaim'`.
 *
 * ## What it refuses to do
 *
 * D148, read for this store: **confirm before forgetting**, and an I/O error
 * is not absence.
 *
 * 1. A row whose blob delete fails, or whose blob is still there afterwards,
 *    is **not forgotten**. It is counted as `refused`, the cursor does not
 *    pass it, and the device's scope ends for this run. `MediaStore.deleteConfirmed`
 *    is the only delete path used here precisely because every other one
 *    swallows the unlink error.
 * 2. A selected row whose owner is **not a motion event** is not deleted. The
 *    selection shape (`ownerKind: 'motion', kind: 'snapshot'`) is not the
 *    guarantee — nothing structurally stops another writer landing an
 *    event-owned snapshot — so the guarantee is a per-page indexed lookup
 *    against the motion-event table. It is cheap where the mistake is not.
 * 3. A track filmstrip belonging to a **pinned** track (`retrainStatus:
 *    'staging'`, `favourited`, or `benchPinned` — a promoted tracking-tape
 *    window, D681) is never deleted. The pins exist against the
 *    age sweep; a reclaim that deletes a starred track's filmstrip violates
 *    the pin's intent just as thoroughly.
 * 4. A liveness probe that THROWS ends the scope. It never reads as "nothing
 *    is live" — that inversion is what empties a table.
 */

import type { IScopedLogger } from '@camstack/types'
import type { MediaReclaimCandidate } from '../store/media-store.js'

/** `'report'` counts and answers; `'reclaim'` also deletes. */
export type MediaReclaimMode = 'report' | 'reclaim'

/**
 * Which population one pass is walking. Two, deliberately named rather than
 * expressed as a free `(ownerKind, kind)` pair: each carries its own liveness
 * guarantee, and a caller that could name an arbitrary pair could name
 * `keyFrame`.
 */
export type MediaReclaimScope =
  /** `ownerKind: 'motion', kind: 'snapshot'` — the 111 GB. Guaranteed against
   *  the motion-event table. */
  | 'motion-still'
  /** `ownerKind: 'track', kind: 'snapshot'` — the filmstrip. Guaranteed
   *  against the track pins. */
  | 'track-filmstrip'

export const MEDIA_RECLAIM_SCOPES: readonly MediaReclaimScope[] = [
  'motion-still',
  'track-filmstrip',
] as const

/** Why a device's walk stopped. `'exhausted'` is the only one that means done. */
export type MediaReclaimStop =
  | 'exhausted'
  | 'row-ceiling'
  | 'reclaim-ceiling'
  | 'byte-ceiling'
  | 'budget'
  | 'probe-failed'
  | 'delete-refused'

export interface MediaReclaimLimits {
  readonly mode: MediaReclaimMode
  /** Rows read per page. */
  readonly pageSize: number
  /** Rows examined per device per run — the pacing bound. */
  readonly maxRowsPerDevice: number
  /** Rows deleted per device per run — the blast-radius bound. */
  readonly maxReclaimPerDevice: number
  /** Bytes released per run across all devices — the disk-contention bound. */
  readonly maxBytesPerRun: number
  /** Wall-clock ceiling for the whole run. */
  readonly budgetMs: number
  /**
   * A row younger than this is never touched. The gate stops NEW debug stills
   * at the source, but a camera whose settings have not yet refreshed (TTL) can
   * still be writing; deleting a row seconds after it lands would race the
   * write that indexed it.
   */
  readonly graceMs: number
  /** Bytes per second the pass may release. The recordings volume sustains
   *  ~4 MB/s and the archive needs it more than this does. */
  readonly throttleBytesPerSec: number
}

export const DEFAULT_MEDIA_RECLAIM_LIMITS: MediaReclaimLimits = {
  mode: 'report',
  pageSize: 500,
  maxRowsPerDevice: 50_000,
  maxReclaimPerDevice: 50_000,
  maxBytesPerRun: 20 * 1024 * 1024 * 1024,
  budgetMs: 30 * 60_000,
  graceMs: 60 * 60_000,
  throttleBytesPerSec: 2 * 1024 * 1024,
}

export interface MediaReclaimDeps {
  /** One page of candidates for a device, timestamp-ascending from `afterMs`. */
  readonly page: (input: {
    readonly deviceId: number
    readonly scope: MediaReclaimScope
    readonly afterMs: number
    readonly limit: number
  }) => Promise<readonly MediaReclaimCandidate[]>
  /**
   * The SUBSET of `ownerIds` that are MOTION events. MUST throw rather than
   * answer partially — a quiet under-report here deletes media belonging to
   * something else.
   */
  readonly motionEventIds: (ids: readonly string[]) => Promise<ReadonlySet<string>>
  /**
   * The SUBSET of `trackIds` that are PINNED (`retrainStatus: 'staging'`,
   * `favourited`, or `benchPinned` — D681). Same contract, inverted consequence: a quiet under-report
   * here deletes a pin's media.
   */
  readonly pinnedTrackIds: (ids: readonly string[]) => Promise<ReadonlySet<string>>
  /**
   * Delete blob AND row, and resolve only when the blob is provably gone.
   * Throws otherwise — the throw is the refusal this pass is built around.
   * Only called in `'reclaim'` mode.
   */
  readonly reclaim: (mediaId: number) => Promise<{ rows: number; bytes: number }>
  readonly now: () => number
  readonly logger: IScopedLogger
  /** Awaited after every page — `better-sqlite3` is synchronous on hub-main's
   *  only thread, so a pass that never yields stalls live frames. */
  readonly breathe?: () => Promise<void>
  /** Awaited after each page's deletes, proportional to bytes released. */
  readonly pace?: (ms: number) => Promise<void>
}

export interface MediaReclaimDeviceReport {
  readonly deviceId: number
  readonly scope: MediaReclaimScope
  readonly examined: number
  /** Rows that passed every guarantee and would be (or were) deleted. */
  readonly eligible: number
  readonly reclaimed: number
  readonly bytesReclaimed: number
  /** Skipped because the owner is a pinned track. */
  readonly held: number
  /** Skipped because the owner could not be shown to be a motion event. */
  readonly unresolved: number
  /** Skipped because the row is younger than `graceMs`. */
  readonly withinGrace: number
  /** Deletes that refused (blob survived, or the volume could not answer). */
  readonly refused: number
  readonly stoppedBy: MediaReclaimStop
  /** Where the next run resumes for this device+scope. */
  readonly nextCursor: number
}

export interface MediaReclaimRunReport {
  readonly mode: MediaReclaimMode
  readonly devices: readonly MediaReclaimDeviceReport[]
  readonly totalExamined: number
  readonly totalEligible: number
  readonly totalReclaimed: number
  readonly totalBytesReclaimed: number
  readonly totalRefused: number
  readonly durationMs: number
  /** True when every device reported `'exhausted'` — the pass is complete. */
  readonly complete: boolean
}

interface DeviceTally {
  examined: number
  eligible: number
  reclaimed: number
  bytesReclaimed: number
  held: number
  unresolved: number
  withinGrace: number
  refused: number
}

function emptyTally(): DeviceTally {
  return {
    examined: 0,
    eligible: 0,
    reclaimed: 0,
    bytesReclaimed: 0,
    held: 0,
    unresolved: 0,
    withinGrace: 0,
    refused: 0,
  }
}

/**
 * Walk ONE device within ONE scope. Never throws: a probe failure ends the
 * device with what it has and a cursor that has not moved past anything
 * unfinished.
 */
export async function reclaimDeviceScope(input: {
  readonly deviceId: number
  readonly scope: MediaReclaimScope
  readonly cursor: number
  readonly deps: MediaReclaimDeps
  readonly limits: MediaReclaimLimits
  readonly deadlineMs: number
  readonly byteBudget: number
}): Promise<MediaReclaimDeviceReport> {
  const { deviceId, scope, deps, limits } = input
  const tally = emptyTally()
  const graceFloor = deps.now() - limits.graceMs
  let cursor = Math.max(0, input.cursor)
  let byteBudget = input.byteBudget
  let stoppedBy: MediaReclaimStop = 'exhausted'

  for (;;) {
    if (deps.now() >= input.deadlineMs) {
      stoppedBy = 'budget'
      break
    }
    if (tally.examined >= limits.maxRowsPerDevice) {
      stoppedBy = 'row-ceiling'
      break
    }
    const rows = await deps.page({ deviceId, scope, afterMs: cursor, limit: limits.pageSize })
    if (rows.length === 0) break

    const ownerIds = [...new Set(rows.map((r) => r.ownerId).filter((id) => id.length > 0))]
    let motionOwners: ReadonlySet<string> = new Set<string>()
    let pinnedOwners: ReadonlySet<string> = new Set<string>()
    try {
      if (scope === 'motion-still') {
        motionOwners = ownerIds.length > 0 ? await deps.motionEventIds(ownerIds) : new Set<string>()
      } else {
        pinnedOwners = ownerIds.length > 0 ? await deps.pinnedTrackIds(ownerIds) : new Set<string>()
      }
    } catch (err) {
      // The one thing this must never do is read a failed probe as "nothing is
      // protected". Stop, keep the cursor, say so.
      deps.logger.warn('media reclaim: ownership probe failed — device abandoned for this run', {
        tags: { deviceId },
        meta: { scope, cursor, error: String(err) },
      })
      stoppedBy = 'probe-failed'
      break
    }

    let pageBytes = 0
    let halted: MediaReclaimStop | null = null
    for (const row of rows) {
      tally.examined += 1
      // The cursor only ever moves to a row this loop has FINISHED with, and
      // it is inclusive-safe: `timestamp` is not unique, so the next page
      // re-reads the boundary row rather than skipping its ties.
      const advanceTo = row.timestamp
      if (row.timestamp > graceFloor) {
        tally.withinGrace += 1
        cursor = advanceTo
        continue
      }
      if (scope === 'motion-still' && !motionOwners.has(row.ownerId)) {
        tally.unresolved += 1
        cursor = advanceTo
        continue
      }
      if (scope === 'track-filmstrip' && pinnedOwners.has(row.ownerId)) {
        tally.held += 1
        cursor = advanceTo
        continue
      }
      tally.eligible += 1
      if (limits.mode === 'report') {
        cursor = advanceTo
        continue
      }
      if (tally.reclaimed >= limits.maxReclaimPerDevice) {
        halted = 'reclaim-ceiling'
        break
      }
      if (byteBudget <= 0) {
        halted = 'byte-ceiling'
        break
      }
      try {
        const gone = await deps.reclaim(row.mediaId)
        tally.reclaimed += gone.rows
        tally.bytesReclaimed += gone.bytes
        byteBudget -= gone.bytes
        pageBytes += gone.bytes
        cursor = advanceTo
      } catch (err) {
        // Refused, not forgotten. The row is still there, its blob may still
        // be there, and the cursor has NOT passed it.
        tally.refused += 1
        deps.logger.warn('media reclaim: delete refused — row kept', {
          tags: { deviceId },
          meta: { scope, mediaId: row.mediaId, error: String(err) },
        })
        halted = 'delete-refused'
        break
      }
    }

    if (halted !== null) {
      stoppedBy = halted
      break
    }
    if (limits.throttleBytesPerSec > 0 && pageBytes > 0 && deps.pace) {
      await deps.pace((pageBytes / limits.throttleBytesPerSec) * 1000)
    }
    if (deps.breathe) await deps.breathe()
    if (rows.length < limits.pageSize) break
  }

  return {
    deviceId,
    scope,
    examined: tally.examined,
    eligible: tally.eligible,
    reclaimed: tally.reclaimed,
    bytesReclaimed: tally.bytesReclaimed,
    held: tally.held,
    unresolved: tally.unresolved,
    withinGrace: tally.withinGrace,
    refused: tally.refused,
    stoppedBy,
    nextCursor: cursor,
  }
}

/** Cursor key for one `(device, scope)` pair. */
function mediaReclaimCursorKey(deviceId: number, scope: MediaReclaimScope): string {
  return `${scope}:${deviceId}`
}

/**
 * Walk every `(device, scope)` pair under one shared byte budget and one
 * shared deadline, and log ONE summary line per device — never a line per row.
 */
export async function runMediaReclaim(input: {
  readonly deviceIds: readonly number[]
  readonly scopes: readonly MediaReclaimScope[]
  readonly deps: MediaReclaimDeps
  readonly limits: MediaReclaimLimits
  readonly cursors: ReadonlyMap<string, number>
  /** Fired after each device+scope window — the detached status surface. */
  readonly onDevice?: (report: MediaReclaimDeviceReport) => void
}): Promise<{
  readonly report: MediaReclaimRunReport
  readonly cursors: ReadonlyMap<string, number>
}> {
  const startedAt = input.deps.now()
  const deadlineMs = startedAt + input.limits.budgetMs
  const nextCursors = new Map<string, number>(input.cursors)
  const devices: MediaReclaimDeviceReport[] = []
  let byteBudget = input.limits.maxBytesPerRun

  for (const scope of input.scopes) {
    for (const deviceId of input.deviceIds) {
      if (input.deps.now() >= deadlineMs) break
      const key = mediaReclaimCursorKey(deviceId, scope)
      const report = await reclaimDeviceScope({
        deviceId,
        scope,
        cursor: input.cursors.get(key) ?? 0,
        deps: input.deps,
        limits: input.limits,
        deadlineMs,
        byteBudget,
      })
      byteBudget -= report.bytesReclaimed
      nextCursors.set(key, report.stoppedBy === 'exhausted' ? 0 : report.nextCursor)
      devices.push(report)
      input.onDevice?.(report)
      if (report.examined > 0 || report.refused > 0) {
        // One line per device per scope. At 1.14 M rows a line per row is the
        // flood the logging rules exist to prevent; a silent pass is the
        // other failure. This is the per-window summary.
        input.deps.logger.info('media reclaim window', {
          tags: { deviceId },
          meta: {
            scope,
            mode: input.limits.mode,
            examined: report.examined,
            eligible: report.eligible,
            reclaimed: report.reclaimed,
            bytesReclaimed: report.bytesReclaimed,
            held: report.held,
            unresolved: report.unresolved,
            withinGrace: report.withinGrace,
            refused: report.refused,
            stoppedBy: report.stoppedBy,
            nextCursor: report.nextCursor,
          },
        })
      }
    }
  }

  const total = (pick: (r: MediaReclaimDeviceReport) => number): number =>
    devices.reduce((acc, r) => acc + pick(r), 0)
  return {
    report: {
      mode: input.limits.mode,
      devices,
      totalExamined: total((r) => r.examined),
      totalEligible: total((r) => r.eligible),
      totalReclaimed: total((r) => r.reclaimed),
      totalBytesReclaimed: total((r) => r.bytesReclaimed),
      totalRefused: total((r) => r.refused),
      durationMs: input.deps.now() - startedAt,
      complete: devices.every((r) => r.stoppedBy === 'exhausted'),
    },
    cursors: nextCursors,
  }
}
