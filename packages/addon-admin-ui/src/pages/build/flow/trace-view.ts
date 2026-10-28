/**
 * A run trace (`AutomationRunTrace`, from the ledger) as the editor paints it:
 * one tone and one reason line per When / If / Then block, and a tone per step.
 *
 * Pure: the screen only maps `pass | fail | idle` to token classes.
 *   pass — evaluated and true / succeeded
 *   fail — evaluated and false / errored
 *   idle — never reached (a condition a failed trigger never asked, a step after
 *          the failure, or a run the mode refused)
 */

import type { AutomationRunTrace } from '@camstack/types'

export type BlockTone = 'pass' | 'fail' | 'idle'

export interface BlockView {
  readonly tone: BlockTone
  /** The server's own words for why, or null when there is nothing to add. */
  readonly reason: string | null
}

export interface StepView {
  readonly index: number
  readonly tone: BlockTone
  readonly message: string | null
}

export interface TraceView {
  readonly when: BlockView
  /** null when the recipe has no conditions: the block stays untinted. */
  readonly condition: BlockView | null
  readonly thenBlock: BlockView
  readonly steps: readonly StepView[]
}

/** `evalNode` roots the tree at this path. */
const CONDITION_ROOT = 'conditions'

function nonEmpty(text: string | undefined): string | null {
  return text === undefined || text.trim() === '' ? null : text
}

function stepIndex(path: string): number {
  const last = path.slice(path.lastIndexOf('.') + 1)
  const n = Number(last)
  return Number.isInteger(n) ? n : 0
}

function stepsOf(trace: AutomationRunTrace): readonly StepView[] {
  return trace.steps.map((s) => ({
    index: stepIndex(s.path),
    tone: s.outcome === 'ok' ? 'pass' : s.outcome === 'error' ? 'fail' : 'idle',
    message: nonEmpty(s.message),
  }))
}

function conditionView(trace: AutomationRunTrace): BlockView | null {
  const root = trace.conditions.find((n) => n.path === CONDITION_ROOT)
  if (root === undefined) return null
  const tone: BlockTone =
    root.outcome === 'pass' ? 'pass' : root.outcome === 'fail' ? 'fail' : 'idle'
  return { tone, reason: nonEmpty(root.reason) }
}

function thenView(trace: AutomationRunTrace, steps: readonly StepView[]): BlockView {
  if (trace.outcome === 'ran') return { tone: 'pass', reason: null }
  if (trace.outcome === 'failed' || trace.outcome === 'aborted') {
    const failed = steps.find((s) => s.tone === 'fail')
    return { tone: 'fail', reason: failed?.message ?? null }
  }
  return { tone: 'idle', reason: nonEmpty(trace.verdict?.reason) }
}

export function traceView(trace: AutomationRunTrace): TraceView {
  const steps = stepsOf(trace)
  return {
    when: {
      tone: trace.trigger.outcome === 'pass' ? 'pass' : 'fail',
      reason: nonEmpty(trace.trigger.reason),
    },
    condition: conditionView(trace),
    thenBlock: thenView(trace, steps),
    steps,
  }
}

/** The tone of the step at `index`, or null when the run never listed it. */
export function stepToneAt(view: TraceView | null, index: number): BlockTone | null {
  if (view === null) return null
  return view.steps.find((s) => s.index === index)?.tone ?? 'idle'
}
