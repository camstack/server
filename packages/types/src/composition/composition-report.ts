/**
 * What the validator says about a composition and what the composer says about
 * a running one: the wire shapes the API returns (D659).
 */
import { z } from 'zod'
import {
  CompositionFieldReadSchema,
  CompositionFieldSourceSchema,
  compositionItemFieldPath,
} from './composition.js'
import { CompositionEventPlanSchema } from './composition-events.js'

export const CompositionProblemCodeSchema = z.enum([
  'reserved-variant',
  'unknown-capability',
  'not-composable',
  'wrong-device-type',
  'has-commands',
  'unknown-field',
  'nested-field',
  'missing-field',
  'kind-mismatch',
  'may-be-null',
  'source-missing',
  'source-unreadable',
  'source-capability-missing',
  'source-field-unknown',
  'expression-invalid',
  'cycle',
  /** Two STORED compositions target the same device — corrupted state, never silently resolved. */
  'duplicate-target',
  /** `items` on a capability whose status has no item array. */
  'not-item-array',
  /** A source for an item field the composer sets itself (the key, the label, `resettable`). */
  'item-field-reserved',
  /** The existing device a customization targets does not exist. */
  'target-missing',
  /** The existing device a customization targets could not be read — refused rather than stored unchecked. */
  'target-unreadable',
  /** An ADDED field that reads a source but can say neither `null` nor `'unknown'` — nothing to fall back to (D393, D663). */
  'not-replaceable',
  /** An existing-target feature would replace a capability the device already serves (D944). */
  'native-capability-replace',
  /** Helper members do not share one quantity (D944 §4). */
  'mixed-quantity',
  /** A helper spec is present and the stored features are not its compile. */
  'helper-mismatch',
  /** A member is the wrong device type or the wrong field for the template. */
  'member-constraint',
])
export type CompositionProblemCode = z.infer<typeof CompositionProblemCodeSchema>

/** One refusal, named (D391). `path` points into the composition, e.g. `features[0].fields.celsius`. */
export const CompositionProblemSchema = z.object({
  code: CompositionProblemCodeSchema,
  path: z.string(),
  message: z.string(),
})
export type CompositionProblem = z.infer<typeof CompositionProblemSchema>

export const CompositionFieldKindSchema = z.enum(['string', 'number', 'boolean', 'enum'])
export type CompositionFieldKind = z.infer<typeof CompositionFieldKindSchema>

/**
 * How a field says "unavailable" (D393, D663): `null` when its schema allows it;
 * `unknown` — the enum's own word — for an ADDED field that has one; `release`
 * for a REPLACED field of an existing device, whose claim is released so the
 * native provider's reading shows again; else the (composed) device goes offline.
 */
export const CompositionUnavailableModeSchema = z.enum([
  'null',
  'offline',
  'unknown',
  'release',
  /** Optional numeric: leave the key out and keep the device online. */
  'omit',
])
export type CompositionUnavailableMode = z.infer<typeof CompositionUnavailableModeSchema>

/**
 * `derived` reads a source · `clock` reads only `now`, recomputed when a sibling
 * field of its cap changes value · `constant` reads nothing, computed once ·
 * `accumulator` advances from the target's seed/current output.
 */
export const CompositionFieldRoleSchema = z.enum(['derived', 'clock', 'constant', 'accumulator'])
export type CompositionFieldRole = z.infer<typeof CompositionFieldRoleSchema>

/** The item a planned field belongs to; its `path` is then the dotted path INSIDE the item. */
export const CompositionFieldItemSchema = z.object({
  arrayPath: z.string(),
  key: z.string(),
  label: z.string(),
})
export type CompositionFieldItem = z.infer<typeof CompositionFieldItemSchema>

export const CompositionFieldPlanSchema = z.object({
  cap: z.string(),
  /** Top-level field, or — when `item` is set — the dotted path inside that item. */
  path: z.string(),
  item: CompositionFieldItemSchema.optional(),
  /** Index into `composition.features` this field's capability came from —
   *  lets a source/cycle problem name its path as `features[N].fields.<path>`
   *  (the same convention `planComposition`'s own problems already use). */
  featureIndex: z.number().int().nonnegative(),
  kind: CompositionFieldKindSchema,
  nullable: z.boolean(),
  required: z.boolean(),
  unavailable: CompositionUnavailableModeSchema,
  role: CompositionFieldRoleSchema,
  source: CompositionFieldSourceSchema,
  reads: z.array(CompositionFieldReadSchema),
})
export type CompositionFieldPlan = z.infer<typeof CompositionFieldPlanSchema>

/** The key every record map, log line and graph node uses for a planned field. Two items' `status` are two keys. */
export function compositionFieldKey(
  plan: Pick<CompositionFieldPlan, 'cap' | 'path' | 'item'>,
): string {
  const path =
    plan.item === undefined
      ? plan.path
      : compositionItemFieldPath(plan.item.arrayPath, plan.item.key, plan.path)
  return `${plan.cap}.${path}`
}

/**
 * What a feature does to its target (D663, D944): `new` builds a capability on a
 * new device; on an existing device it `add`s a capability the device lacks.
 * Replacing a capability the device already serves is refused
 * (`native-capability-replace`), not planned. `replace` remains on the claim
 * wire for a claim the hub already holds.
 */
export const CompositionFeatureModeSchema = z.enum(['new', 'add', 'replace'])
export type CompositionFeatureMode = z.infer<typeof CompositionFeatureModeSchema>

export const CompositionFeaturePlanSchema = z.object({
  /** Index in the stored feature array; disabled features are omitted rather than re-indexed. */
  featureIndex: z.number().int().nonnegative(),
  cap: z.string(),
  mode: CompositionFeatureModeSchema,
})
export type CompositionFeaturePlan = z.infer<typeof CompositionFeaturePlanSchema>

export const CompositionValidationSchema = z.object({
  ok: z.boolean(),
  problems: z.array(CompositionProblemSchema),
  fields: z.array(CompositionFieldPlanSchema),
  features: z.array(CompositionFeaturePlanSchema),
  events: z.array(CompositionEventPlanSchema),
})
export type CompositionValidation = z.infer<typeof CompositionValidationSchema>

/**
 * Mirrors `CoreBlockStatus`, pinned by `core-blocks-source.spec.ts`. `degraded`:
 * running, but a replaced field is released to the native provider while its
 * source is unavailable (ruling S1b, D663) — the reason names each such field.
 */
export const CompositionRunStatusSchema = z.enum([
  'stopped',
  'starting',
  'running',
  'degraded',
  'incomplete',
  'failed',
])
export type CompositionRunStatus = z.infer<typeof CompositionRunStatusSchema>

export const CompositionFieldStateKindSchema = z.enum(['fresh', 'stale', 'unavailable'])
export type CompositionFieldStateKind = z.infer<typeof CompositionFieldStateKindSchema>

export const CompositionFieldStateSchema = z.object({
  cap: z.string(),
  path: z.string(),
  /** Same as the plan's: two items' `status` are told apart by it. */
  item: CompositionFieldItemSchema.optional(),
  state: CompositionFieldStateKindSchema,
  /** `null` whenever `state === 'unavailable'`; never a plausible stand-in (D393). */
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  reason: z.string().optional(),
})
export type CompositionFieldState = z.infer<typeof CompositionFieldStateSchema>

export const CompositionBlockStateSchema = z.object({
  blockId: z.string(),
  deviceId: z.number().nullable(),
  status: CompositionRunStatusSchema,
  reason: z.string().optional(),
  fields: z.array(CompositionFieldStateSchema),
})
export type CompositionBlockState = z.infer<typeof CompositionBlockStateSchema>
