/**
 * The `when` tree — the ONE place an automation says when it runs.
 *
 * Containers are `all` / `any` / `not`. Leaves come in two kinds, told apart by
 * what they ARE, not by which section of a form they sit in:
 *
 *  - **event leaves (instants)** — something HAPPENS: a device field *becomes*
 *    a value, a device event, a schedule tick, an interval, a manual run, a
 *    detection, a parked object appearing or leaving;
 *  - **state leaves (durations)** — something IS true: a device field *is*
 *    compared to a value, a parked object is present, an expression holds.
 *
 * Firing rule (ADR, "one tree"):
 *  1. A tree with event leaves fires when ONE of them occurs AND the whole tree
 *     is true at that instant. The event that occurred is true; every other
 *     event leaf is false.
 *  2. A tree of state leaves only fires when it goes false → true. The first
 *     evaluation seeds the state, so it never fires because it was already true.
 *  3. Two event leaves that can only be satisfied together are refused at
 *     author time ({@link validateWhenTree}).
 */

import { z } from 'zod'
import { ExpressionBindingSourceSchema } from '../expression/binding-source.js'
import { validateExpressionSource } from '../expression/expression-source.js'
import { EXPRESSION_IDENTIFIER_RE, MAX_EXPRESSION_SOURCE_LENGTH } from '../expression/limits.js'
import { QuantityValueSchema } from '../units/quantity-input.js'
import { DetectionSubjectSchema, StationarySubjectSchema } from './detection-subject.js'

/**
 * Depth of the `when` tree, counting the root container as level 1. The old
 * condition tree was bounded at 3 under a flat list of triggers; the trigger
 * list is now the tree's top `any`, one level, so the bound is 3 + 1 and a
 * converted recipe never exceeds it.
 *
 * `NOT` over a group is always rewritable by De Morgan, so the shapes that
 * would need a fifth level have an equivalent at four.
 */
export const MAX_WHEN_DEPTH = 4

/** Leaves per automation. A UI that grows without a bound becomes a language. */
export const MAX_WHEN_LEAVES = 32

/** How a state leaf compares a device field to a value. Derived from the
 *  field's `kind` in `deviceManager.getWireableFields`, never hand-maintained. */
export const AutomationConditionOperatorSchema = z.enum([
  'eq',
  'ne',
  'gt',
  'gte',
  'lt',
  'lte',
  'contains',
  'in',
])
export type AutomationConditionOperator = z.infer<typeof AutomationConditionOperatorSchema>

// ── event leaves ──────────────────────────────────────────────────────────

/**
 * D8 compliance, and it is the reason a "becomes" leaf is not merely an event
 * subscription: it evaluates against the **state mirror**, which is reconciled,
 * and an event only WAKES the evaluation. A dropped event therefore DELAYS a
 * fire; it does not lose it.
 */
const DeviceBecomesLeafSchema = z.object({
  kind: z.literal('device-becomes'),
  deviceId: z.number().int().nonnegative(),
  cap: z.string().min(1),
  fieldPath: z.string().min(1),
  /** Fire when the field takes this value. Omit to fire on any change. */
  becomes: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Only on a CHANGE of value, not on every re-report. */
  edge: z.boolean().optional(),
  /** The new value must hold this long before it counts. */
  forMs: z.number().int().min(0).max(86_400_000).optional(),
  /** Collapse a burst into one occurrence. */
  debounceMs: z.number().int().min(0).max(600_000).optional(),
})

const DeviceEventLeafSchema = z.object({
  kind: z.literal('device-event'),
  /** An `EventCategory` value. */
  category: z.string().min(1),
  deviceId: z.number().int().nonnegative().optional(),
})

const ScheduleLeafSchema = z.object({
  kind: z.literal('schedule'),
  cron: z.string().min(1).max(120),
})

const ManualLeafSchema = z.object({ kind: z.literal('manual') })

