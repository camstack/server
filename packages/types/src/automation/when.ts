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
import { EventVocabularyKindSchema } from '../capabilities/event-vocabulary.js'
import { ExpressionBindingSourceSchema } from '../expression/binding-source.js'
import { validateExpressionSource } from '../expression/expression-source.js'
import { EXPRESSION_IDENTIFIER_RE, MAX_EXPRESSION_SOURCE_LENGTH } from '../expression/limits.js'
import { TimeSpecSchema, WeekdayKeySchema } from '../time/time-spec.js'
import { QuantityValueSchema } from '../units/quantity-input.js'
import { DetectionSubjectSchema, StationarySubjectSchema } from './detection-subject.js'
import { BecomesOperatorSchema, HOLD_MAX_MS, HoldSpecSchema } from './hold.js'

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
 * The stable name of an event leaf. A path (`when.0.1`) moves when a row is
 * reordered; the id does not, so a `triggered-by` leaf keeps pointing at the
 * same row. Optional: a leaf nothing refers to needs none.
 */
export const EVENT_LEAF_ID_RE = /^[A-Za-z0-9_-]{1,40}$/
const eventLeafId = { id: z.string().regex(EVENT_LEAF_ID_RE).optional() }

/**
 * D8 compliance, and it is the reason a "becomes" leaf is not merely an event
 * subscription: it evaluates against the **state mirror**, which is reconciled,
 * and an event only WAKES the evaluation. A dropped event therefore DELAYS a
 * fire; it does not lose it.
 */
const DeviceBecomesLeafSchema = z
  .object({
    kind: z.literal('device-becomes'),
    ...eventLeafId,
    deviceId: z.number().int().nonnegative(),
    cap: z.string().min(1),
    fieldPath: z.string().min(1),
    /** Fire when the field takes this value. Omit (with no `operator`) to fire on any change. */
    becomes: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /**
     * A threshold or a range instead of an equality: "crosses above 3000", "enters
     * 18..24". The leaf fires on the TRANSITION into the predicate, never on a re-report.
     * `value` is in the field's base unit; `between` / `outside` take `[low, high]`.
     */
    operator: BecomesOperatorSchema.optional(),
    value: z.union([z.number(), z.string(), z.boolean(), z.array(z.number()).length(2)]).optional(),
    /**
     * Hold: the transition (or, with no predicate, the new value) must stay for
     * `for.ms` before the leaf fires, ONCE per episode. See `hold.ts`.
     */
    for: HoldSpecSchema.optional(),
    /** @deprecated every leaf fires on a transition now; read as always on. */
    edge: z.boolean().optional(),
    /** @deprecated legacy `held` window — read through `holdOf` as `for: { ms, mode: 'held' }`. */
    forMs: z.number().int().min(0).max(HOLD_MAX_MS).optional(),
    /** Collapse a burst into one occurrence. */
    debounceMs: z.number().int().min(0).max(600_000).optional(),
  })
  .superRefine((leaf, ctx) => {
    if (leaf.becomes !== undefined && leaf.operator !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'a leaf names `becomes` or `operator`, not both',
        path: ['operator'],
      })
    }
    if (leaf.operator !== undefined && leaf.value === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'an operator needs the value to compare to',
        path: ['value'],
      })
    }
    const range = leaf.operator === 'between' || leaf.operator === 'outside'
    if (leaf.operator !== undefined && range !== Array.isArray(leaf.value)) {
      ctx.addIssue({
        code: 'custom',
        message: range ? 'a range takes [low, high]' : 'only a range takes [low, high]',
        path: ['value'],
      })
    }
  })

const DeviceEventLeafSchema = z.object({
  kind: z.literal('device-event'),
  ...eventLeafId,
  /** An `EventCategory` value. */
  category: z.string().min(1),
  deviceId: z.number().int().nonnegative().optional(),
})

/**
 * A schedule tick: a time spec (D983) — a clock time, a sun event or one date,
 * optionally on chosen weekdays — or, legacy, a five-field cron expression.
 * Exactly one of `at` and `cron`; the cron form stays readable and runnable so
 * a stored automation never stops firing, and is not written by new editors.
 */
const ScheduleLeafSchema = z
  .object({
    kind: z.literal('schedule'),
    ...eventLeafId,
    at: TimeSpecSchema.optional(),
    days: z.array(WeekdayKeySchema).min(1).max(7).optional(),
    /** @deprecated legacy cron — new schedules use `at`. */
    cron: z.string().min(1).max(120).optional(),
  })
  .refine((leaf) => (leaf.at === undefined) !== (leaf.cron === undefined), {
    message: 'a schedule names exactly one of `at` (a time spec) and `cron` (legacy)',
  })
  .refine((leaf) => leaf.days === undefined || leaf.at !== undefined, {
    message: '`days` goes with `at`; a cron expression carries its own days',
  })

/**
 * One payload predicate of a `device-fired` row: the value at `path` inside
 * the fire's `data` (dotted) equals `equals`. Compared strictly, no coercion.
 */
