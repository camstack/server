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

import type { AutomationRunTrace, TraceNodeOutcome, TraceValue } from '@camstack/types'

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

/**
 * A value a trace carries, as the Runs panel shows it. `unknown` is its own
 * case: the mirror held nothing, which is not 0, not false and not empty.
 */
export type ValueView =
  | { readonly kind: 'unknown' }
  | { readonly kind: 'value'; readonly text: string }

export function valueView(value: TraceValue): ValueView {
  if (value === null) return { kind: 'unknown' }
  return { kind: 'value', text: Array.isArray(value) ? value.join(', ') : String(value) }
}

export interface TriggerVarView {
  readonly name: string
  readonly value: ValueView
}

export interface ConditionNodeView {
  readonly path: string
  /** Nesting level under the root, for indentation. */
  readonly depth: number
  readonly kind: AutomationRunTrace['conditions'][number]['kind']
  readonly outcome: TraceNodeOutcome
  readonly reason: string | null
  /** `cap.fieldPath`, when the node reads a device field. */
  readonly subject: string | null
  readonly operator: string | null
  readonly deviceId: number | null
  /** null: the trace did not record one (a container, or a node never reached). */
  readonly expected: ValueView | null
  readonly observed: ValueView | null
}

export interface StepDetailView {
  readonly index: number
  readonly kind: string
  readonly tone: BlockTone
  readonly message: string | null
}

export interface TraceDetails {
  readonly vars: readonly TriggerVarView[]
  readonly conditions: readonly ConditionNodeView[]
  readonly steps: readonly StepDetailView[]
}

function subjectOf(cap: string | undefined, fieldPath: string | undefined): string | null {
  if (fieldPath === undefined) return null
  return cap === undefined ? fieldPath : `${cap}.${fieldPath}`
}

/** Every VALUE the trace already holds, in evaluation order: the trigger's vars,
 *  each condition node's expected against observed, each step's outcome. */
export function traceDetails(trace: AutomationRunTrace): TraceDetails {
  return {
    vars: Object.entries(trace.trigger.vars).map(([name, value]) => ({
      name,
      value: valueView(value),
    })),
    conditions: trace.conditions.map((node) => ({
      path: node.path,
      depth: node.path.split('.').length - 1,
      kind: node.kind,
      outcome: node.outcome,
      reason: nonEmpty(node.reason),
      subject: subjectOf(node.cap, node.fieldPath),
      operator: node.operator ?? null,
      deviceId: node.deviceId ?? null,
      expected: node.expected === undefined ? null : valueView(node.expected),
      observed: node.observed === undefined ? null : valueView(node.observed),
    })),
    steps: trace.steps.map((step) => ({
      index: stepIndex(step.path),
      kind: step.kind,
      tone: step.outcome === 'ok' ? 'pass' : step.outcome === 'error' ? 'fail' : 'idle',
      message: nonEmpty(step.message),
    })),
  }
}
