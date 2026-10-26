import { tryConvertUnit } from './convert.js'

/**
 * Move a threshold between the unit the operator sees and the stored base.
 * A failed conversion leaves the number unchanged — the recipe stays serialisable.
 */
export function thresholdToBase(value: number, displayUnit: string, baseUnit: string): number {
  if (!Number.isFinite(value) || displayUnit === baseUnit) return value
  return tryConvertUnit(value, displayUnit, baseUnit) ?? value
}

export function thresholdToDisplay(value: number, baseUnit: string, displayUnit: string): number {
  if (!Number.isFinite(value) || baseUnit === displayUnit) return value
  return tryConvertUnit(value, baseUnit, displayUnit) ?? value
}
