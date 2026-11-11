/**
 * The variables of a `set` step, edited as rows. The step stores a record, so
 * the order of the rows is the record's insertion order and two rows cannot
 * share a name: a rename onto a taken name is refused, and only one blank row
 * exists at a time.
 */
import type { AutomationSetStep } from '@camstack/types'

export type SetVars = AutomationSetStep['vars']
export type SetVarValue = SetVars[string]

export interface SetVarRow {
  readonly name: string
  readonly value: SetVarValue
}

export function setVarRows(vars: SetVars): readonly SetVarRow[] {
  return Object.entries(vars).map(([name, value]) => ({ name, value }))
}

function fromRows(rows: readonly SetVarRow[]): SetVars {
  return Object.fromEntries(rows.map((row) => [row.name, row.value]))
}

/** Rename row `index`, keeping its place and value. The same object when the name is taken. */
export function renameVar(vars: SetVars, index: number, name: string): SetVars {
  const rows = setVarRows(vars)
  if (rows.some((row, i) => i !== index && row.name === name)) return vars
  return fromRows(rows.map((row, i) => (i === index ? { ...row, name } : row)))
}

export function setVarValue(vars: SetVars, index: number, value: string): SetVars {
  return fromRows(setVarRows(vars).map((row, i) => (i === index ? { ...row, value } : row)))
}

/** A blank row can be added only when none is waiting for its name. */
export function canAddVar(vars: SetVars): boolean {
  return !Object.keys(vars).includes('')
}

export function addVar(vars: SetVars): SetVars {
  return canAddVar(vars) ? { ...vars, '': '' } : vars
}

export function removeVar(vars: SetVars, index: number): SetVars {
  return fromRows(setVarRows(vars).filter((_, i) => i !== index))
}
