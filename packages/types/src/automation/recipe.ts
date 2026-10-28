/**
 * The automation RECIPE — what a visually-authored automation is, before it
 * becomes code.
 *
 * This is the data half of `docs/design/2026-08-08-automation-scripts-custom-devices.md`
 * Phase 6. A recipe is not an engine and never evaluates anything: it is a
 * declarative description that {@link generateAutomationBlock} compiles to the
 * TypeScript of an ordinary core block. There is therefore no second rule
 * engine, no second store and no second runtime — the block runner is the
 * runtime, `core_blocks` is the store (§2.1).
 *
 * Three vocabularies, each salvaged rather than invented:
 *
 *  - **Triggers** — the only genuinely new surface. Seven members, none of which
 *    touches notification delivery. The NC keeps its four *pipeline* triggers;
 *    these are device/time triggers and the two sets do not overlap.
 *  - **Conditions** — `ALL`/`ANY`/`NOT` over three leaf kinds, bounded. The
 *    expression leaf is the bounded engine at `../expression/`, which is where
 *    arithmetic between two device fields lives and the only place it lives.
 *  - **Actions** — `NcRuleActionSchema`'s two steps, plus the `{kind:'code'}`
 *    fragment of §3.2.2. See {@link AutomationActionSchema} for the ONE place
 *    this had to diverge from "verbatim", and why.
 *
 * Bounds are a guard, not a paragraph (§3.2.1): depth ≤ 3, ≤ 32 leaves. They are
 * enforced by {@link validateRecipeBounds} AND by the schema, so a recipe that
 * arrives over the wire cannot skip the check that the editor applies.
 */

import { z } from 'zod'
import {
  type ExpressionBindingSource,
  ExpressionBindingSourceSchema,
} from '../expression/binding-source.js'
import { validateExpressionSource } from '../expression/expression-source.js'
import { EXPRESSION_IDENTIFIER_RE, MAX_EXPRESSION_SOURCE_LENGTH } from '../expression/limits.js'

/**
 * Depth of a condition tree, counting the root container as level 1.
 *
 * Three is enough and is not arbitrary: `NOT` over a group is always rewritable
 * by De Morgan (`not(any(a,b))` ≡ `all(not a, not b)`), so the shapes that would
 * need a fourth level have an equivalent at three. An editor that refuses depth
 * 4 should offer that rewrite rather than refusing blankly.
 */
export const MAX_CONDITION_DEPTH = 3

/** Leaves per automation. A UI that grows without a bound becomes a language. */
export const MAX_CONDITION_LEAVES = 32

/** How a leaf compares a device field to a value. Derived from the field's
 *  `kind` in `deviceManager.getWireableFields`, never hand-maintained. */
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

/** A catalog leaf: one device field compared to one value. */
export interface AutomationConditionLeaf {
  readonly kind: 'condition'
  readonly deviceId: number
  readonly cap: string
  readonly fieldPath: string
  readonly operator: AutomationConditionOperator
  readonly value: string | number | boolean | readonly (string | number)[]
}

/** The escape hatch: the bounded expression engine over named device bindings. */
export interface AutomationConditionExpression {
  readonly kind: 'expression'
  readonly expr: string
  readonly bindings: Readonly<Record<string, ExpressionBindingSource>>
}

/**
 * True when the camera currently has a PARKED object (stationary registry)
 * matching `classes` (macro classes match like the detection trigger) in at
 * least one of `zones`. Reads the zone-analytics snapshot through the same
 * mirror as every other leaf, so a dropped event never decides it (D49).
 */
export interface AutomationConditionStationaryPresent {
  readonly kind: 'stationary-present'
  readonly deviceId: number
  readonly classes?: readonly string[]
  readonly zones?: readonly string[]
}

export interface AutomationConditionAll {
  readonly kind: 'all'
  readonly children: readonly AutomationCondition[]
}
export interface AutomationConditionAny {
  readonly kind: 'any'
  readonly children: readonly AutomationCondition[]
}
export interface AutomationConditionNot {
  readonly kind: 'not'
  readonly child: AutomationCondition
}

export type AutomationCondition =
  | AutomationConditionAll
  | AutomationConditionAny
  | AutomationConditionNot
  | AutomationConditionLeaf
  | AutomationConditionExpression
  | AutomationConditionStationaryPresent

