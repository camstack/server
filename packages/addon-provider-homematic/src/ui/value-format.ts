import type { ConfigValue, ValueParam } from '../ccu/ccu-schemas.js'
import { parseEdit } from './ParamField.js'

/**
 * A VALUES enum arrives as its index; the edit field works on the label.
 * Returns the parameter with its value turned into the label it stands for.
 */
export function asEditable(param: ValueParam): ValueParam {
  if (param.type !== 'ENUM' || param.valueList === null || typeof param.value !== 'number') {
    return param
  }
  return { ...param, value: param.valueList[param.value] ?? null }
}

/** What the CCU takes for an edited value; an enum label goes back to its index. */
export function parseValueEdit(param: ValueParam, raw: string | boolean): ConfigValue | undefined {
  if (param.type === 'ENUM' && param.valueList !== null && typeof raw === 'string') {
    const index = param.valueList.indexOf(raw)
    return index < 0 ? undefined : index
  }
  return parseEdit(param, raw)
}

/** The value as the operator reads it: the enum label, the unit, or `null` when there is none. */
export function valueText(param: ValueParam): string | null {
  if (!param.readable || param.value === null) return null
  if (typeof param.value === 'boolean') return null
  const shown = asEditable(param).value
  if (shown === null) return null
  return param.unit === null || param.unit === '' ? String(shown) : `${String(shown)} ${param.unit}`
}
