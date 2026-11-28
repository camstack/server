/**
 * The editing model of an internal action: a name, ordered steps, and typed
 * variables. `toInput` is the only way out, and it goes through
 * `ActionInputSchema` — the same parse the hub applies — so a draft that
 * passes here is one `actions.create` / `actions.update` accepts.
 *
 * A step names a variable as `{ $var: name }` (an argument) or as its target
 * (`deviceId: { $var }`). Renaming or removing a variable here rewrites or
 * reports those references: a step must not run with a hole where the operator
 * meant a value (the runner throws on an unset variable).
 */

import {
  type ActionEntry,
  type ActionInput,
  ActionInputSchema,
  type ActionStep,
  ActionStepSchema,
  type ActionVariable,
} from '@dominevo/types'
import { isVarRef } from '../flow/command-vocab'

export interface ActionDraft {
  readonly name: string
  readonly steps: readonly ActionStep[]
  readonly variables: readonly ActionVariable[]
  /** Operator tags (D1054); absent on a draft that never had any. */
  readonly tags?: readonly string[]
  /** No editor field sets it yet, but a save must carry what is stored. */
  readonly minDelaySec?: number
}

export type DraftCheck =
  | { readonly ok: true; readonly input: ActionInput }
  | { readonly ok: false; readonly reason: DraftProblem }

export type DraftProblem =
  | { readonly kind: 'name' }
  | { readonly kind: 'no-steps' }
  | { readonly kind: 'undeclared'; readonly name: string }
  | { readonly kind: 'duplicate'; readonly name: string }
  | { readonly kind: 'bad-name'; readonly name: string }
  | { readonly kind: 'schema'; readonly message: string }

export const EMPTY_DRAFT: ActionDraft = { name: '', steps: [], variables: [] }

/** Query value that opens the editor on a one-step alarm-panel trigger. */
export const TRIGGER_ALARM_PRESET = 'trigger-alarm'

/** A new Action whose only step presses the alarm panel. The entry delay still runs. */
export function triggerAlarmDraft(panelDeviceId: number, name: string): ActionDraft {
  return {
    name,
    variables: [],
    steps: [
      {
        kind: 'command',
        target: { kind: 'devices', ids: [panelDeviceId] },
        actionId: 'alarm.trigger',
      },
    ],
  }
}

export function draftOf(entry: ActionEntry | null): ActionDraft {
  if (entry === null) return EMPTY_DRAFT
  return {
    name: entry.name,
    steps: entry.steps ?? [],
    variables: entry.variables ?? [],
    ...(entry.tags === undefined ? {} : { tags: entry.tags }),
    ...(entry.minDelaySec === undefined ? {} : { minDelaySec: entry.minDelaySec }),
  }
}

/** `{{vars.name}}` (and `{{vars.name.field}}`) inside a string: the same form the runner substitutes. */
const TEMPLATE_RE =
  /\{\{(\s*)vars\.([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z_][A-Za-z0-9_]*)*)(\s*)\}\}/g

/** A variable target (`{ kind: 'var', name }`) as the commands' device target spells it. */
function isVarTarget(value: unknown): value is { readonly kind: 'var'; readonly name: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'kind' in value &&
    value.kind === 'var' &&
    'name' in value &&
    typeof value.name === 'string'
  )
}

/**
 * Every variable a step reads, in order, without repeats, at any depth: a
 * `$var` reference or a variable target in a command, a notify, an http
 * request, a set, a probe, an action call, or any step nested in a choose,
 * parallel, repeat or else. A `{{vars.x}}` inside a text is not counted: a
 * `set` step may have written `x` itself, so it is not necessarily declared.
 */
export function variablesUsedBy(steps: readonly ActionStep[]): readonly string[] {
  const seen: string[] = []
  const note = (name: string): void => {
    if (!seen.includes(name)) seen.push(name)
  }
  const walk = (value: unknown): void => {
    if (isVarRef(value)) {
      note(value.$var)
      return
    }
    if (isVarTarget(value)) {
      note(value.name)
      return
    }
    if (Array.isArray(value)) value.forEach(walk)
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk)
  }
  walk(steps)
  return seen
}

