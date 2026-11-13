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
 *  - **Actions** — the `wait` and device `command` steps, plus the `{kind:'code'}`
 *    fragment of §3.2.2. See {@link AutomationActionSchema}.
 *
 * A recipe stored in the old shape (`triggers` + `conditions`) still LOADS:
 * {@link AutomationRecipeSchema} (the parse-anywhere schema) converts it on parse. Nothing writes it.
 */

import { z } from 'zod'
import { type QuantityValue } from '../units/quantity-input.js'
import { findVocabAction } from '../device/cap-vocabulary/action-index.js'
import { ActionTargetSchema, type ActionTarget } from './action-target.js'
import { AutomationTemplateLinkSchema } from './template-link.js'
import { LegacyConditionSchema, LegacyTriggerSchema, convertLegacyWhen } from './legacy-recipe.js'
import {
  AutomationWhenSchema,
  MAX_WHEN_DEPTH,
  MAX_WHEN_LEAVES,
  type AutomationWhen,
  TRIGGERED_BY_NEEDS_AUTOMATION,
  hasTriggeredByLeaves,
  identifiedEventLeaves,
  triggeredByIssue,
  validateWhenTree,
} from './when.js'

export type { QuantityValue }
export type { ActionTarget }

/**
 * One action step: `wait`, or a device `command`.
 *
 * A command step names a VOCABULARY action (`cover.open`) and who it acts on
 * (D983: `devices`, a `domain`, or a `{ $var }` resolved from the run's
 * variables). It never names a cap method: the step runner turns the action
 * id into its cap + method through the vocabulary index when the step runs
 * (`vocabCall`), the one place that mapping happens. The step runner
 * (`runSteps`) owns the device-scope check, the stop-at-first-failure and the
 * variable substitution, once, for every caller — automations, Actions, and
 * the notification centre, which runs only Actions (planning#473).
 */
/** The longest one `wait` step lasts. It is cut by a restart of the run and does not survive a hub restart. */
export const WAIT_MAX_SECONDS = 3600
const WAIT_TOO_LONG = `a wait is at most one hour (${WAIT_MAX_SECONDS} s)`

export const AutomationWaitStepSchema = z.object({
  kind: z.literal('wait'),
  seconds: z.number().min(0).max(WAIT_MAX_SECONDS, WAIT_TOO_LONG),
})

/**
 * The fields of a command step, before the vocabulary check. A step is
 * {@link AutomationCommandStepSchema}.
 */
export const AutomationCommandStepBaseSchema = z.object({
  kind: z.literal('command'),
  /** WHO the step acts on. */
  target: ActionTargetSchema,
  /** The vocabulary action this step performs (`cover.open`). */
  actionId: z.string().min(1),
  /**
   * The values of the action's OPEN args (`position`, `presetId`); the args
   * the vocabulary bakes into the action are added when the step runs. Values
   * may carry `{{vars.x}}` slots, or be exactly `{ $var: 'name' }`, which
   * SUBSTITUTE and do not evaluate (§3.2.3).
   */
  args: z.record(z.string(), z.unknown()).optional(),
  /**
   * The unit the person picked per arg (display only). `args` always hold the
   * value in the unit the method's input DECLARES (`paramMeta`); on a write an
   * arg may be a {@link QuantityValue}, which the save boundary converts.
   */
  argUnits: z.record(z.string(), z.string().min(1)).optional(),
})

/** The vocabulary check every command step passes: the action exists. */
function refineKnownAction(step: { readonly actionId: string }, ctx: z.RefinementCtx): void {
  if (findVocabAction(step.actionId) === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: `"${step.actionId}" is not a vocabulary action id`,
      path: ['actionId'],
    })
  }
}

export const AutomationCommandStepSchema =
  AutomationCommandStepBaseSchema.superRefine(refineKnownAction)
export type AutomationCommandStep = z.infer<typeof AutomationCommandStepSchema>

/**
 * The steps an internal Action may contain: command and wait, and nothing that can
 * call back into an Action — so an Action can never reach itself (no cycles).
 * This is the LEAF shape: no condition of its own.
 */
