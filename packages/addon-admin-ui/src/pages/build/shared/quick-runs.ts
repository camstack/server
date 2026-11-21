/**
 * The last runs a quick modal lists, read from the run ledger the editors
 * already read. One row per trace, newest first; the reason is the one line the
 * Runs panel keeps for a selected run, so the modal and the editor never tell
 * two stories about the same run.
 */
import type { AutomationRunOutcome, AutomationRunTrace, SchedulerOutcome } from '@camstack/types'
import { runSummary } from '../flow/trace-view'

/** How many runs the modal keeps: a glance, not the history (the editor holds that). */
export const QUICK_RUN_LIMIT = 5

export interface QuickRunRow {
  readonly runId: string
  /** When the run last happened (a collapsed skip stands for several). */
  readonly at: number
  readonly durationMs: number
  readonly outcome: AutomationRunOutcome
  readonly scheduler: SchedulerOutcome | null
  readonly reason: string | null
}

export function quickRunRows(
  traces: readonly AutomationRunTrace[],
  limit: number = QUICK_RUN_LIMIT,
): readonly QuickRunRow[] {
  return traces
    .toReversed()
    .slice(0, limit)
    .map((trace) => ({
      runId: trace.runId,
      at: trace.lastAt,
      durationMs: Math.max(0, trace.endedAt - trace.startedAt),
      outcome: trace.outcome,
      scheduler: trace.scheduler ?? null,
      reason: runSummary(trace).reason,
    }))
}

/** `<1 s`, `4.2 s`, `3 min 5 s`: a run lasts seconds, so milliseconds are not shown past one second. */
export function runDurationParts(ms: number): {
  readonly unit: 'subSecond' | 'seconds' | 'minutes'
  readonly seconds: number
  readonly minutes: number
} {
  if (ms < 1000) return { unit: 'subSecond', seconds: 0, minutes: 0 }
  if (ms < 60_000) return { unit: 'seconds', seconds: Math.round(ms / 100) / 10, minutes: 0 }
  const total = Math.round(ms / 1000)
  return { unit: 'minutes', minutes: Math.floor(total / 60), seconds: total % 60 }
}

/** The editor URL of one run: the section tab, the item, and the run it opens on. */
export function runEditorPath(
  tab: 'automations' | 'schedulers',
  itemKey: 'block' | 'scheduler',
  itemId: string,
  runId: string,
): string {
  const params = new URLSearchParams({ tab, [itemKey]: itemId, run: runId })
  return `/build?${params.toString()}`
}
