/**
 * Cron helpers — wraps `croner` so the orchestrator + the `previewNextRuns`
 * cap method share one validation + next-run-computation surface.
 *
 * `croner` is the opinionated node cron library we standardize on
 * server-side: pure JS, native TypeScript types, supports the full
 * 5-field POSIX cron grammar plus seconds (6-field), DST-aware, and
 * exposes `nextRun()` / `nextRuns(N)` for peeking without scheduling.
 * The orchestrator uses the peeking API (it has its own polling
 * loop); future surfaces (e.g. event-driven retention sweeps) can
 * register an actual scheduled `Cron(pattern, fn)` and let croner
 * own the timer.
 */
import { Cron } from 'croner'

/**
 * Validate a cron expression and return its next firing time strictly
 * after `after`, expressed as ms-epoch. Returns `null` when the
 * expression has no future runs (croner returns null e.g. for
 * fully-bounded patterns that have already elapsed). Throws when the
 * expression is syntactically invalid — callers are expected to
 * surface that to the operator.
 */
export function computeNextDue(cron: string, after: number): number | null {
  const job = new Cron(cron, { paused: true })
  const next = job.nextRun(new Date(after))
  return next ? next.getTime() : null
}

/**
 * Validate without computing — returns true when `cron` parses, false
 * otherwise. Used by the cap-router input zod schema's `.refine`
 * callback to reject malformed expressions at the boundary instead
 * of at scheduler-tick time.
 */
export function isValidCron(cron: string): boolean {
  try {
    void new Cron(cron, { paused: true })
    return true
  } catch {
    return false
  }
}

/**
 * Peek the next N firing times after `after` (default: now). Used by
 * the admin UI's CronEditor preview pane — operators see the next
 * 3–5 runs as they edit the expression so a wrong pattern is
 * obvious before save.
 */
export function previewNextRuns(cron: string, count: number, after?: number): readonly number[] {
  const job = new Cron(cron, { paused: true })
  const baseline = after !== undefined ? new Date(after) : new Date()
  const out: number[] = []
  let cursor: Date | null = baseline
  for (let i = 0; i < count; i++) {
    cursor = job.nextRun(cursor)
    if (!cursor) break
    out.push(cursor.getTime())
  }
  return out
}