export const DeviceFiredMatchSchema = z.object({
  path: z.string().min(1).max(120),
  equals: z.union([z.string(), z.number(), z.boolean()]),
})
export type DeviceFiredMatch = z.infer<typeof DeviceFiredMatchSchema>

/**
 * "fires": one device of the `event-emitter` capability reported an event
 * (D1045). Every list is an OR, the lists together an AND; an absent list does
 * not narrow. `eventIds` are the device's own tokens, `sourceIds` the parts of
 * the device (a button), `kinds` the shared press kinds of its vocabulary.
 */
const DeviceFiredLeafSchema = z.object({
  kind: z.literal('device-fired'),
  ...eventLeafId,
  deviceId: z.number().int().nonnegative(),
  eventIds: z.array(z.string().min(1)).min(1).max(64).optional(),
  sourceIds: z.array(z.string().min(1)).min(1).max(64).optional(),
  kinds: z.array(EventVocabularyKindSchema).min(1).optional(),
  match: z.array(DeviceFiredMatchSchema).min(1).max(8).optional(),
})

const ManualLeafSchema = z.object({ kind: z.literal('manual'), ...eventLeafId })

const IntervalLeafSchema = z.object({
  kind: z.literal('interval'),
  ...eventLeafId,
  minutes: z.number().int().min(1).max(1440),
})

const DetectionLeafSchema = z.object({
  kind: z.literal('detection'),
  ...eventLeafId,
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
  ...eventLeafId,
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
  /** The comparison must hold (`held`) or the value stay put (`stable`) this long. */
  for: HoldSpecSchema.optional(),
})

/**
 * True when the camera currently has a PARKED object matching `subjects` in at
 * least one of `zones` (`minCount` of them, default one). Reads the zone-analytics snapshot through the same
 * mirror as every other state leaf, so a dropped event never decides it (D49).
 */
const StationaryPresentLeafSchema = z.object({
  kind: z.literal('stationary-present'),
  deviceId: z.number().int().nonnegative(),
  subjects: z.array(StationarySubjectSchema).min(1).optional(),
  zones: z.array(z.string().min(1)).min(1).optional(),
  /** How many matching parked objects must be there; absent means one. */
  minCount: z.number().int().positive().optional(),
})

/**
 * True while the site-local clock is inside a daily window and/or on one of
 * the named days. `days` names the local day a window STARTS on, so
 * 22:00-06:00 on weekdays is still inside at 01:00 Saturday. A one-date spec
 * (`kind: 'date'`) is refused: only a clock time or a sun event makes a window
 * that repeats every day.
 */
const timeIsWindowShape = {
  between: z.object({ from: TimeSpecSchema, to: TimeSpecSchema }).optional(),
  days: z.array(WeekdayKeySchema).min(1).max(7).optional(),
}

function timeIsWindowProblems(window: TimeIsWindow, ctx: z.RefinementCtx): void {
  if (window.between === undefined && window.days === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'a time-is leaf needs a between window, days, or both',
    })
  }
  for (const end of ['from', 'to'] as const) {
    if (window.between?.[end].kind === 'date') {
      ctx.addIssue({
        code: 'custom',
        message: 'a one-date time cannot bound a daily window: use a clock time or a sun event',
        path: ['between', end],
      })
    }
  }
}

const TimeIsWindowObjectSchema = z.object(timeIsWindowShape)

/**
 * What a `time-is` leaf holds beside its kind, judged by the leaf's own rules.
 * A template's time-window input stores exactly this.
 */
export const TimeIsWindowSchema = TimeIsWindowObjectSchema.superRefine(timeIsWindowProblems)
export type TimeIsWindow = z.infer<typeof TimeIsWindowObjectSchema>

const TimeIsLeafSchema = z
  .object({ kind: z.literal('time-is'), ...timeIsWindowShape })
  .superRefine(timeIsWindowProblems)

/** How many event leaves one `triggered-by` names. */
export const TRIGGERED_BY_MAX_IDS = 20

/**
 * True for the run that one of the named event leaves started. It reads the
 * run, not a device: in the tree it is judged against the leaf that fired, in
 * a step guard against the trigger the run carries. A run no event leaf
 * started (a state-only tree becoming true) is false.
 */
const TriggeredByLeafSchema = z.object({
  kind: z.literal('triggered-by'),
  leafIds: z.array(z.string().regex(EVENT_LEAF_ID_RE)).min(1).max(TRIGGERED_BY_MAX_IDS),
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
    /** The expression must stay true this long. An expression has no single value, so only `held`. */
    for: HoldSpecSchema.optional(),
  })
  .superRefine((src, ctx) => {
    const err = validateExpressionSource(src)
    if (err !== null) ctx.addIssue({ code: 'custom', message: err, path: ['expr'] })
    if (src.for?.mode === 'stable') {
      ctx.addIssue({
        code: 'custom',
        message: 'an expression is held, not stable: it has no single value to keep still',
        path: ['for', 'mode'],
      })
    }
  })

