/**
 * Boot reconcile for exports a restart interrupted.
 *
 * `ExportEngine` holds its queue in memory and says so ("boot re-queue of
 * interrupted jobs is the provider's concern"). Nothing was that provider. A
 * restart therefore forgot every job it had not yet started, while the DURABLE
 * row went on saying `queued` — or `rendering`, behind an ffmpeg that died with
 * the process. Such a row never renders and never fails: it just sits there,
 * and a consumer polling it waits out its whole bound before reporting a
 * timeout for work that was never going to start.
 *
 * Live proof (2026-08-14): exports `76151053-…` (05:11) and `e1a4a3c2-…`
 * (05:17) for camera 1441 were still `queued` an hour after the 05:31 restart,
 * with no ffmpeg behind either, while the timelapse scheduler kept queueing
 * fresh duplicates of the same window.
 *
 * Every log line carries `tags: { deviceId }` — an export miss is asked
 * per-camera, and a line without the tag cannot answer it.
 */

import type { ExportRecord, IScopedLogger } from '@camstack/types'
import { clipExportFailure, exportSubjectOf } from '@camstack/types'
import { listExportsFor, patchExport, type RecordingExportsState } from './export-store.js'

/** The engine surface a reconcile needs — queueing, nothing else. */
export interface ExportReconcileEngine {
  enqueue(id: string): void
}

export interface ExportReconcileDeps {
  readonly state: RecordingExportsState
  readonly engine: ExportReconcileEngine
  readonly now: () => number
  readonly logger: Pick<IScopedLogger, 'info' | 'warn' | 'debug'>
}

export interface ExportReconcileReport {
  /** Rows handed back to the engine. */
  readonly requeued: number
  /** Rows whose life had already run out and were failed instead. */
  readonly expired: number
}

/**
 * States that can only mean "a render was owed and the process went away".
 *
 * There is no live render at reconcile time by construction: the engine is
 * built fresh with an empty queue, and this runs before anything is enqueued.
 */
function isInterrupted(record: ExportRecord): boolean {
  return record.state === 'queued' || record.state === 'rendering'
}

/**
 * Did this row carry an operator's authorised WAKE?
 *
 * A re-queue is the third of the three ways D558 § 5.2 rule 3 names for
 * spending one yes twice, and it is the quietest: the row reaches the fetch
 * hours after the tap, wakes the camera, and nothing in the log says the
 * operator did not ask for it. So a clip export holding a wake is FAILED by
 * name instead — a row he can retry with one tap, which re-asks for the
 * authorisation. A clip export WITHOUT a wake is re-queued like any render:
 * there is nothing to spend, and a sleeping camera refuses at its own gate
 * exactly as it did the first time.
 */
function carriesAnAuthorisedWake(record: ExportRecord): boolean {
  const subject = exportSubjectOf(record)
  return subject.kind === 'clip' && subject.wake !== undefined
}

/**
 * Hand every interrupted row back to the engine, once, at boot.
 *
 * A row past its `expiresAt` is FAILED rather than re-rendered: hours of
 * footage re-encoded for a file the janitor is about to drop costs a recording
 * node an ffmpeg for nothing. Failing it is also what makes the outcome
 * visible — a row that silently stays `queued` forever is the defect this
 * module exists to remove, and swapping it for a quieter one would not be a
 * fix.
 */
export async function reconcileInterruptedExports(
  deps: ExportReconcileDeps,
): Promise<ExportReconcileReport> {
  const now = deps.now()
  const rows = await listExportsFor(deps.state)
  const interrupted = rows.filter(isInterrupted)
  if (interrupted.length === 0) return { requeued: 0, expired: 0 }

  let requeued = 0
  let expired = 0
  for (const row of interrupted) {
    const tags = { deviceId: row.deviceId }
    const meta = {
      exportId: row.id,
      wasState: row.state,
      fromMs: row.fromMs,
      toMs: row.toMs,
      createdAt: row.createdAt,
    }
    if (carriesAnAuthorisedWake(row)) {
      expired += 1
      await patchExport(deps.state, row.id, {
        state: 'failed',
        progressPct: null,
        error: clipExportFailure(
          'wake-expired',
          'interrupted by a restart — one authorised wake is one wake, so ask again to wake the camera',
        ),
      })
      deps.logger.warn('clip export abandoned: it was interrupted while holding a wake', {
        tags,
        meta,
      })
      continue
    }
    if (row.expiresAt <= now) {
      expired += 1
      await patchExport(deps.state, row.id, {
        state: 'failed',
        progressPct: null,
        error: 'interrupted by a restart and expired before it could be rendered',
      })
      deps.logger.warn('export abandoned: interrupted by a restart, and already expired', {
        tags,
        meta,
      })
      continue
    }
    requeued += 1
    // Back to `queued` FIRST, and only then enqueued: a row still claiming
    // `rendering` (with a progress number from a dead ffmpeg) reads as live
    // work to everyone looking at it, including the operator's exports list.
    await patchExport(deps.state, row.id, {
      state: 'queued',
      progressPct: null,
      error: null,
    })
    deps.logger.warn('export re-queued: it was interrupted by a restart', {
      tags,
      meta,
    })
    deps.engine.enqueue(row.id)
  }

  deps.logger.info('recording exports reconciled after restart', {
    meta: { interrupted: interrupted.length, requeued, expired },
  })
  return { requeued, expired }
}
