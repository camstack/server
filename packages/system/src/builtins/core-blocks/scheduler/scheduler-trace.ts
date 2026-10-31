/**
 * What a scheduler reports to the runs ledger (owner `scheduler:<id>`): one
 * `AutomationRunTrace` per outcome. `outcome` is the closest automation
 * outcome, so a reader that has never heard of schedulers still reads it;
 * `scheduler` says exactly what happened (D983).
 */
import {
  type AutomationRunOutcome,
  type AutomationRunTrace,
  type AutomationStepTrace,
  type SchedulerOutcome,
  type TraceValue,
} from '@camstack/types'

const LEDGER_OUTCOME: Readonly<Record<SchedulerOutcome, AutomationRunOutcome>> = {
  done: 'ran',
  held: 'ran',
  failed: 'failed',
  'gave-up': 'failed',
  'condition-false': 'skipped-conditions',
  missed: 'skipped-trigger',
  inactive: 'skipped-trigger',
  overridden: 'skipped-overlap',
  'suspended-manual': 'skipped-trigger',
}

/** An outcome that is the trigger NOT passing (a skip), as opposed to something that ran. */
const SKIPPED: ReadonlySet<SchedulerOutcome> = new Set([
  'missed',
  'inactive',
  'condition-false',
  'overridden',
  'suspended-manual',
])

export interface SchedulerTraceInput {
  readonly runId: string
  readonly startedAt: number
  readonly endedAt: number
  readonly outcome: SchedulerOutcome
  readonly reason: string
  readonly vars: Readonly<Record<string, TraceValue>>
  readonly steps?: readonly AutomationStepTrace[]
}

export function schedulerTrace(input: SchedulerTraceInput): AutomationRunTrace {
  return {
    runId: input.runId,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    trigger: {
      kind: 'scheduler',
      outcome: SKIPPED.has(input.outcome) ? 'fail' : 'pass',
      reason: input.reason,
      vars: { ...input.vars },
    },
    conditions: [],
    steps: [...(input.steps ?? [])],
    outcome: LEDGER_OUTCOME[input.outcome],
    repeat: 1,
    lastAt: input.endedAt,
    scheduler: input.outcome,
  }
}
