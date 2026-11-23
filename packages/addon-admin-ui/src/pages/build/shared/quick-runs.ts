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

/** The automation whose step started an action run; a run an operator pressed has no caller to name. */
export interface QuickStartedBy {
  readonly kind: 'automation'
  readonly blockId: string
}

export function startedByOf(trace: AutomationRunTrace): QuickStartedBy | null {
  if (trace.trigger.kind !== 'action') return null
  const blockId = trace.trigger.vars['blockId']
  return typeof blockId === 'string' && blockId !== '' ? { kind: 'automation', blockId } : null
}

export interface QuickRunRow {
  readonly runId: string
  /** When the run last happened (a collapsed skip stands for several). */
  readonly at: number
  readonly durationMs: number
  readonly outcome: AutomationRunOutcome
  readonly scheduler: SchedulerOutcome | null
  readonly reason: string | null
  /** Who started the run, as an id the row resolves to a name; null = not recorded or pressed by hand. */
  readonly startedBy: QuickStartedBy | null
}

export function quickRunRows(
  traces: readonly AutomationRunTrace[],
  limit: number = QUICK_RUN_LIMIT,
): readonly QuickRunRow[] {
  return traces
    .toReversed()
    .slice(0, limit)
    .map((trace) => {
      const startedBy = startedByOf(trace)
      const { reason } = runSummary(trace)
      return {
        runId: trace.runId,
        at: trace.lastAt,
        durationMs: Math.max(0, trace.endedAt - trace.startedAt),
        outcome: trace.outcome,
        scheduler: trace.scheduler ?? null,
        // The trigger's own "started by <id>" sentence is replaced by the resolved name below.
        reason: startedBy !== null && reason === trace.trigger.reason ? null : reason,
        startedBy,
      }
    })
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
  return {
    unit: 'minutes',
    minutes: Math.floor(total / 60),
    seconds: total % 60,
  }
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