export const LeafActionStepSchema = z.discriminatedUnion('kind', [
  AutomationWaitStepSchema,
  AutomationCommandStepSchema,
])

/** How many steps one `else` list holds. */
export const STEP_ELSE_MAX = 10

/**
 * The optional guard of a step (#472): `if` is the ONE `when` tree (D980), read
 * on the state mirror when the step is reached; `else` runs when it is false.
 * An `else` holds leaf steps only — the nesting is bounded at ONE level, so a
 * branch can never grow a tree the trace has to draw.
 */
const stepGuardShape = {
  if: AutomationWhenSchema.optional(),
  else: z.array(LeafActionStepSchema).max(STEP_ELSE_MAX).optional(),
}
const elseNeedsIf = {
  message: 'an else list needs the condition it is the other side of (if)',
  path: ['else'],
}

const GuardedWaitStepSchema = AutomationWaitStepSchema.extend(stepGuardShape).refine(
  (step) => step.else === undefined || step.if !== undefined,
  elseNeedsIf,
)
const GuardedCommandStepSchema = AutomationCommandStepBaseSchema.extend(stepGuardShape)
  .superRefine(refineKnownAction)
  .refine((step) => step.else === undefined || step.if !== undefined, elseNeedsIf)

/**
 * A step of a STANDALONE list (an action, a scheduler point, a preset): the
 * same two step kinds an automation runs, minus a guard that reads the
 * automation's trigger, which such a list does not have.
 */
export const ActionStepSchema = z
  .discriminatedUnion('kind', [GuardedWaitStepSchema, GuardedCommandStepSchema])
  .superRefine((step, ctx) => {
    if (step.if !== undefined && hasTriggeredByLeaves(step.if)) {
      ctx.addIssue({ code: 'custom', message: TRIGGERED_BY_NEEDS_AUTOMATION, path: ['if'] })
    }
  })
export type ActionStep = z.infer<typeof ActionStepSchema>

/**
 * Flow control of an AUTOMATION's list (#500). A standalone list (an action, a
 * scheduler point, a preset) stays `wait` and `cap`: it has no run of its own
 * to end and no variable bag to write.
 */
const continueOnErrorShape = {
  /** A failure of this step is traced `failed-continued` and the next step runs. */
  continueOnError: z.literal(true).optional(),
}

/** An automation's command step: the shared guarded command step, plus `continueOnError`. */
const AutomationGuardedCommandStepSchema = AutomationCommandStepBaseSchema.extend({
  ...stepGuardShape,
  ...continueOnErrorShape,
})
  .superRefine(refineKnownAction)
  .refine((step) => step.else === undefined || step.if !== undefined, elseNeedsIf)

export const STOP_REASON_MAX = 200

/** End the run here, on purpose. `reason` may carry `{{vars.x}}` slots. */
export const AutomationStopStepSchema = z.object({
  kind: z.literal('stop'),
  reason: z
    .string()
    .min(1, 'a stop needs a reason: it is what the run trace shows')
    .max(STOP_REASON_MAX),
  /** `ok`: the run ends as a success. `failed`: it ends as a failure, with the reason. */
  outcome: z.enum(['ok', 'failed']),
  /** Stop only when this reads true; false or unknown does not stop. */
  if: AutomationWhenSchema.optional(),
})
export type AutomationStopStep = z.infer<typeof AutomationStopStepSchema>

export const SET_VARS_MAX = 20
export const SET_VAR_VALUE_MAX = 500
export const SET_VAR_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/
/** Names the run itself writes and reads (`leaf` is what `triggered-by` judges): a step may not overwrite them. */
export const RESERVED_RUN_VARS: readonly string[] = ['kind', 'leaf', 'at']

/**
 * Write variables into the run's bag, for the steps after it. SUBSTITUTION
 * only, never evaluation: a text value may carry `{{vars.x}}` slots.
 */
