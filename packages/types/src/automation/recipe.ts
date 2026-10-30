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
 * Two parts:
 *
 *  - **`when`** — ONE tree (`./when.ts`) of all/any/not over event leaves
 *    (instants) and state leaves (durations). It replaces the flat trigger list
 *    plus the separate condition tree; the firing rule is in that file and in
 *    ADR "one tree".
 *  - **Actions** — `NcRuleActionSchema`'s two steps, plus the `{kind:'code'}`
 *    fragment of §3.2.2. See {@link AutomationActionSchema} for the ONE place
 *    this had to diverge from "verbatim", and why.
 *
 * A recipe stored in the old shape (`triggers` + `conditions`) still LOADS:
 * {@link AutomationRecipeSchema} (the parse-anywhere schema) converts it on parse. Nothing writes it.
 */

import { z } from 'zod'
import { type QuantityValue } from '../units/quantity-input.js'
import { LegacyConditionSchema, LegacyTriggerSchema, convertLegacyWhen } from './legacy-recipe.js'
import {
  AutomationWhenSchema,
  MAX_WHEN_DEPTH,
  MAX_WHEN_LEAVES,
  type AutomationWhen,
  validateWhenTree,
} from './when.js'

export type { QuantityValue }

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
  /**
   * The unit the person picked per arg (display only). `args` always hold the
   * value in the unit the method's input DECLARES (`paramMeta`); on a write an
   * arg may be a {@link QuantityValue}, which the save boundary converts.
   */
  argUnits: z.record(z.string(), z.string().min(1)).optional(),
})
export type AutomationCapStep = z.infer<typeof AutomationCapStepSchema>

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

export const CurrentAutomationRecipeSchema = z.object({
  when: AutomationWhenSchema,
  actions: z.array(AutomationActionSchema),
  runMode: AutomationRunModeSchema.optional(),
  /** How many run traces the automation keeps (default {@link DEFAULT_TRACE_KEEP}). */
  keepTraces: z.number().int().min(1).max(MAX_TRACE_KEEP).optional(),
})
export type AutomationRecipe = z.infer<typeof CurrentAutomationRecipeSchema>

/** A recipe as it was stored before the single tree. Read-only: nothing writes this. */
export const LegacyAutomationRecipeSchema = z.object({
  triggers: z.array(LegacyTriggerSchema),
  conditions: LegacyConditionSchema.optional(),
  actions: z.array(AutomationActionSchema),
  runMode: AutomationRunModeSchema.optional(),
  keepTraces: z.number().int().min(1).max(MAX_TRACE_KEEP).optional(),
})
export type LegacyAutomationRecipe = z.infer<typeof LegacyAutomationRecipeSchema>

/** The old shape as the new one, lossless. */
export function convertLegacyRecipe(legacy: LegacyAutomationRecipe): AutomationRecipe {
  const { triggers, conditions, ...rest } = legacy
  return { when: convertLegacyWhen({ triggers, conditions }), ...rest }
}

/**
 * Where recipes are PARSED (the core-blocks cap, the MCP tool, the literal a
 * saved block carries): the new shape as it is, or the old shape converted to
 * it. The output type is always the new one.
 */
export const AutomationRecipeSchema = z.union([
  CurrentAutomationRecipeSchema,
  LegacyAutomationRecipeSchema.transform(convertLegacyRecipe),
])

/** Bounds, shared by `when` and the old names the guards still know. */
export const MAX_CONDITION_DEPTH = MAX_WHEN_DEPTH
export const MAX_CONDITION_LEAVES = MAX_WHEN_LEAVES

/**
 * Author-time check. Returns `null` when the recipe is legal, else a message
 * naming what is wrong — the editor shows it verbatim, so it has to read like
 * something an operator can act on.
 */
export function validateRecipeBounds(recipe: AutomationRecipe): string | null {
  if (recipe.actions.length === 0) {
    return 'an automation needs at least one action — a rule that does nothing is not a rule'
  }
  return validateWhenTree(recipe.when)
}

export type { AutomationWhen }