export type AutomationEventLeaf =
  | z.infer<typeof DeviceBecomesLeafSchema>
  | z.infer<typeof DeviceEventLeafSchema>
  | z.infer<typeof DeviceFiredLeafSchema>
  | z.infer<typeof ScheduleLeafSchema>
  | z.infer<typeof ManualLeafSchema>
  | z.infer<typeof IntervalLeafSchema>
  | z.infer<typeof DetectionLeafSchema>
  | z.infer<typeof StationaryLeafSchema>

export type AutomationStateLeaf =
  | z.infer<typeof DeviceIsLeafSchema>
  | z.infer<typeof StationaryPresentLeafSchema>
  | z.infer<typeof ExpressionLeafSchema>
  | z.infer<typeof TimeIsLeafSchema>
  | z.infer<typeof TriggeredByLeafSchema>

export type AutomationLeaf = AutomationEventLeaf | AutomationStateLeaf

export type DeviceBecomesLeaf = Extract<AutomationEventLeaf, { kind: 'device-becomes' }>
export type DeviceFiredLeaf = Extract<AutomationEventLeaf, { kind: 'device-fired' }>
export type DetectionLeaf = Extract<AutomationEventLeaf, { kind: 'detection' }>
export type StationaryLeaf = Extract<AutomationEventLeaf, { kind: 'stationary' }>
export type DeviceIsLeaf = Extract<AutomationStateLeaf, { kind: 'device-is' }>
export type StationaryPresentLeaf = Extract<AutomationStateLeaf, { kind: 'stationary-present' }>
export type ExpressionLeaf = Extract<AutomationStateLeaf, { kind: 'expression' }>
export type TimeIsLeaf = Extract<AutomationStateLeaf, { kind: 'time-is' }>
export type TriggeredByLeaf = Extract<AutomationStateLeaf, { kind: 'triggered-by' }>

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
    DeviceFiredLeafSchema,
    ScheduleLeafSchema,
    ManualLeafSchema,
    IntervalLeafSchema,
    DetectionLeafSchema,
    StationaryLeafSchema,
    DeviceIsLeafSchema,
    StationaryPresentLeafSchema,
    ExpressionLeafSchema,
    TimeIsLeafSchema,
    TriggeredByLeafSchema,
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
  'device-fired',
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

/** One event leaf that carries an id, with where it sits. */
export interface IdentifiedEventLeaf {
  readonly id: string
  readonly path: string
  readonly leaf: AutomationEventLeaf
}

/** The event leaves of the tree that carry an id, in tree order. */
export function identifiedEventLeaves(when: AutomationWhen): IdentifiedEventLeaf[] {
  const found: IdentifiedEventLeaf[] = []
  forEachLeaf(when, (leaf, path) => {
    if (isEventLeaf(leaf) && leaf.id !== undefined) found.push({ id: leaf.id, path, leaf })
  })
  return found
}

/** The id of the event leaf at `path` (`when.0.1`); null when the leaf has none or the path names no event leaf. */
export function eventLeafIdAt(when: AutomationWhen, path: string): string | null {
  return identifiedEventLeaves(when).find((entry) => entry.path === path)?.id ?? null
}

/** Does the tree hold a `triggered-by` leaf? */
export function hasTriggeredByLeaves(when: AutomationWhen): boolean {
  let found = false
  forEachLeaf(when, (leaf) => {
    if (leaf.kind === 'triggered-by') found = true
  })
  return found
}

/** Why a `triggered-by` leaf is refused outside an automation: there is no trigger row to name. */
export const TRIGGERED_BY_NEEDS_AUTOMATION =
  '"triggered by" reads which trigger started an automation — an action or a scheduler has no trigger rows, so it could never be true here'

/**
 * What is wrong with the `triggered-by` leaves of `tree`, given the ids the
 * automation's event leaves carry: an id nothing carries can never be true.
 * `where` names the tree in the message (`the rules`, `step 2`).
 */
export function triggeredByIssue(
  tree: AutomationWhen,
  knownIds: ReadonlySet<string>,
  where: string,
): string | null {
  let issue: string | null = null
  forEachLeaf(tree, (leaf) => {
    if (issue !== null || leaf.kind !== 'triggered-by') return
    const missing = leaf.leafIds.find((id) => !knownIds.has(id))
    if (missing !== undefined) {
      issue = `${where}: "triggered by" names the trigger "${missing}", and no trigger row of this automation has that id — pick one of its trigger rows`
    }
  })
  return issue
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
  'device-fired': 'a device firing an event',
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
  const seen = new Set<string>()
  for (const entry of identifiedEventLeaves(when)) {
    if (seen.has(entry.id)) {
      return `two trigger rows share the id "${entry.id}" — an id names one row`
    }
    seen.add(entry.id)
  }
  const need = eventNeed(when, 'when', false)
  if ('error' in need) return need.error
  const [first, second] = need.paths
  if (first !== undefined && second !== undefined) {
    return `${say(first.kind)} (${first.path}) and ${say(second.kind)} (${second.path}) would both have to happen at the same instant, and an event happens at one moment — this can never run. Use "any of" to start on either, or turn one of them into a state ("is") that must already hold`
  }
  return null
}
