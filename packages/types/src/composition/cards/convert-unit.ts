/**
 * Other units a numeric field can be published as. The field's unit meta
 * names the native unit; the list is every other unit in that dimension.
 */
import { canConvertUnit, unitDimension, unitsForDimension } from '../../units/convert.js'

export function convertUnitTargets(from: string): readonly string[] {
  const dimension = unitDimension(from)
  if (dimension === undefined) return []
  return unitsForDimension(dimension).filter((unit) => unit !== from && canConvertUnit(from, unit))
}
