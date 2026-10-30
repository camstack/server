/**
 * A run trace (`AutomationRunTrace`, from the ledger) as the editor paints it:
 * one tone and one reason line per When / Then block, a tone per step, and the
 * outcome of every node of the `when` tree.
 *
 * Pure: the screen only maps `pass | fail | idle` to token classes.
 *   pass — evaluated and true / succeeded
 *   fail — evaluated and false / errored
 *   idle — never reached (a step after the failure, or a run the mode refused)
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
  readonly thenBlock: BlockView
  readonly steps: readonly StepView[]
}

/** `evalNode` roots the `when` tree at this path. A trace written before the
 *  single tree rooted its conditions at `conditions` and has no `when` node. */
const WHEN_ROOT = 'when'

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

/**
 * The When block: the event that fired, then the whole tree asked at that
 * instant. A fired event inside a tree that is false is the run the tree
 * refused, and reads red with the tree's own reason.
 */
function whenView(trace: AutomationRunTrace): BlockView {
  const triggerTone: BlockTone = trace.trigger.outcome === 'pass' ? 'pass' : 'fail'
  const triggerReason = nonEmpty(trace.trigger.reason)
  const root = trace.conditions.find((n) => n.path === WHEN_ROOT)
  if (triggerTone === 'fail' || root === undefined) {
    return { tone: triggerTone, reason: triggerReason }
  }
  if (root.outcome === 'fail')
    return { tone: 'fail', reason: nonEmpty(root.reason) ?? triggerReason }
  return { tone: root.outcome === 'pass' ? 'pass' : 'idle', reason: triggerReason }
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
    when: whenView(trace),
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

export interface StepArgView {
  readonly name: string
  readonly value: ValueView
}

export interface StepDetailView {
  readonly index: number
  readonly kind: string
  readonly tone: BlockTone
  readonly message: string | null
  /** What the step SENT (after `{{vars.x}}` substitution); empty on an old trace or a step with none. */
  readonly args: readonly StepArgView[]
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
      args: Object.entries(step.args ?? {}).map(([name, value]) => ({
        name,
        value: valueView(value),
      })),
    })),
  }
}

/** The outcome of every `when` node, by path (`when`, `when.0.1`). */
export function whenOutcomes(trace: AutomationRunTrace): ReadonlyMap<string, TraceNodeOutcome> {
  return new Map(trace.conditions.map((node) => [node.path, node.outcome]))
}
