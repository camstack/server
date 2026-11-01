/**
 * The values a person gives an action's variables when they run it by hand.
 *
 * A variable with a default is already answered; a required one without a
 * default must be filled before `actions.run` is called. Only values the person
 * (or a default) supplied are sent — an optional variable left empty is left
 * out, so the run sees it unset rather than as `''` or `NaN`.
 */

import type { ActionVariable } from '@camstack/types'

export type RunValue = string | number | boolean
export type RunValues = Readonly<Record<string, RunValue | undefined>>

/** Whether running needs the person to type something first. */
export function needsRunInput(variables: readonly ActionVariable[]): boolean {
  return variables.some((v) => v.required === true && v.default === undefined)
}

/** The form's starting values: each variable's default; a boolean starts off. */
export function initialRunValues(variables: readonly ActionVariable[]): RunValues {
  return Object.fromEntries(
    variables.map((v) => [v.name, v.default ?? (v.type === 'boolean' ? false : undefined)]),
  )
}

function isAnswered(value: RunValue | undefined): value is RunValue {
  if (value === undefined) return false
  if (typeof value === 'string') return value.trim() !== ''
  if (typeof value === 'number') return Number.isFinite(value)
  return true
}

/** The names of the required variables that have no answer yet. */
export function missingRunValues(
  variables: readonly ActionVariable[],
  values: RunValues,
): readonly string[] {
  return variables
    .filter((v) => v.required === true && !isAnswered(values[v.name]))
    .map((v) => v.name)
}

/** What `actions.run` receives: the answered variables only. */
export function runVariablesOf(
  variables: readonly ActionVariable[],
  values: RunValues,
): Record<string, RunValue> {
  const out: Record<string, RunValue> = {}
  for (const v of variables) {
    const value = values[v.name]
    if (isAnswered(value)) out[v.name] = value
  }
  return out
}
