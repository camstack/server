/**
 * Retention for recording exports: expiry sweep + delete-after-download.
 *
 * The file is removed but the history ROW is always kept (audit) — state flips
 * to `expired` / `deleted`. Pure functions over the DurableState handle + an
 * injected file-remove + clock, so they are unit-testable and fs-error tolerant
 * (a failing unlink never blocks the sweep of the other rows).
 */
import type { ExportRecord } from '@camstack/types'
import { listExportsFor, patchExport, type RecordingExportsState } from './export-store.js'

export interface ExportJanitorDeps {
  readonly state: RecordingExportsState
  /** Absolute output path for a record's MP4. */
  readonly outPath: (rec: ExportRecord) => string
  /** Remove a file; must not throw on ENOENT. */
  readonly removeFile: (path: string) => Promise<void>
}

/** States whose file still exists on disk and can be reclaimed. */
const LIVE_STATES = new Set(['ready'])

/**
 * Delete the files of every export past `expiresAt` and flip them to `expired`
 * (row kept). Only `ready` exports hold a file; `queued`/`rendering` are left
 * for the engine, terminal rows are skipped. Returns the expired ids.
 */
export async function sweepExpiredExports(
  now: number,
  deps: ExportJanitorDeps,
): Promise<{ expired: string[] }> {
  const rows = await listExportsFor(deps.state)
  const expired: string[] = []
  for (const rec of rows) {
    if (!LIVE_STATES.has(rec.state)) continue
    if (rec.expiresAt > now) continue
    try {
      await deps.removeFile(deps.outPath(rec))
    } catch {
      // fs error — still flip state; a stale file is reclaimed on a later sweep
    }
    await patchExport(deps.state, rec.id, { state: 'expired', fileBytes: null })
    expired.push(rec.id)
  }
  return { expired }
}

/**
 * Record a completed download. Stamps `downloadedAt`; when the export is
 * `deleteAfterDownload`, removes the file after `graceMs` (protects immediate
 * client retries) and flips to `deleted`. `scheduleDelete` is injected so the
 * caller controls timer semantics (real setTimeout in prod, immediate in test).
 */
export async function markDownloaded(
  id: string,
  now: number,
  deps: ExportJanitorDeps,
  scheduleDelete: (fn: () => void, delayMs: number) => void,
  graceMs: number,
): Promise<void> {
  const rec = await patchExport(deps.state, id, { downloadedAt: now })
  if (!rec || !rec.deleteAfterDownload) return
  scheduleDelete(() => {
    void (async () => {
      const current = (await listExportsFor(deps.state)).find((r) => r.id === id)
      if (!current || current.state !== 'ready') return
      try {
        await deps.removeFile(deps.outPath(current))
      } catch {
        // tolerate — state still flips
      }
      await patchExport(deps.state, id, { state: 'deleted', fileBytes: null })
    })()
  }, graceMs)
}
