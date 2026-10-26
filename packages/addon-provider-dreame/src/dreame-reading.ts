import {
  baseUnitOf,
  ingestReading,
  normalizeUnit,
  quantityFromUnit,
  tryConvertDelta,
  tryConvertUnit,
  type ReadingQuantity,
} from '@camstack/types'

/** Catalog unit → the quantity stored on the device. `times` is a count. */
export function dreameQuantity(unit: string | undefined): ReadingQuantity | null {
  if (unit === undefined || unit.length === 0) return 'none'
  if (unit === 'times') return 'count'
  const learned = quantityFromUnit(unit)
  if (learned === undefined || learned === 'device') return null
  return learned
}

/** Upstream number → base. A count ignores the word `times`. */
export function dreameToBase(
  value: number,
  unit: string | undefined,
  quantity: ReadingQuantity,
): number | null {
  const rawUnit = quantity === 'count' ? undefined : unit
  const result = ingestReading({ value, rawUnit, quantity })
  return result.ok ? result.value : null
}

/** Base number → the unit the robot still speaks. */
export function dreameToUpstream(
  value: number,
  unit: string | undefined,
  quantity: ReadingQuantity,
): number | null {
  const base = baseUnitOf(quantity)
  const upstream = unit === undefined ? undefined : normalizeUnit(unit)
  if (base === undefined || upstream === undefined || upstream === base) return value
  return tryConvertUnit(value, base, upstream) ?? null
}

/** A step is a difference, so an affine offset must not move it. */
export function dreameStep(
  step: number | undefined,
  unit: string | undefined,
  quantity: ReadingQuantity,
): number | undefined {
  if (step === undefined) return undefined
  const base = baseUnitOf(quantity)
  const from = unit === undefined ? undefined : normalizeUnit(unit)
  if (base === undefined || from === undefined || from === base) return step
  return tryConvertDelta(step, from, base)
}