export const AutomationSetStepSchema = z.object({
  kind: z.literal('set'),
  vars: z
    .record(z.string(), z.union([z.string().max(SET_VAR_VALUE_MAX), z.number(), z.boolean()]))
    .refine((vars) => Object.keys(vars).every((name) => SET_VAR_NAME_RE.test(name)), {
      message: 'a variable name is letters, digits and _, not starting with a digit (max 40)',
    })
    .refine((vars) => Object.keys(vars).length >= 1, { message: 'set needs at least one variable' })
    .refine((vars) => Object.keys(vars).length <= SET_VARS_MAX, {
      message: `set holds at most ${SET_VARS_MAX} variables`,
    })
    .refine((vars) => Object.keys(vars).every((name) => !RESERVED_RUN_VARS.includes(name)), {
      message: `the names ${RESERVED_RUN_VARS.join(', ')} belong to the run and cannot be set`,
    }),
  /** Set only when this reads true; false or unknown leaves the bag as it is. */
  if: AutomationWhenSchema.optional(),
})
export type AutomationSetStep = z.infer<typeof AutomationSetStepSchema>

const AutomationRunActionStepSchema = z.object({
  kind: z.literal('action'),
  /** An entry of the `actions` surface (`internal:<uuid>` or `<addonId>:<localId>`). */
  actionId: z.string().min(1),
  /** Values for the action's declared variables; the others take their default. */
  variables: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  ...continueOnErrorShape,
})

/** How many branches one `choose` holds. */
export const CHOOSE_BRANCHES_MAX = 6

/**
 * A step INSIDE a branch of a `choose`: a flow step with no condition of its
 * own (the branch is the condition) and no block inside it. Strict, so an `if`
 * written on such a step is refused rather than dropped.
 */
/** The longest a `wait-until` may wait: six hours. */
export const WAIT_UNTIL_TIMEOUT_MAX_S = 21_600

/**
 * Pause the run until a condition is true (#500). The timeout is mandatory: a
 * run never waits without an end. `onTimeout` says what a wait that ran out
 * does: `continue` goes on to the next step, `stop` ends the run as a failure.
 * A condition that cannot be read is not "true": the wait goes on (D49).
 */
export const AutomationWaitUntilStepSchema = z
  .object({
    kind: z.literal('wait-until'),
    when: AutomationWhenSchema,
    timeoutS: z
      .number()
      .int()
      .min(1, 'a wait needs a timeout of at least one second')
      .max(
        WAIT_UNTIL_TIMEOUT_MAX_S,
        `a wait for a condition is at most six hours (${WAIT_UNTIL_TIMEOUT_MAX_S} s)`,
      ),
    onTimeout: z.enum(['continue', 'stop']),
  })
  .strict()
export type AutomationWaitUntilStep = z.infer<typeof AutomationWaitUntilStepSchema>

/** The step kinds that hold steps of their own, or pause on a condition: they nest two levels at most. */
const BLOCK_STEP_KINDS: readonly string[] = ['choose', 'repeat', 'parallel', 'wait-until']
export const STEP_NEST_MAX = 2
const NEST_TOO_DEEP = `steps nest two levels at most: a step inside a nested choose or repeat can be a plain step only`

function kindOf(input: unknown): unknown {
  return typeof input === 'object' && input !== null ? Reflect.get(input, 'kind') : undefined
}

/** Where the nesting ends, a block step is refused in words rather than as an unknown kind. */
function nestTooDeep(issue: { readonly input?: unknown }): string | undefined {
  const kind = kindOf(issue.input)
  return typeof kind === 'string' && BLOCK_STEP_KINDS.includes(kind) ? NEST_TOO_DEEP : undefined
}

const plainStepSchemas = [
  AutomationWaitStepSchema.strict(),
  AutomationCommandStepBaseSchema.extend(continueOnErrorShape)
    .strict()
    .superRefine(refineKnownAction),
  AutomationStopStepSchema.omit({ if: true }).strict(),
  AutomationSetStepSchema.omit({ if: true }).strict(),
  AutomationRunActionStepSchema.strict(),
] as const

/**
 * A plain step: a flow step with no condition of its own and no step inside
 * it. The second (last) level of nesting holds these only.
 */