const IntervalLeafSchema = z.object({
  kind: z.literal('interval'),
  minutes: z.number().int().min(1).max(1440),
})

const DetectionLeafSchema = z.object({
  kind: z.literal('detection'),
  /** One macro class each, optionally narrowed by a label; a track of any listed subject fires. */
  subjects: z.array(DetectionSubjectSchema).min(1),
  deviceIds: z.array(z.number().int().nonnegative()).min(1),
  /** The track must have visited at least one of these zones. */
  zones: z.array(z.string().min(1)).min(1).optional(),
  /** Best-so-far confidence the track must reach. */
  minScore: z.number().min(0).max(1).optional(),
})

const StationaryLeafSchema = z.object({
  kind: z.literal('stationary'),
  deviceIds: z.array(z.number().int().nonnegative()).min(1),
  subjects: z.array(StationarySubjectSchema).min(1).optional(),
  zones: z.array(z.string().min(1)).min(1).optional(),
  /** `appeared`: it became parked. `departed`: the registry retired it. */
  phase: z.enum(['appeared', 'departed']),
})

// ── state leaves ──────────────────────────────────────────────────────────

/** "is": one device field compared to one value, NOW. */
const DeviceIsLeafSchema = z.object({
  kind: z.literal('device-is'),
  deviceId: z.number().int().nonnegative(),
  cap: z.string().min(1),
  fieldPath: z.string().min(1),
  operator: AutomationConditionOperatorSchema,
  /**
   * The value. A number on a quantity field is stored in the field's base unit
   * (D944); a quantity value is the WRITE form, which the save boundary
   * replaces with the converted number and `unit`. A leaf that still carries
   * one is never evaluated (it fails).
   */
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
    QuantityValueSchema,
  ]),
  /** The unit the person picked for `value` (display only; `value` is in the base unit). */
  unit: z.string().min(1).optional(),
})

/**
 * True when the camera currently has a PARKED object matching `subjects` in at
 * least one of `zones`. Reads the zone-analytics snapshot through the same
 * mirror as every other state leaf, so a dropped event never decides it (D49).
 */
const StationaryPresentLeafSchema = z.object({
  kind: z.literal('stationary-present'),
  deviceId: z.number().int().nonnegative(),
  subjects: z.array(StationarySubjectSchema).min(1).optional(),
  zones: z.array(z.string().min(1)).min(1).optional(),
})

/**
 * The escape hatch: the bounded expression engine over named device bindings.
 * Declared as a plain object so a discriminated union can read `kind`; the
 * author-time validation is the SAME function `ExpressionSourceSchema` runs.
 */
const ExpressionLeafSchema = z
  .object({
    kind: z.literal('expression'),
    expr: z.string().min(1).max(MAX_EXPRESSION_SOURCE_LENGTH),
    bindings: z.record(z.string().regex(EXPRESSION_IDENTIFIER_RE), ExpressionBindingSourceSchema),
  })
  .superRefine((src, ctx) => {
    const err = validateExpressionSource(src)
    if (err !== null) ctx.addIssue({ code: 'custom', message: err, path: ['expr'] })
  })

export type AutomationEventLeaf =
  | z.infer<typeof DeviceBecomesLeafSchema>
  | z.infer<typeof DeviceEventLeafSchema>
  | z.infer<typeof ScheduleLeafSchema>
  | z.infer<typeof ManualLeafSchema>
  | z.infer<typeof IntervalLeafSchema>
  | z.infer<typeof DetectionLeafSchema>
  | z.infer<typeof StationaryLeafSchema>

export type AutomationStateLeaf =
  | z.infer<typeof DeviceIsLeafSchema>
  | z.infer<typeof StationaryPresentLeafSchema>
  | z.infer<typeof ExpressionLeafSchema>

export type AutomationLeaf = AutomationEventLeaf | AutomationStateLeaf

