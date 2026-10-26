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
  tryConvertDelta,
  canConvertUnit,
  unitsForDimension,
} from './convert.js'
export type { UnitConversionReason } from './convert.js'
export {
  DEFAULT_DISPLAY_PREFERENCE,
  DISPLAY_PREFERENCES,
  QUANTITY_BASE,
  ReadingQuantitySchema,
  baseUnitOf,
  displayUnitFor,
  historyUnitFor,
  isReadingQuantity,
  readingMeta,
} from './quantity.js'
export type { DisplayPreference, ReadingMeta, ReadingQuantity } from './quantity.js'
export { thresholdToBase, thresholdToDisplay } from './threshold.js'
export { formatReading } from './format-reading.js'
export type { FormatReadingInput, FormattedReading } from './format-reading.js'
export { ingestReading, quantityFromUnit } from './ingest-reading.js'
export type { IngestReadingInput, IngestReadingResult, IngestRefusal } from './ingest-reading.js'
