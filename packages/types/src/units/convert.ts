/**
 * Pure unit-conversion API over `UNIT_TABLE`. No dependencies, no side effects.
 *
 * Conversion is refused (throws `UnitConversionError`, or returns `undefined`
 * from the `try*` variant) whenever a unit is unknown or the two units belong
 * to different dimensions — cross-dimension conversion is deliberately
 * impossible so a render override can never make the value and its unit label
 * disagree.
 *
 * Callers pass units through `normalizeUnit` (`../device/source-info.ts`) BEFORE
 * calling here — the table keys only canonical spellings.
 */
import { UNIT_TABLE, type UnitDimension, type UnitSpec } from './unit-table.js'

/** Why a conversion could not be performed. */
export type UnitConversionReason = 'unknown-from' | 'unknown-to' | 'cross-dimension'

/** Thrown by `convertUnit` when a conversion is refused. Carries the offending
 *  units + a machine-readable `reason` for callers that branch on the cause. */
export class UnitConversionError extends Error {
  readonly from: string
  readonly to: string
  readonly reason: UnitConversionReason

  constructor(from: string, to: string, reason: UnitConversionReason) {
    super(`[units] cannot convert '${from}' → '${to}': ${reason}`)
    this.name = 'UnitConversionError'
    this.from = from
    this.to = to
    this.reason = reason
  }
}

/** Resolve a unit's `UnitSpec`, or `undefined` when the spelling is unknown. */
function specFor(unit: string): UnitSpec | undefined {
  return Object.hasOwn(UNIT_TABLE, unit) ? UNIT_TABLE[unit as keyof typeof UNIT_TABLE] : undefined
}

/** The dimension a unit belongs to, or `undefined` for an unknown unit. */
export function unitDimension(unit: string): UnitDimension | undefined {
  return specFor(unit)?.dimension
}

/** Value in `spec`'s unit → its dimension's canonical unit. */
function toCanonical(value: number, spec: UnitSpec): number {
  return value * spec.factor + spec.offset
}

/** Canonical-unit value → the unit described by `spec`. */
function fromCanonical(canonical: number, spec: UnitSpec): number {
  return (canonical - spec.offset) / spec.factor
}

/**
 * Convert `value` from unit `from` to unit `to`. Identity when `from === to`.
 * Throws `UnitConversionError` when either unit is unknown or the units belong
 * to different dimensions.
 */
export function convertUnit(value: number, from: string, to: string): number {
  if (from === to) return value
  const fromSpec = specFor(from)
  if (!fromSpec) throw new UnitConversionError(from, to, 'unknown-from')
  const toSpec = specFor(to)
  if (!toSpec) throw new UnitConversionError(from, to, 'unknown-to')
  if (fromSpec.dimension !== toSpec.dimension) {
    throw new UnitConversionError(from, to, 'cross-dimension')
  }
  return fromCanonical(toCanonical(value, fromSpec), toSpec)
}

/**
 * Graceful variant for the render path: returns the converted value, or
 * `undefined` when the conversion is refused (unknown unit / cross-dimension).
 * Never throws — a render caller falls back to the raw value + source unit.
 */
export function tryConvertUnit(value: number, from: string, to: string): number | undefined {
  if (from === to) return value
  const fromSpec = specFor(from)
  if (!fromSpec) return undefined
  const toSpec = specFor(to)
  if (!toSpec) return undefined
  if (fromSpec.dimension !== toSpec.dimension) return undefined
  return fromCanonical(toCanonical(value, fromSpec), toSpec)
}

/**
 * Whether `value` can be converted between `from` and `to` (same dimension,
 * both known). Cheap boolean probe for the UI's same-dimension unit picker and
 * the resolver's convertibility branch — compute ONCE so a unit label and its
 * value math can never disagree.
 */
export function canConvertUnit(from: string, to: string): boolean {
  if (from === to) return true
  const fromDim = unitDimension(from)
  if (fromDim === undefined) return false
  return fromDim === unitDimension(to)
}

/**
 * Every known unit spelling in a dimension (table insertion order — canonical
 * unit first). Powers the UI's same-dimension unit picker.
 */
export function unitsForDimension(dimension: UnitDimension): readonly string[] {
  const out: string[] = []
  for (const [unit, spec] of Object.entries(UNIT_TABLE)) {
    if (spec.dimension === dimension) out.push(unit)
  }
  return out
}
