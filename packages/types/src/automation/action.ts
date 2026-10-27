/**
 * Actions — named, runnable things an operator (or an automation) can start,
 * declared as LIST ENTRIES, never as devices.
 *
 * An entry is either **internal** (a short list of cap/wait steps kept in the
 * hub's `actions` record kind) or declared by an addon through the
 * `action-source` collection (a Home Assistant script, a scene …). The one
 * surface the UI and automations talk to is the `actions` cap; it keeps no
 * catalog of its own (D3) — every `list` asks the providers live.
 *
 * This file is the data half: the entry schema, the variables an entry may
 * declare, and the pure resolution of the values a run was given. It holds no
 * runtime.
 */

import { z } from 'zod'
import { AutomationRunOutcomeSchema } from './trace.js'
import { ActionStepSchema } from './recipe.js'

/** What a variable's value is. `select` takes one of `options`. */
export const ActionVariableTypeSchema = z.enum(['string', 'number', 'boolean', 'select'])
export type ActionVariableType = z.infer<typeof ActionVariableTypeSchema>

const ACTION_VARIABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export const ActionVariableValueSchema = z.union([z.string(), z.number(), z.boolean()])
export type ActionVariableValue = z.infer<typeof ActionVariableValueSchema>

/**
 * One declared variable. Steps reference it as `{ $var: 'name' }` (the whole
 * value) or `{{vars.name}}` (inside a string) in their args.
 */
export const ActionVariableSchema = z
  .object({
    name: z.string().regex(ACTION_VARIABLE_NAME_RE),
    label: z.string().min(1).max(120).optional(),
    type: ActionVariableTypeSchema,
    required: z.boolean().optional(),
    default: ActionVariableValueSchema.optional(),
    /** The allowed values of a `select`. */
    options: z.array(z.string().min(1)).min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.type === 'select' && v.options === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'a select variable needs options',
        path: ['options'],
      })
    }
    if (v.default !== undefined && variableValueError(v, v.default) !== null) {
      ctx.addIssue({
        code: 'custom',
        message: variableValueError(v, v.default) ?? 'invalid default',
        path: ['default'],
      })
    }
  })
export type ActionVariable = z.infer<typeof ActionVariableSchema>

/** Why `value` is not a legal value for the variable, or null when it is. */
function variableValueError(
  variable: Pick<ActionVariable, 'name' | 'type' | 'options'>,
  value: ActionVariableValue,
): string | null {
  switch (variable.type) {
    case 'string':
      return typeof value === 'string' ? null : `variable "${variable.name}" must be a string`
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
        ? null
        : `variable "${variable.name}" must be a number`
    case 'boolean':
      return typeof value === 'boolean' ? null : `variable "${variable.name}" must be true or false`
    case 'select':
      return typeof value === 'string' && (variable.options ?? []).includes(value)
        ? null
        : `variable "${variable.name}" must be one of ${(variable.options ?? []).join(', ')}`
  }
}

export type ResolvedActionVariables =
  | { readonly ok: true; readonly values: Readonly<Record<string, ActionVariableValue>> }
  | { readonly ok: false; readonly error: string }

/**
 * The values a run starts with: what the caller gave, checked against the
 * declaration, with defaults filled. A value the entry did not declare is
 * REFUSED — a typo in a variable name must not silently run with the default.
 */
export function resolveActionVariables(
  declared: readonly ActionVariable[] | undefined,
  given: Readonly<Record<string, ActionVariableValue>> | undefined,
): ResolvedActionVariables {
  const decls = declared ?? []
  const provided = given ?? {}
  for (const name of Object.keys(provided)) {
    if (!decls.some((d) => d.name === name)) {
      return { ok: false, error: `unknown variable "${name}"` }
    }
  }
  const values: Record<string, ActionVariableValue> = {}
  for (const decl of decls) {
    const value = provided[decl.name] ?? decl.default
    if (value === undefined) {
      if (decl.required === true) {
        return { ok: false, error: `variable "${decl.name}" is required` }
      }
      continue
    }
    const error = variableValueError(decl, value)
    if (error !== null) return { ok: false, error }
    values[decl.name] = value
  }
  return { ok: true, values }
}

export const ActionSourceKindSchema = z.enum(['internal', 'addon'])
export type ActionSourceKind = z.infer<typeof ActionSourceKindSchema>

/** Prefix of an internal action's id. */
export const INTERNAL_ACTION_PREFIX = 'internal:'

export function internalActionId(uuid: string): string {
  return `${INTERNAL_ACTION_PREFIX}${uuid}`
}

export function isInternalActionId(actionId: string): boolean {
  return (
    actionId.startsWith(INTERNAL_ACTION_PREFIX) && actionId.length > INTERNAL_ACTION_PREFIX.length
  )
}

