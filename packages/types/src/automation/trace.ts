/**
 * Run traces — what an automation (or, later, an Action run) DID, node by node,
 * so the editor can paint every block green or red with its reason.
 *
 * A trace is data, not a log: it covers the WHOLE tree — the event leaf that
 * fired, every node of the `when` tree (containers and leaves, including the
 * ones a short-circuit never reached), the run-mode verdict and every action
 * step — each addressed by a stable path (`when.0.1`, `actions.2`, or `steps.N`
 * for an Action run). Traces written before the single tree carry
 * `conditions.*` paths and still parse. Skipped
 * evaluations are traced too, and identical consecutive skips collapse into a
 * repeat count so a trigger that fails every 5 minutes cannot flush real runs.
 *
 * {@link AutomationStepTraceSchema} is deliberately free of automation
 * vocabulary so an Action run records the same step shape.
 */

import { z } from 'zod'
import { isSecretMarkerLike } from '../keychain/secret-marker.js'
import { AutomationRunModeSchema } from './recipe.js'

/** A value a trace may show: JSON primitives and short lists, nothing deeper. */
export const TraceValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.union([z.string(), z.number()])),
])
export type TraceValue = z.infer<typeof TraceValueSchema>

export const AutomationRunOutcomeSchema = z.enum([
  'ran',
  'skipped-trigger',
  'skipped-conditions',
  'skipped-cooldown',
  'skipped-overlap',
  'failed',
  'aborted',
])
export type AutomationRunOutcome = z.infer<typeof AutomationRunOutcomeSchema>

/** `not-evaluated` = a short-circuit never reached the node. */
export const TraceNodeOutcomeSchema = z.enum(['pass', 'fail', 'not-evaluated'])
export type TraceNodeOutcome = z.infer<typeof TraceNodeOutcomeSchema>

export const AutomationTriggerTraceSchema = z.object({
  kind: z.string().min(1),
  /** The event leaf that fired (`when`, `when.0.1`); absent on traces written before the single tree. */
  path: z.string().min(1).optional(),
  outcome: z.enum(['pass', 'fail']),
  /** Why an event was rejected ("class person not in [dog]") or what fired. */
  reason: z.string(),
  /** deviceId, className, trackId, score … — only what the trigger exposes. */
  vars: z.record(z.string(), TraceValueSchema),
})
export type AutomationTriggerTrace = z.infer<typeof AutomationTriggerTraceSchema>

export const AutomationConditionTraceNodeSchema = z.object({
  /** `when` for the root, `when.<i>` for its i-th child, … (`conditions…` on an old trace). */
  path: z.string().min(1),
  kind: z.enum([
    'all',
    'any',
    'not',
    // state leaves ("is"); `condition` is its name on an old trace
    'condition',
    'device-is',
    'expression',
    'stationary-present',
    // event leaves
    'device-becomes',
    'device-event',
    'schedule',
    'interval',
    'manual',
    'detection',
    'stationary',
  ]),
  outcome: TraceNodeOutcomeSchema,
  reason: z.string(),
  deviceId: z.number().int().optional(),
  cap: z.string().optional(),
  fieldPath: z.string().optional(),
  operator: z.string().optional(),
  expected: TraceValueSchema.optional(),
  /** What the mirror held; `null` when it held nothing (unknown). */
  observed: TraceValueSchema.optional(),
})
export type AutomationConditionTraceNode = z.infer<typeof AutomationConditionTraceNodeSchema>

export const AutomationRunVerdictSchema = z.object({
  mode: AutomationRunModeSchema,
  decision: z.enum(['run', 'queued', 'restart', 'drop', 'cooldown', 'bypass']),
  reason: z.string(),
})
export type AutomationRunVerdict = z.infer<typeof AutomationRunVerdictSchema>

/** One executed (or not-run) step — shared by automations and Action runs. */
/** How many per-device outcomes one step trace keeps. */
export const MAX_STEP_DEVICE_OUTCOMES = 200

/** One device of a multi-device step: did the call land. */
export const StepDeviceTraceSchema = z.object({
  deviceId: z.number().int(),
  outcome: z.enum(['ok', 'error']),
  message: z.string().optional(),
})
export type StepDeviceTrace = z.infer<typeof StepDeviceTraceSchema>

