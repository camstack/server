/**
 * Pure unit-conversion module. Re-exported from the types barrel so both the
 * render path and the future expression engine share one table.
 */
export { UNIT_TABLE } from './unit-table.js'
export type { UnitDimension, UnitSpec, KnownUnit } from './unit-table.js'
export {
  UnitConversionError,
  unitDimension,
  convertUnit,
  tryConvertUnit,
  canConvertUnit,
  unitsForDimension,
} from './convert.js'
export type { UnitConversionReason } from './convert.js'