function undeclaredVariable(draft: ActionDraft): string | null {
  const declared = new Set(draft.variables.map((v) => v.name))
  return variablesUsedBy(draft.steps).find((name) => !declared.has(name)) ?? null
}

export function checkDraft(draft: ActionDraft): DraftCheck {
  if (draft.name.trim() === '') return { ok: false, reason: { kind: 'name' } }
  if (draft.steps.length === 0) return { ok: false, reason: { kind: 'no-steps' } }
  const badName = draft.variables.find((v) => !isValidVariableName(v.name))
  if (badName !== undefined) return { ok: false, reason: { kind: 'bad-name', name: badName.name } }
  const duplicate = duplicateVariableNames(draft.variables)[0]
  if (duplicate !== undefined) return { ok: false, reason: { kind: 'duplicate', name: duplicate } }
  const undeclared = undeclaredVariable(draft)
  if (undeclared !== null) return { ok: false, reason: { kind: 'undeclared', name: undeclared } }
  const parsed = ActionInputSchema.safeParse({
    name: draft.name.trim(),
    steps: draft.steps,
    ...(draft.variables.length === 0 ? {} : { variables: draft.variables }),
    ...(draft.tags === undefined ? {} : { tags: draft.tags }),
    ...(draft.minDelaySec === undefined ? {} : { minDelaySec: draft.minDelaySec }),
  })
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const where = issue === undefined || issue.path.length === 0 ? '' : `${issue.path.join('.')}: `
    return {
      ok: false,
      reason: { kind: 'schema', message: `${where}${issue?.message ?? 'invalid'}` },
    }
  }
  return { ok: true, input: parsed.data }
}

function renameInValue(value: unknown, from: string, to: string): unknown {
  if (isVarRef(value)) return value.$var === from ? { $var: to } : value
  if (isVarTarget(value)) return value.name === from ? { ...value, name: to } : value
  if (typeof value === 'string') {
    return value.replace(
      TEMPLATE_RE,
      (whole, open: string, name: string, rest: string, close: string) =>
        name === from ? `{{${open}vars.${to}${rest}${close}}}` : whole,
    )
  }
  if (Array.isArray(value)) return value.map((v) => renameInValue(v, from, to))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renameInValue(v, from, to)]),
    )
  }
  return value
}

/**
 * The step with `from` renamed to `to` everywhere it reads it, nested steps
 * included. Only names change, so the result still parses; a step that somehow
 * does not is kept as it was rather than half-renamed.
 */
function renameInStep(step: ActionStep, from: string, to: string): ActionStep {
  const parsed = ActionStepSchema.safeParse(renameInValue(step, from, to))
  return parsed.success ? parsed.data : step
}

/** The variable at `index`, renamed everywhere a step reads it. */
export function renameVariable(draft: ActionDraft, index: number, to: string): ActionDraft {
  const current = draft.variables[index]
  if (current === undefined || current.name === to) return draft
  return {
    ...draft,
    variables: draft.variables.map((v, i) => (i === index ? { ...v, name: to } : v)),
    steps: draft.steps.map((s) => renameInStep(s, current.name, to)),
  }
}

/** A fresh variable named `value`, `value2`, … (first free). */
export function newVariable(existing: readonly ActionVariable[]): ActionVariable {
  const taken = new Set(existing.map((v) => v.name))
  let name = 'value'
  for (let n = 2; taken.has(name); n++) name = `value${String(n)}`
  return { name, type: 'string' }
}

/** A name the schema accepts (`ACTION_VARIABLE_NAME_RE`). */
export function isValidVariableName(name: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
}

/** Variable names declared more than once. */
export function duplicateVariableNames(variables: readonly ActionVariable[]): readonly string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const v of variables) {
    if (seen.has(v.name)) dup.add(v.name)
    seen.add(v.name)
  }
  return [...dup]
}