export type DeviceBecomesLeaf = Extract<AutomationEventLeaf, { kind: 'device-becomes' }>
export type DetectionLeaf = Extract<AutomationEventLeaf, { kind: 'detection' }>
export type StationaryLeaf = Extract<AutomationEventLeaf, { kind: 'stationary' }>
export type DeviceIsLeaf = Extract<AutomationStateLeaf, { kind: 'device-is' }>
export type StationaryPresentLeaf = Extract<AutomationStateLeaf, { kind: 'stationary-present' }>
export type ExpressionLeaf = Extract<AutomationStateLeaf, { kind: 'expression' }>

export interface AutomationAll {
  readonly kind: 'all'
  readonly children: readonly AutomationWhen[]
}
export interface AutomationAny {
  readonly kind: 'any'
  readonly children: readonly AutomationWhen[]
}
export interface AutomationNot {
  readonly kind: 'not'
  readonly child: AutomationWhen
}
export type AutomationWhen = AutomationAll | AutomationAny | AutomationNot | AutomationLeaf

export const AutomationWhenSchema: z.ZodType<AutomationWhen> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('all'), children: z.array(AutomationWhenSchema) }),
    z.object({ kind: z.literal('any'), children: z.array(AutomationWhenSchema) }),
    z.object({ kind: z.literal('not'), child: AutomationWhenSchema }),
    DeviceBecomesLeafSchema,
    DeviceEventLeafSchema,
    ScheduleLeafSchema,
    ManualLeafSchema,
    IntervalLeafSchema,
    DetectionLeafSchema,
    StationaryLeafSchema,
    DeviceIsLeafSchema,
    StationaryPresentLeafSchema,
    ExpressionLeafSchema,
  ]),
)

/**
 * Compile-time pin: the interface exists because the union is RECURSIVE —
 * `z.infer` cannot name itself, so `z.lazy` needs the hand-written type.
 */
type AutomationWhenInferred = z.infer<typeof AutomationWhenSchema>
const _whenSchemaMatchesType = {} as AutomationWhenInferred satisfies AutomationWhen
const _whenTypeMatchesSchema = {} as AutomationWhen satisfies AutomationWhenInferred
void _whenSchemaMatchesType
void _whenTypeMatchesSchema

// ── structure helpers ─────────────────────────────────────────────────────

const EVENT_KINDS: ReadonlySet<string> = new Set([
  'device-becomes',
  'device-event',
  'schedule',
  'manual',
  'interval',
  'detection',
  'stationary',
])

export function isEventLeaf(node: AutomationWhen): node is AutomationEventLeaf {
  return EVENT_KINDS.has(node.kind)
}

export function isLeaf(node: AutomationWhen): node is AutomationLeaf {
  return node.kind !== 'all' && node.kind !== 'any' && node.kind !== 'not'
}

/** Depth of a tree, root container = 1. A bare leaf is depth 1. */
export function whenDepth(node: AutomationWhen): number {
  if (isLeaf(node)) return 1
  if (node.kind === 'not') return 1 + whenDepth(node.child)
  let deepest = 0
  for (const child of node.children) deepest = Math.max(deepest, whenDepth(child))
  return 1 + deepest
}

/** Leaves only — containers do not count toward the leaf budget. */
export function countWhenLeaves(node: AutomationWhen): number {
  if (isLeaf(node)) return 1
  if (node.kind === 'not') return countWhenLeaves(node.child)
  let total = 0
  for (const child of node.children) total += countWhenLeaves(child)
  return total
}

/** Every leaf with its path (`when`, `when.0`, `when.0.1`, `when.0` under a `not`). */
export function forEachLeaf(
  node: AutomationWhen,
  visit: (leaf: AutomationLeaf, path: string) => void,
  path = 'when',
): void {
  if (isLeaf(node)) {
    visit(node, path)
    return
  }
  if (node.kind === 'not') {
    forEachLeaf(node.child, visit, `${path}.0`)
    return
  }
  node.children.forEach((child, i) => {
    forEachLeaf(child, visit, `${path}.${i}`)
  })
}