const AutomationConditionLeafSchema = z.object({
  kind: z.literal('condition'),
  deviceId: z.number().int().nonnegative(),
  cap: z.string().min(1),
  fieldPath: z.string().min(1),
  operator: AutomationConditionOperatorSchema,
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))]),
})

const AutomationConditionStationaryPresentSchema = z.object({
  kind: z.literal('stationary-present'),
  deviceId: z.number().int().nonnegative(),
  /** Class names; a macro class matches every raw class that maps to it. */
  classes: z.array(z.string().min(1)).min(1).optional(),
  /** The parked object must be in at least one of these zones. */
  zones: z.array(z.string().min(1)).min(1).optional(),
})

/**
 * The expression leaf, declared as a plain object rather than an intersection
 * with {@link ExpressionSourceSchema}: a discriminated union has to be able to
 * read `kind` off each option, and an intersection hides it. The author-time
 * validation is the SAME function `ExpressionSourceSchema` runs, so the two
 * cannot drift — an expression that one accepts, the other accepts.
 */
const AutomationConditionExpressionSchema = z
  .object({
    kind: z.literal('expression'),
    expr: z.string().min(1).max(MAX_EXPRESSION_SOURCE_LENGTH),
    bindings: z.record(z.string().regex(EXPRESSION_IDENTIFIER_RE), ExpressionBindingSourceSchema),
  })
  .superRefine((src, ctx) => {
    const err = validateExpressionSource(src)
    if (err !== null) ctx.addIssue({ code: 'custom', message: err, path: ['expr'] })
  })

export const AutomationConditionSchema: z.ZodType<AutomationCondition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('all'), children: z.array(AutomationConditionSchema) }),
    z.object({ kind: z.literal('any'), children: z.array(AutomationConditionSchema) }),
    z.object({ kind: z.literal('not'), child: AutomationConditionSchema }),
    AutomationConditionLeafSchema,
    AutomationConditionExpressionSchema,
    AutomationConditionStationaryPresentSchema,
  ]),
)

/**
 * Compile-time pin: the interface exists because the union is RECURSIVE —
 * `z.infer` cannot name itself, so `z.lazy` needs the hand-written type. The
 * bidirectional `satisfies` pair keeps the two from drifting.
 */
type AutomationConditionInferred = z.infer<typeof AutomationConditionSchema>
const _automationConditionSchemaMatchesType =
  {} as AutomationConditionInferred satisfies AutomationCondition
const _automationConditionTypeMatchesSchema =
  {} as AutomationCondition satisfies AutomationConditionInferred
void _automationConditionSchemaMatchesType
void _automationConditionTypeMatchesSchema

/**
 * What starts a run.
 *
 * D8 compliance, and it is the reason `device-state` is not merely an event
 * subscription: the trigger evaluates against the **state mirror**, which is
 * reconciled, and an event only WAKES the evaluation. A dropped event therefore
 * DELAYS a trigger; it does not lose it. `schedule` uses `croner` — the one
 * already in the repo — because `setInterval(24h)` drifts and "at 23:30" does
 * not.
 */
export const AutomationTriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('device-state'),
    deviceId: z.number().int().nonnegative(),
    cap: z.string().min(1),
    fieldPath: z.string().min(1),
    /** Fire when the field takes this value. Omit to fire on any change. */
    becomes: z.union([z.string(), z.number(), z.boolean()]).optional(),
    /** Only on a CHANGE of value, not on every re-report. */
    edge: z.boolean().optional(),
    /** The condition must hold this long before the run starts. */
    forMs: z.number().int().min(0).max(86_400_000).optional(),
    /** Collapse a burst into one run. */
    debounceMs: z.number().int().min(0).max(600_000).optional(),
  }),
  z.object({
    kind: z.literal('device-event'),
    /** An `EventCategory` value. */
    category: z.string().min(1),
    deviceId: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('schedule'), cron: z.string().min(1).max(120) }),
  z.object({ kind: z.literal('manual') }),
  z.object({
    kind: z.literal('detection'),
    /** Class names. A macro class (`animal`, `vehicle`, `person`, `package`)
     *  matches every raw class that maps to it; any other name matches
     *  exactly. */
    classes: z.array(z.string().min(1)).min(1),
    deviceIds: z.array(z.number().int().nonnegative()).min(1),
    /** The track must have visited at least one of these zones. */
    zones: z.array(z.string().min(1)).min(1).optional(),
    /** Best-so-far confidence the track must reach. */
    minScore: z.number().min(0).max(1).optional(),
  }),
  z.object({
    kind: z.literal('stationary'),
    deviceIds: z.array(z.number().int().nonnegative()).min(1),
    /** Class names; a macro class matches like the detection trigger. */
    classes: z.array(z.string().min(1)).min(1).optional(),
    /** The parked object must be in at least one of these zones. */
    zones: z.array(z.string().min(1)).min(1).optional(),
    /** `appeared`: it became parked. `departed`: the registry retired it.
     *  The vocabulary of `PipelineAnalyticsStationaryChanged`. */
    phase: z.enum(['appeared', 'departed']),
  }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(1440) }),
])
export type AutomationTrigger = z.infer<typeof AutomationTriggerSchema>

