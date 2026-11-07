/**
 * Dependency-free unit conversion entry (`@camstack/types/units-lean`).
 *
 * The device-template render worker (a worker thread of the hub) converts a
 * reading with the SAME table and arithmetic as every other render path, and
 * must not load the schema barrel to do it. This entry carries the table and
 * the conversion, nothing else — no zod, no capability definitions.
 */
export { UNIT_TABLE } from './units/unit-table.js'
export type { UnitDimension, UnitSpec } from './units/unit-table.js'
export { tryConvertUnit, unitDimension } from './units/convert.js'
