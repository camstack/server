/**
 * Which units a person may pick for a number of a given quantity. The
 * quantity's stored base unit comes first (D944), then every other unit of the
 * same dimension in table order. A quantity with no unit (`none`, `count`,
 * `index`, `ratio`, `device`) offers nothing: the number is just a number.
 */
import { unitDimension, unitsForDimension } from './convert.js'
import { type ReadingQuantity, baseUnitOf } from './quantity.js'

/** The unit a reading of `quantity` is stored in, or `undefined` when it has none. */
export function baseUnitForQuantity(quantity: ReadingQuantity): string | undefined {
  return baseUnitOf(quantity)
}

/**
 * The units a person can enter a number of `quantity` in — base unit first.
 * Empty when the quantity carries no unit.
 */
export function unitsForQuantity(quantity: ReadingQuantity): readonly string[] {
  const base = baseUnitForQuantity(quantity)
  if (base === undefined) return []
  const dimension = unitDimension(base)
  if (dimension === undefined) return [base]
  return [base, ...unitsForDimension(dimension).filter((unit) => unit !== base)]
}
