/**
 * The recipe shape before the single `when` tree: a flat list of triggers
 * (OR'd, each an instant) and an optional condition tree. Stored recipes —
 * the `AUTOMATION_RECIPE` literal of every block saved so far, and whatever an
 * older client still posts — are in this shape, so it stays READABLE here, and
 * {@link convertLegacyRecipe} turns it into the new one, losslessly and one
 * way. Nothing writes this shape any more.
 *
 *   `{ triggers: [t1…tn], conditions?: C }`
 *      → `when = all(any(t1…tn), C)`, or `any(t1…tn)` without `C`;
 *        a single trigger is not wrapped in `any`.
 *   a `condition` leaf → a `device-is` leaf (the "is" verb);
 *   a `device-state` trigger → a `device-becomes` leaf (the "becomes" verb);
 *   `classes: ['dog']` → the macro `animal` with the label `dog`.
 */

import { z } from 'zod'
import { ExpressionBindingSourceSchema } from '../expression/binding-source.js'
import { validateExpressionSource } from '../expression/expression-source.js'
import { EXPRESSION_IDENTIFIER_RE, MAX_EXPRESSION_SOURCE_LENGTH } from '../expression/limits.js'
import { QuantityValueSchema } from '../units/quantity-input.js'
import { subjectFromClassName } from './detection-subject.js'
import { AutomationConditionOperatorSchema, type AutomationWhen } from './when.js'

export const LegacyTriggerSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('device-state'),
    deviceId: z.number().int().nonnegative(),
    cap: z.string().min(1),
    fieldPath: z.string().min(1),
    becomes: z.union([z.string(), z.number(), z.boolean()]).optional(),
    edge: z.boolean().optional(),
    forMs: z.number().int().min(0).max(86_400_000).optional(),
    debounceMs: z.number().int().min(0).max(600_000).optional(),
  }),
  z.object({
    kind: z.literal('device-event'),
    category: z.string().min(1),
    deviceId: z.number().int().nonnegative().optional(),
  }),
  z.object({ kind: z.literal('schedule'), cron: z.string().min(1).max(120) }),
  z.object({ kind: z.literal('manual') }),
  z.object({
    kind: z.literal('detection'),
    classes: z.array(z.string().min(1)).min(1),
    deviceIds: z.array(z.number().int().nonnegative()).min(1),
    zones: z.array(z.string().min(1)).min(1).optional(),
    minScore: z.number().min(0).max(1).optional(),
  }),
  z.object({
    kind: z.literal('stationary'),
    deviceIds: z.array(z.number().int().nonnegative()).min(1),
    classes: z.array(z.string().min(1)).min(1).optional(),
    zones: z.array(z.string().min(1)).min(1).optional(),
    phase: z.enum(['appeared', 'departed']),
  }),
  z.object({ kind: z.literal('interval'), minutes: z.number().int().min(1).max(1440) }),
])
export type LegacyTrigger = z.infer<typeof LegacyTriggerSchema>
export type LegacyDetectionTrigger = Extract<LegacyTrigger, { kind: 'detection' }>
export type LegacyStationaryTrigger = Extract<LegacyTrigger, { kind: 'stationary' }>

const LegacyConditionLeafSchema = z.object({
  kind: z.literal('condition'),
  deviceId: z.number().int().nonnegative(),
  cap: z.string().min(1),
  fieldPath: z.string().min(1),
  operator: AutomationConditionOperatorSchema,
  value: z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.array(z.union([z.string(), z.number()])),
    QuantityValueSchema,
  ]),
  unit: z.string().min(1).optional(),
})
const LegacyStationaryPresentSchema = z.object({
  kind: z.literal('stationary-present'),
  deviceId: z.number().int().nonnegative(),
  classes: z.array(z.string().min(1)).min(1).optional(),
  zones: z.array(z.string().min(1)).min(1).optional(),
})
const LegacyExpressionSchema = z
  .object({
    kind: z.literal('expression'),
    expr: z.string().min(1).max(MAX_EXPRESSION_SOURCE_LENGTH),
    bindings: z.record(z.string().regex(EXPRESSION_IDENTIFIER_RE), ExpressionBindingSourceSchema),
  })
  .superRefine((src, ctx) => {
    const err = validateExpressionSource(src)
    if (err !== null) ctx.addIssue({ code: 'custom', message: err, path: ['expr'] })
  })

type LegacyLeaf =
  | z.infer<typeof LegacyConditionLeafSchema>
  | z.infer<typeof LegacyStationaryPresentSchema>
  | z.infer<typeof LegacyExpressionSchema>

export type LegacyCondition =
  | { readonly kind: 'all'; readonly children: readonly LegacyCondition[] }
  | { readonly kind: 'any'; readonly children: readonly LegacyCondition[] }
  | { readonly kind: 'not'; readonly child: LegacyCondition }
  | LegacyLeaf

export const LegacyConditionSchema: z.ZodType<LegacyCondition> = z.lazy(() =>
  z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('all'), children: z.array(LegacyConditionSchema) }),
    z.object({ kind: z.literal('any'), children: z.array(LegacyConditionSchema) }),
    z.object({ kind: z.literal('not'), child: LegacyConditionSchema }),
    LegacyConditionLeafSchema,
    LegacyExpressionSchema,
    LegacyStationaryPresentSchema,
  ]),
)

/** The recipe without its `actions` / `runMode` / `keepTraces` half, which did not change. */
export interface LegacyWhenHalf {
  readonly triggers: readonly LegacyTrigger[]
  readonly conditions?: LegacyCondition | undefined
}

function convertTrigger(trigger: LegacyTrigger): AutomationWhen {
  switch (trigger.kind) {
    case 'device-state':
      return { ...trigger, kind: 'device-becomes' }
    case 'detection': {
      const { classes, ...rest } = trigger
      return { ...rest, subjects: classes.map(subjectFromClassName) }
    }
    case 'stationary': {
      const { classes, ...rest } = trigger
      return {
        ...rest,
        ...(classes === undefined ? {} : { subjects: classes.map(subjectFromClassName) }),
      }
    }
    default:
      return trigger
  }
}

/** An old condition tree as a `when` subtree: `condition` → "is", classes → subjects. */
export function convertLegacyCondition(condition: LegacyCondition): AutomationWhen {
  switch (condition.kind) {
    case 'condition':
      return { ...condition, kind: 'device-is' }
    case 'stationary-present': {
      const { classes, ...rest } = condition
      return {
        ...rest,
        ...(classes === undefined ? {} : { subjects: classes.map(subjectFromClassName) }),
      }
    }
    case 'expression':
      return condition
    case 'not':
      return { kind: 'not', child: convertLegacyCondition(condition.child) }
    case 'all':
    case 'any':
      return { kind: condition.kind, children: condition.children.map(convertLegacyCondition) }
  }
}

/** One legacy trigger as a leaf — kept for readers that hold a single old trigger. */
export function convertLegacyTrigger(trigger: LegacyTrigger): AutomationWhen {
  return convertTrigger(trigger)
}

/** `all(any(t1…tn), C)`, or `any(t1…tn)`; a single trigger is not wrapped in `any`. */
export function convertLegacyWhen(half: LegacyWhenHalf): AutomationWhen {
  const leaves = half.triggers.map(convertTrigger)
  const first = leaves[0]
  const triggers: AutomationWhen =
    leaves.length === 1 && first !== undefined ? first : { kind: 'any', children: leaves }
  if (half.conditions === undefined) return triggers
  return { kind: 'all', children: [triggers, convertLegacyCondition(half.conditions)] }
}