export const AutomationStepTraceSchema = z.object({
  /** `actions.<i>` */
  path: z.string().min(1),
  kind: z.string().min(1),
  cap: z.string().optional(),
  method: z.string().optional(),
  /** The vocabulary action the step performs (`cover.open`), when it names one. */
  actionId: z.string().optional(),
  deviceId: z.number().int().optional(),
  /** What happened per device, when the step drove several (or a domain). */
  devices: z.array(StepDeviceTraceSchema).optional(),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
  /**
   * The parameters the step SENT, after `{{vars.x}}` substitution — what the
   * device was actually asked. Bounded like trigger `vars`; a secret parameter
   * is shown as {@link REDACTED_ARG}. Absent on traces written before it existed.
   */
  args: z.record(z.string(), TraceValueSchema).optional(),
  /** `empty`: the target resolved to no device, so nothing was done — never silently `ok`. */
  outcome: z.enum(['ok', 'error', 'not-run', 'empty']),
  message: z.string().optional(),
})
export type AutomationStepTrace = z.infer<typeof AutomationStepTraceSchema>

export const AutomationRunTraceSchema = z.object({
  runId: z.string().min(1),
  startedAt: z.number(),
  endedAt: z.number(),
  trigger: AutomationTriggerTraceSchema,
  conditions: z.array(AutomationConditionTraceNodeSchema),
  verdict: AutomationRunVerdictSchema.optional(),
  steps: z.array(AutomationStepTraceSchema),
  outcome: AutomationRunOutcomeSchema,
  /** How many identical consecutive skips this trace stands for (>= 1). */
  repeat: z.number().int().min(1),
  /** When the latest of those repeats happened. */
  lastAt: z.number(),
})
export type AutomationRunTrace = z.infer<typeof AutomationRunTraceSchema>

/**
 * What the hub's `runs` ledger holds for one owner (`automation:<blockId>` or
 * `action:<actionId>`): the cooldown stamp and the trace ring.
 */
export const AutomationStateDocSchema = z.object({
  version: z.literal(1),
  lastRunStartedAt: z.number().nullable(),
  traces: z.array(AutomationRunTraceSchema),
})
export type AutomationStateDoc = z.infer<typeof AutomationStateDocSchema>

/** The state of an owner that never reported. */
export const EMPTY_AUTOMATION_STATE: AutomationStateDoc = {
  version: 1,
  lastRunStartedAt: null,
  traces: [],
}

export function isSkippedTrace(trace: AutomationRunTrace): boolean {
  return trace.outcome.startsWith('skipped-')
}

/** Numbers vary between repeats of the same cause ("0.41 < 0.6" / "0.43 < 0.6"). */
function normaliseReason(reason: string): string {
  return reason.replace(/\d+(\.\d+)?/g, '#')
}

/** Two skips with the same signature are the same event repeating. */
export function skipSignature(trace: AutomationRunTrace): string {
  return JSON.stringify([
    trace.outcome,
    trace.trigger.kind,
    trace.trigger.outcome,
    normaliseReason(trace.trigger.reason),
    trace.verdict === undefined
      ? null
      : [trace.verdict.decision, normaliseReason(trace.verdict.reason)],
    trace.conditions.map((n) => [n.path, n.outcome]),
  ])
}

/**
 * `next` folded into `prev` when both are skips of the same signature (the
 * repeat count and the latest time move on), else null. Used by the block
 * BEFORE it sends, so a trigger that fails every few seconds costs one RPC per
 * flush, not one per skip; the ledger applies the same rule through
 * {@link appendTrace}.
 */
export function mergeSkipTraces(
  prev: AutomationRunTrace,
  next: AutomationRunTrace,
): AutomationRunTrace | null {
  if (!isSkippedTrace(prev) || !isSkippedTrace(next)) return null
  if (skipSignature(prev) !== skipSignature(next)) return null
  return {
    ...prev,
    repeat: prev.repeat + next.repeat,
    lastAt: next.lastAt,
    endedAt: next.endedAt,
  }
}