/** The addon behind a `<addonId>:<localId>` id, or null for anything else (internal included). */
export function addonIdOfActionId(actionId: string): string | null {
  if (isInternalActionId(actionId)) return null
  const at = actionId.indexOf(':')
  return at > 0 && at < actionId.length - 1 ? actionId.slice(0, at) : null
}

export const ActionStatusSchema = z.object({
  isRunning: z.boolean(),
  /** Ms epoch the latest run STARTED; null when it never ran. */
  lastRunAt: z.number().nullable(),
  /** The latest run's failure; null on success or when it never ran. */
  lastError: z.string().nullable(),
})
export type ActionStatus = z.infer<typeof ActionStatusSchema>

export const IDLE_ACTION_STATUS: ActionStatus = {
  isRunning: false,
  lastRunAt: null,
  lastError: null,
}

export const ActionEntrySchema = z
  .object({
    /** `internal:<uuid>` or `<addonId>:<localId>`. */
    id: z.string().min(3),
    name: z.string().min(1).max(120),
    /** The addon that declared it; `core-blocks` for an internal one. */
    addonId: z.string().min(1),
    source: ActionSourceKindSchema,
    /** An addon-declared entry is edited where it was declared. */
    readOnly: z.boolean(),
    /** Internal only: cap and wait steps. No action-in-action, so no cycles. */
    steps: z.array(ActionStepSchema).min(1).max(50).optional(),
    variables: z.array(ActionVariableSchema).max(20).optional(),
    status: ActionStatusSchema,
  })
  .superRefine((entry, ctx) => {
    if (entry.source === 'internal') {
      if (!isInternalActionId(entry.id)) {
        ctx.addIssue({
          code: 'custom',
          message: 'an internal action id is internal:<uuid>',
          path: ['id'],
        })
      }
      return
    }
    if (entry.steps !== undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'only an internal action carries steps',
        path: ['steps'],
      })
    }
    if (!entry.readOnly) {
      ctx.addIssue({
        code: 'custom',
        message: 'an addon action is read-only here',
        path: ['readOnly'],
      })
    }
    if (addonIdOfActionId(entry.id) === null) {
      ctx.addIssue({
        code: 'custom',
        message: 'an addon action id is <addonId>:<localId>',
        path: ['id'],
      })
    }
  })
export type ActionEntry = z.infer<typeof ActionEntrySchema>

/** What an operator writes for an internal action. */
export const ActionInputSchema = z.object({
  name: z.string().min(1).max(120),
  steps: z.array(ActionStepSchema).min(1).max(50),
  variables: z.array(ActionVariableSchema).max(20).optional(),
})
export type ActionInput = z.infer<typeof ActionInputSchema>

/** Who started a run. Absent = the operator pressed it. */
export const ActionRunOriginSchema = z.object({
  /** The automation block whose step started it. */
  blockId: z.string().min(1).optional(),
})
export type ActionRunOrigin = z.infer<typeof ActionRunOriginSchema>

/** `started` = the caller did not ask to wait. */
export const ActionRunOutcomeSchema = z.union([AutomationRunOutcomeSchema, z.literal('started')])
export type ActionRunOutcome = z.infer<typeof ActionRunOutcomeSchema>

export const ActionRunResultSchema = z.object({
  runId: z.string().min(1),
  outcome: ActionRunOutcomeSchema,
  /** Why it did not run, or what failed. */
  message: z.string().optional(),
})
export type ActionRunResult = z.infer<typeof ActionRunResultSchema>

export const ActionErrorCodeSchema = z.enum([
  'not-found',
  'read-only',
  'invalid-variables',
  'invalid-steps',
  'not-linked',
  'busy',
])
export type ActionErrorCode = z.infer<typeof ActionErrorCodeSchema>

/**
 * A refusal with a reason a caller can branch on. The code leads the message
 * (`[read-only] …`) because a cap call flattens an error to its text.
 */
export class ActionError extends Error {
  readonly code: ActionErrorCode
  constructor(code: ActionErrorCode, message: string) {
    super(`[${code}] ${message}`)
    this.name = 'ActionError'
    this.code = code
  }
}

/** The run-state change `actions.onRunChanged` carries. */
export const ActionRunChangedSchema = z.object({
  actionId: z.string(),
  runId: z.string(),
  isRunning: z.boolean(),
  /** Set when the run ended. */
  outcome: AutomationRunOutcomeSchema.optional(),
  lastRunAt: z.number().nullable(),
  lastError: z.string().nullable(),
})
export type ActionRunChanged = z.infer<typeof ActionRunChangedSchema>