const AutomationBranchStepSchema = z.discriminatedUnion('kind', plainStepSchemas, {
  error: nestTooDeep,
})
export type AutomationBranchStep = z.infer<typeof AutomationBranchStepSchema>

export const PARALLEL_STEPS_MIN = 2
export const PARALLEL_STEPS_MAX = 5

/** A step that can run beside others: it writes no variable and does not end the run. */
const AutomationParallelMemberSchema = AutomationBranchStepSchema.refine(
  (step) => step.kind === 'command' || step.kind === 'action' || step.kind === 'wait',
  'a parallel holds device commands, actions and waits only: a set or a stop beside other steps has no order',
)

/**
 * Several steps at once (#500): all are started together and all are awaited.
 * A failure fails the run once the others finished, as in a sequence; a member
 * marked "continue if this fails" does not.
 */
export const AutomationParallelStepSchema = z
  .object({
    kind: z.literal('parallel'),
    steps: z
      .array(AutomationParallelMemberSchema)
      .min(PARALLEL_STEPS_MIN, 'a parallel needs at least two steps')
      .max(PARALLEL_STEPS_MAX, `a parallel takes at most ${PARALLEL_STEPS_MAX} steps`),
  })
  .strict()
export type AutomationParallelStep = z.infer<typeof AutomationParallelStepSchema>

export const REPEAT_COUNT_MAX = 20
export const REPEAT_ITERATIONS_MAX = 50
export const REPEAT_STEPS_MAX = STEP_ELSE_MAX
export const REPEAT_DEVICES_MAX = 50
/** The run variable a loop over devices writes before each iteration: the device id. */
export const REPEAT_ITEM_VAR = 'item'

const REPEAT_NEEDS_MAX = 'a repeat on a condition needs a maximum number of iterations'

/** A loop on a condition: the bound is mandatory, so a run never loops without an end. */
const repeatConditionShape = {
  when: AutomationWhenSchema,
  maxIterations: z
    .number({ error: REPEAT_NEEDS_MAX })
    .int()
    .min(1, REPEAT_NEEDS_MAX)
    .max(
      REPEAT_ITERATIONS_MAX,
      `a repeat on a condition runs at most ${REPEAT_ITERATIONS_MAX} times`,
    ),
  /** A pause between two iterations, never after the last. */
  waitS: z.number().int().min(1).max(WAIT_MAX_SECONDS, WAIT_TOO_LONG).optional(),
}

/** What decides how many times a `repeat` runs. */
export const AutomationRepeatLoopSchema = z.discriminatedUnion('by', [
  z
    .object({
      by: z.literal('count'),
      count: z
        .number()
        .int()
        .min(1)
        .max(REPEAT_COUNT_MAX, `a repeat runs at most ${REPEAT_COUNT_MAX} times`),
    })
    .strict(),
  /** Read BEFORE each iteration: false at the start runs nothing. */
  z.object({ by: z.literal('while'), ...repeatConditionShape }).strict(),
  /** Read AFTER each iteration: the steps run at least once. */
  z.object({ by: z.literal('until'), ...repeatConditionShape }).strict(),
  /** Once per device, with the device id in `vars.item`. */
  z
    .object({
      by: z.literal('forEach'),
      target: z
        .object({
          kind: z.literal('devices'),
          ids: z
            .array(z.number().int())
            .min(1, 'a repeat over devices needs at least one device')
            .max(
              REPEAT_DEVICES_MAX,
              `a repeat over devices takes at most ${REPEAT_DEVICES_MAX} devices`,
            ),
        })
        .strict(),
    })
    .strict(),
])
export type AutomationRepeatLoop = z.infer<typeof AutomationRepeatLoopSchema>

/**
 * The same steps several times (#500). Every form is bounded at save, so a
 * run cannot loop without an end. A failure or a `stop` in the steps ends the
 * loop and the run, as in a sequence.
 */