/**
 * Append a trace to a ring of at most `keep` entries, without mutating it.
 *
 *  - A skip identical to the previous trace is counted on that trace
 *    (`repeat`, `lastAt`), not appended.
 *  - When the ring is full, the oldest SKIPPED trace goes first; a real run is
 *    evicted only when every trace is a run. A noisy skip stream therefore
 *    cannot push the runs the operator is looking for out of the ring.
 */
export function appendTrace(
  ring: readonly AutomationRunTrace[],
  trace: AutomationRunTrace,
  keep: number,
): AutomationRunTrace[] {
  const last = ring[ring.length - 1]
  const merged = last === undefined ? null : mergeSkipTraces(last, trace)
  if (merged !== null) return [...ring.slice(0, -1), merged]
  const next = [...ring, trace]
  while (next.length > keep) {
    const skipAt = next.findIndex((t, i) => i < next.length - 1 && isSkippedTrace(t))
    next.splice(skipAt === -1 ? 0 : skipAt, 1)
  }
  return next
}

/** What a secret parameter is shown as in a trace. */
export const REDACTED_ARG = '[redacted]'
/** Parameters kept per step trace; the rest are counted in `…`. */
export const MAX_TRACE_ARGS = 32
/** A string value is cut here. */
export const MAX_TRACE_ARG_LENGTH = 200

/** A parameter whose NAME says it is a credential. */
const SECRET_ARG_NAME = /pass(word|phrase|code)?|secret|token|api[-_]?key|credential|\bpin\b|auth/i

function isSecretArg(name: string, value: unknown): boolean {
  return SECRET_ARG_NAME.test(name) || isSecretMarkerLike(value)
}

/**
 * The parameters a step sent, as a trace may show them: primitives and short
 * lists of them (anything deeper is its JSON text, cut), at most
 * {@link MAX_TRACE_ARGS} of them. No cap method declares a parameter secret, so
 * a parameter is redacted by what it is called or by being a keychain marker,
 * and `secretKeys` names the ones a caller knows about.
 */
export function buildStepArgsTrace(
  args: Readonly<Record<string, unknown>>,
  secretKeys: readonly string[] = [],
): Record<string, TraceValue> {
  const out: Record<string, TraceValue> = {}
  for (const [key, value] of Object.entries(args).slice(0, MAX_TRACE_ARGS)) {
    if (secretKeys.includes(key) || isSecretArg(key, value)) {
      out[key] = REDACTED_ARG
    } else if (typeof value === 'string') {
      out[key] =
        value.length > MAX_TRACE_ARG_LENGTH ? `${value.slice(0, MAX_TRACE_ARG_LENGTH)}…` : value
    } else if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
      out[key] = value
    } else if (
      Array.isArray(value) &&
      value.every((v) => typeof v === 'string' || typeof v === 'number')
    ) {
      out[key] = value
    } else if (value !== undefined) {
      const text = JSON.stringify(value) ?? ''
      out[key] =
        text.length > MAX_TRACE_ARG_LENGTH ? `${text.slice(0, MAX_TRACE_ARG_LENGTH)}…` : text
    }
  }
  return out
}

/**
 * The trigger stage of a trace from the bag a trigger handed to `run()`:
 * primitives and short lists of them (a device-state `to` that is an object is left out), minus the
 * bookkeeping keys `kind`, `at` and `leaf` (the fired leaf's path, which moves to `path`).
 */
export function buildTriggerTrace(
  trigger: Readonly<Record<string, unknown>>,
  outcome: 'pass' | 'fail',
  reason: string,
): AutomationTriggerTrace {
  const vars: Record<string, TraceValue> = {}
  for (const [key, value] of Object.entries(trigger)) {
    if (key === 'kind' || key === 'at' || key === 'leaf') continue
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean' ||
      value === null
    ) {
      vars[key] = value
    } else if (
      Array.isArray(value) &&
      value.every((v) => typeof v === 'string' || typeof v === 'number')
    ) {
      vars[key] = value
    }
  }
  const kind = typeof trigger['kind'] === 'string' ? trigger['kind'] : 'unknown'
  const path = typeof trigger['leaf'] === 'string' ? trigger['leaf'] : undefined
  return { kind, ...(path === undefined ? {} : { path }), outcome, reason, vars }
}
