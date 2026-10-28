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
  type ActionVariable,
} from '@camstack/types'
import { isVarRef } from '../flow/command-vocab'

export interface ActionDraft {
  readonly name: string
  readonly steps: readonly ActionStep[]
  readonly variables: readonly ActionVariable[]
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

export function draftOf(entry: ActionEntry | null): ActionDraft {
  if (entry === null) return EMPTY_DRAFT
  return {
    name: entry.name,
    steps: entry.steps ?? [],
    variables: entry.variables ?? [],
  }
}

/** Every variable a step reads, in order, without repeats. */
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
    if (Array.isArray(value)) value.forEach(walk)
    else if (typeof value === 'object' && value !== null) Object.values(value).forEach(walk)
  }
  for (const step of steps) {
    if (step.kind !== 'cap') continue
    walk(step.deviceId)
    walk(step.args)
  }
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
  if (Array.isArray(value)) return value.map((v) => renameInValue(v, from, to))
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, renameInValue(v, from, to)]),
    )
  }
  return value
}

function renameInStep(step: ActionStep, from: string, to: string): ActionStep {
  if (step.kind !== 'cap') return step
  const target =
    isVarRef(step.deviceId) && step.deviceId.$var === from ? { $var: to } : step.deviceId
  const args =
    step.args === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(step.args).map(([k, v]) => [k, renameInValue(v, from, to)]),
        )
  return { ...step, deviceId: target, ...(args === undefined ? {} : { args }) }
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