function repeatSchemaOf<S extends z.ZodType>(step: S) {
  return z
    .object({
      kind: z.literal('repeat'),
      loop: AutomationRepeatLoopSchema,
      steps: z
        .array(step)
        .min(1, 'a repeat needs at least one step')
        .max(REPEAT_STEPS_MAX, `a repeat takes at most ${REPEAT_STEPS_MAX} steps`),
    })
    .strict()
}

/**
 * One step, several ways (#500): the branches are read in order and the FIRST
 * whose condition is true runs; `else` runs when every branch is false. A
 * branch that cannot be read ends the choice: nothing runs, not the branches
 * after it and not the else (D49). The #472 `if` / `else` of a wait or cap
 * step is the one-branch case and stays as it is stored.
 */
function chooseSchemaOf<S extends z.ZodType>(step: S) {
  const steps = z.array(step).max(STEP_ELSE_MAX)
  return z.object({
    kind: z.literal('choose'),
    branches: z
      .array(
        z.object({
          if: AutomationWhenSchema,
          steps: steps.min(1, 'a branch needs at least one step'),
        }),
      )
      .min(1, 'a choose needs at least one branch')
      .max(CHOOSE_BRANCHES_MAX, `a choose takes at most ${CHOOSE_BRANCHES_MAX} branches`),
    else: steps.optional(),
  })
}

/**
 * A step INSIDE a top-level choose or repeat (the first level of nesting): a
 * plain step, or a block step whose own steps are plain. That second level is
 * where the nesting ends (`STEP_NEST_MAX`).
 */
const bodyStepUnion = z.discriminatedUnion('kind', [
  ...plainStepSchemas,
  AutomationWaitUntilStepSchema,
  AutomationParallelStepSchema,
  chooseSchemaOf(AutomationBranchStepSchema),
  repeatSchemaOf(AutomationBranchStepSchema),
])
export type AutomationBodyStep = z.infer<typeof bodyStepUnion>
export type AutomationBodyStepInput = z.input<typeof bodyStepUnion>
// Named, so the schemas built on it refer to the type instead of spelling the whole union out again.
const AutomationBodyStepSchema: z.ZodType<AutomationBodyStep, AutomationBodyStepInput> =
  bodyStepUnion

export const AutomationRepeatStepSchema = repeatSchemaOf(AutomationBodyStepSchema)
export type AutomationRepeatStep = z.infer<typeof AutomationRepeatStepSchema>

export const AutomationChooseStepSchema = chooseSchemaOf(AutomationBodyStepSchema)
export type AutomationChooseStep = z.infer<typeof AutomationChooseStepSchema>

export const AutomationActionSchema = z.discriminatedUnion('kind', [
  GuardedWaitStepSchema,
  AutomationGuardedCommandStepSchema,
  AutomationStopStepSchema,
  AutomationSetStepSchema,
  AutomationChooseStepSchema,
  AutomationWaitUntilStepSchema,
  AutomationParallelStepSchema,
  AutomationRepeatStepSchema,
  AutomationRunActionStepSchema,
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
  z.object({
    mode: z.literal('parallel'),
    max: z.number().int().min(1).max(10),
  }),
  z.object({
    mode: z.literal('cooldown'),
    minutes: z.number().int().min(1).max(1440),
  }),
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
  /**
   * Set when the automation was made from a template (#527): the template and
   * the values filled in. The rest of the recipe is then the expansion, which
   * the template engine rewrites when the template changes.
   */
  template: AutomationTemplateLinkSchema.optional(),
})
/**
 * Declared as an interface so it is printed by NAME: a capability that embeds
 * the recipe would otherwise inline the whole step tree into its own type,
 * past what the compiler can print (TS7056).
 */
export interface AutomationRecipe extends z.infer<typeof CurrentAutomationRecipeSchema> {}
/** The current shape as the parser accepts it (before defaults). */
export interface CurrentAutomationRecipeInput
  extends z.input<typeof CurrentAutomationRecipeSchema> {}