/**
 * One action step.
 *
 * `wait` and `cap` are `NcRuleActionSchema`'s two members, kept structurally
 * identical so `NcRuleActionRunner` runs them unchanged — its device-scope
 * check, stop-at-first-failure and per-sequence throttle are the whole reason
 * to reuse it, and none of them are re-implemented here.
 *
 * **The one divergence, and it is forced.** `NcRuleActionSchema.cap.deviceId` is
 * a literal `z.number().int()`, and the NC runner's own `RunSequencesInput`
 * documents its subject device as *"for the log tag, never for routing"*. So an
 * NC action can never target the device that triggered it — which is fine for
 * the NC (its rules already scope to a device) and fatal for an automation
 * ("sound the siren of the camera that saw the person"). `deviceId` therefore
 * also accepts `{ $var }`, resolved from the run's `vars` bag BEFORE the runner
 * is called. The runner still receives a number and is untouched; the
 * resolution is the recipe's job, not the runner's.
 */
export const AutomationWaitStepSchema = z.object({
  kind: z.literal('wait'),
  seconds: z.number().min(0).max(300),
})

export const AutomationCapStepSchema = z.object({
  kind: z.literal('cap'),
  /**
   * One device, several same-family devices (locks / climate family / …),
   * or `{ $var }` for the device that triggered the run. An array is
   * fan-out at codegen — each id gets the same cap.method call.
   */
  deviceId: z.union([
    z.number().int(),
    z.array(z.number().int()).min(1),
    z.object({ $var: z.string().min(1) }),
  ]),
  cap: z.string().min(1),
  method: z.string().min(1),
  /** Values may carry `{{vars.x}}` slots, or be exactly `{ $var: 'name' }`, which
   *  SUBSTITUTE and do not evaluate (§3.2.3). Anything beyond substitution is
   *  the expression leaf. */
  args: z.record(z.string(), z.unknown()).optional(),
})

/**
 * The steps an internal Action may contain: cap and wait, and nothing that can
 * call back into an Action — so an Action can never reach itself (no cycles).
 */
export const ActionStepSchema = z.discriminatedUnion('kind', [
  AutomationWaitStepSchema,
  AutomationCapStepSchema,
])
export type ActionStep = z.infer<typeof ActionStepSchema>

export const AutomationActionSchema = z.discriminatedUnion('kind', [
  AutomationWaitStepSchema,
  AutomationCapStepSchema,
  z.object({
    kind: z.literal('action'),
    /** An entry of the `actions` surface (`internal:<uuid>` or `<addonId>:<localId>`). */
    actionId: z.string().min(1),
    /** Values for the action's declared variables; the others take their default. */
    variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  }),
  z.object({
    kind: z.literal('code'),
    /** Compiled into the automation's OWN block by esbuild — not a third
     *  runtime, not a `vm`, and not dynamically evaluated. */
    code: z.string().min(1).max(20_000),
  }),
])
export type AutomationAction = z.infer<typeof AutomationActionSchema>