export function hasEventLeaves(node: AutomationWhen): boolean {
  let found = false
  forEachLeaf(node, (leaf) => {
    if (isEventLeaf(leaf)) found = true
  })
  return found
}

function hasEmptyContainer(node: AutomationWhen): boolean {
  if (isLeaf(node)) return false
  if (node.kind === 'not') return hasEmptyContainer(node.child)
  if (node.children.length === 0) return true
  return node.children.some(hasEmptyContainer)
}

// ── rule 3: two events that can only happen together ──────────────────────

const LEAF_WORDS: Readonly<Record<string, string>> = {
  'device-becomes': 'a device value that becomes',
  'device-event': 'a device event',
  schedule: 'a schedule',
  manual: 'a manual run',
  interval: 'an interval',
  detection: 'a detection',
  stationary: 'a parked object appearing or leaving',
}

function say(kind: string): string {
  return LEAF_WORDS[kind] ?? kind
}

interface EventNeed {
  /** Event leaves that must occur at the SAME instant for the node to be true. */
  readonly paths: readonly { readonly path: string; readonly kind: string }[]
}

/**
 * The cheapest set of event leaves that makes `node` true, with negation pushed
 * down to the leaves first (De Morgan), so `not(any(A, B))` and `all(not A,
 * not B)` are the same shape to the check. A negated event is its own error: an
 * event is an instant, "the event did not occur" is true at every other moment.
 */
function eventNeed(
  node: AutomationWhen,
  path: string,
  negated: boolean,
): EventNeed | { readonly error: string } {
  if (isLeaf(node)) {
    if (!isEventLeaf(node)) return { paths: [] }
    if (negated) {
      return {
        error: `"not" is applied to ${say(node.kind)} (${path}) — an event is an instant, so "it did not happen" is true at every other moment and can never start a run. Negate a state ("is") instead, or remove the "not"`,
      }
    }
    return { paths: [{ path, kind: node.kind }] }
  }
  if (node.kind === 'not') return eventNeed(node.child, `${path}.0`, !negated)
  // Under negation `all` behaves as `any` and the other way round.
  const conjunctive = (node.kind === 'all') !== negated
  const parts: EventNeed[] = []
  for (let i = 0; i < node.children.length; i += 1) {
    const child = node.children[i]
    if (child === undefined) continue
    const need = eventNeed(child, `${path}.${i}`, negated)
    if ('error' in need) return need
    parts.push(need)
  }
  if (conjunctive) return { paths: parts.flatMap((p) => p.paths) }
  let best: EventNeed | undefined
  for (const part of parts) {
    if (best === undefined || part.paths.length < best.paths.length) best = part
  }
  return best ?? { paths: [] }
}

/**
 * Author-time bounds and sense check of a `when` tree. Returns `null` when it
 * is legal, else a message the editor shows verbatim.
 */
export function validateWhenTree(when: AutomationWhen): string | null {
  if (hasEmptyContainer(when)) {
    return 'a group is empty — group existing rows instead of leaving a container to fill'
  }
  const depth = whenDepth(when)
  if (depth > MAX_WHEN_DEPTH) {
    return `the rules nest ${depth} levels deep — the limit is ${MAX_WHEN_DEPTH}. "not (any of …)" is the same as "all of (not …)", which is one level shallower`
  }
  const leaves = countWhenLeaves(when)
  if (leaves > MAX_WHEN_LEAVES) {
    return `the rules use ${leaves} rows — the limit is ${MAX_WHEN_LEAVES}`
  }
  const need = eventNeed(when, 'when', false)
  if ('error' in need) return need.error
  const [first, second] = need.paths
  if (first !== undefined && second !== undefined) {
    return `${say(first.kind)} (${first.path}) and ${say(second.kind)} (${second.path}) would both have to happen at the same instant, and an event happens at one moment — this can never run. Use "any of" to start on either, or turn one of them into a state ("is") that must already hold`
  }
  return null
}