/** A recipe as it was stored before the single tree. Read-only: nothing writes this. */
export const LegacyAutomationRecipeSchema = z.object({
  triggers: z.array(LegacyTriggerSchema),
  conditions: LegacyConditionSchema.optional(),
  actions: z.array(AutomationActionSchema),
  runMode: AutomationRunModeSchema.optional(),
  keepTraces: z.number().int().min(1).max(MAX_TRACE_KEEP).optional(),
})
export type LegacyAutomationRecipe = z.infer<typeof LegacyAutomationRecipeSchema>
/** The legacy shape as the parser accepts it. Named for the same reason as {@link AutomationRecipe}. */
export interface LegacyAutomationRecipeInput extends z.input<typeof LegacyAutomationRecipeSchema> {}

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
const recipeUnion = z.union([
  CurrentAutomationRecipeSchema,
  LegacyAutomationRecipeSchema.transform(convertLegacyRecipe),
])
/** What the recipe parser accepts: the current shape or the legacy one. */
export type AutomationRecipeInput = CurrentAutomationRecipeInput | LegacyAutomationRecipeInput
export const AutomationRecipeSchema: z.ZodType<AutomationRecipe, AutomationRecipeInput> =
  recipeUnion

/** The `if` of a step that can carry one (`action`, `code`, `choose` and `wait-until` steps cannot). */
export function stepGuardOf(action: AutomationAction): AutomationWhen | undefined {
  switch (action.kind) {
    case 'action':
    case 'code':
    case 'choose':
    case 'wait-until':
    case 'parallel':
    case 'repeat':
      return undefined
    default:
      return action.if
  }
}

/** A condition a step reads when it is reached, and where it is under the step. */
export interface StepConditionRef {
  /** `if`, or `branches.<n>.if` for a branch of a `choose`. */
  readonly path: string
  readonly when: AutomationWhen
}

/** Every condition of a step: its own `if`, or the `if` of each branch of a `choose`. */
export function stepConditionsOf(action: AutomationAction): StepConditionRef[] {
  const under = (prefix: string, steps: readonly AutomationAction[]): StepConditionRef[] =>
    steps.flatMap((step, at) =>
      stepConditionsOf(step).map((ref) => ({ ...ref, path: `${prefix}.${at}.${ref.path}` })),
    )
  if (action.kind === 'choose') {
    return [
      ...action.branches.flatMap((branch, i) => [
        { path: `branches.${i}.if`, when: branch.if },
        ...under(`branches.${i}.steps`, branch.steps),
      ]),
      ...under('else', action.else ?? []),
    ]
  }
  if (action.kind === 'wait-until') return [{ path: 'when', when: action.when }]
  if (action.kind === 'repeat') {
    return [
      ...(action.loop.by === 'while' || action.loop.by === 'until'
        ? [{ path: 'loop.when', when: action.loop.when }]
        : []),
      ...under('steps', action.steps),
    ]
  }
  const when = stepGuardOf(action)
  return when === undefined ? [] : [{ path: 'if', when }]
}

/** Every step a block step holds, at both levels, in the order they are written; none for a plain step. */
export function nestedStepsOf(action: AutomationAction): AutomationBodyStep[] {
  const direct: readonly AutomationBodyStep[] =
    action.kind === 'parallel' || action.kind === 'repeat'
      ? action.steps
      : action.kind === 'choose'
        ? [...action.branches.flatMap((branch) => branch.steps), ...(action.else ?? [])]
        : []
  return direct.flatMap((step) => [step, ...nestedStepsOf(step)])
}

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
  const tree = validateWhenTree(recipe.when)
  if (tree !== null) return tree
  // Judged here, not in the tree check: a guard is a tree of its own, and the ids it names live in `when`.
  const ids = new Set(identifiedEventLeaves(recipe.when).map((entry) => entry.id))
  const inRules = triggeredByIssue(recipe.when, ids, 'the rules')
  if (inRules !== null) return inRules
  for (const [index, action] of recipe.actions.entries()) {
    for (const condition of stepConditionsOf(action)) {
      const issue = triggeredByIssue(condition.when, ids, `step ${index + 1}`)
      if (issue !== null) return issue
    }
  }
  return null
}

export type { AutomationWhen }