/**
 * How a trigger that arrives while the automation is busy (or cooling down) is
 * handled. One of the automation's execution modes, never a property of its
 * actions. Absent means `single`.
 *
 *  - `single`   — drop the trigger while a run is in progress (traced + logged).
 *  - `restart`  — abort the run in progress (at its next step boundary), start fresh.
 *  - `queued`   — queue up to `max` triggers, drop the rest (traced).
 *  - `parallel` — up to `max` runs at once, drop the rest (traced).
 *  - `cooldown` — `single`, and no new run until `minutes` after the last run
 *    STARTED; persisted across a restart. A manual trigger bypasses only this
 *    wait, never the single/queued limits.
 */
export const AutomationRunModeSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('single') }),
  z.object({ mode: z.literal('restart') }),
  z.object({ mode: z.literal('queued'), max: z.number().int().min(1).max(10) }),
  z.object({ mode: z.literal('parallel'), max: z.number().int().min(1).max(10) }),
  z.object({ mode: z.literal('cooldown'), minutes: z.number().int().min(1).max(1440) }),
])
export type AutomationRunMode = z.infer<typeof AutomationRunModeSchema>

/** Run traces kept per automation when the recipe does not say. */
export const DEFAULT_TRACE_KEEP = 20
export const MAX_TRACE_KEEP = 100

export const AutomationRecipeSchema = z.object({
  triggers: z.array(AutomationTriggerSchema),
  conditions: AutomationConditionSchema.optional(),
  actions: z.array(AutomationActionSchema),
  runMode: AutomationRunModeSchema.optional(),
  /** How many run traces the automation keeps (default {@link DEFAULT_TRACE_KEEP}). */
  keepTraces: z.number().int().min(1).max(MAX_TRACE_KEEP).optional(),
})
export type AutomationRecipe = z.infer<typeof AutomationRecipeSchema>

function isLeaf(
  cond: AutomationCondition,
): cond is
  | AutomationConditionLeaf
  | AutomationConditionExpression
  | AutomationConditionStationaryPresent {
  return (
    cond.kind === 'condition' || cond.kind === 'expression' || cond.kind === 'stationary-present'
  )
}

/** Depth of a tree, root container = 1. A bare leaf is depth 1. */
export function conditionDepth(cond: AutomationCondition): number {
  if (isLeaf(cond)) return 1
  if (cond.kind === 'not') return 1 + conditionDepth(cond.child)
  const children = cond.children
  if (children.length === 0) return 1
  let deepest = 0
  for (const child of children) {
    const d = conditionDepth(child)
    if (d > deepest) deepest = d
  }
  return 1 + deepest
}

/** Leaves only — containers do not count toward the leaf budget. */
export function countConditionLeaves(cond: AutomationCondition): number {
  if (isLeaf(cond)) return 1
  if (cond.kind === 'not') return countConditionLeaves(cond.child)
  let total = 0
  for (const child of cond.children) total += countConditionLeaves(child)
  return total
}

function findEmptyContainer(cond: AutomationCondition): boolean {
  if (isLeaf(cond)) return false
  if (cond.kind === 'not') return findEmptyContainer(cond.child)
  if (cond.children.length === 0) return true
  return cond.children.some(findEmptyContainer)
}

/**
 * Author-time bounds check. Returns `null` when the recipe is legal, else a
 * message naming the bound it broke — the editor shows it verbatim, so it has
 * to read like something an operator can act on.
 */
export function validateRecipeBounds(recipe: AutomationRecipe): string | null {
  if (recipe.triggers.length === 0) {
    return 'an automation needs at least one trigger — without one nothing can start a run'
  }
  if (recipe.actions.length === 0) {
    return 'an automation needs at least one action — a rule that does nothing is not a rule'
  }
  const cond = recipe.conditions
  if (cond !== undefined) {
    if (findEmptyContainer(cond)) {
      return 'a condition group is empty — group existing rows instead of leaving a container to fill'
    }
    const depth = conditionDepth(cond)
    if (depth > MAX_CONDITION_DEPTH) {
      return `conditions nest ${depth} levels deep — the limit is ${MAX_CONDITION_DEPTH}. "not (any of …)" is the same as "all of (not …)", which is one level shallower`
    }
    const leaves = countConditionLeaves(cond)
    if (leaves > MAX_CONDITION_LEAVES) {
      return `conditions use ${leaves} leaves — the limit is ${MAX_CONDITION_LEAVES}`
    }
  }
  return null
}
