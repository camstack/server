/**
 * The pure half of {@link QuantityValueInput} (D972).
 *
 * A number tied to a quantity is STORED in one unit (the quantity base for a
 * reading, the declared unit for a method param) and ENTERED in the unit the
 * person picks. A stored number is never converted again on save: the picked
 * unit is a separate field, so these helpers convert only for display and for
 * the moment a new number is typed.
 */
import {
  type QuantityValue,
  type ReadingQuantity,
  baseUnitForQuantity,
  convertQuantityInput,
  tryConvertUnit,
  unitsForQuantity,
} from '@camstack/types'

/** A number held in its stored unit, with the unit the person picked for it. */
export interface StoredQuantity {
  /** In the stored unit. */
  readonly value: number
  /** The unit the person picked (display only). */
  readonly unit: string
}

export interface QuantityBounds {
  readonly min?: number
  readonly max?: number
}

/** 12 significant digits: far finer than an instrument, hides float noise (0.1 kg to 100 g). */
function tidy(value: number): number {
  return Number(value.toPrecision(12))
}

/** The units a person may pick for `quantity`, stored base first. */
export function quantityUnitChoices(quantity: ReadingQuantity): readonly string[] {
  return unitsForQuantity(quantity)
}

/** The unit a quantity's readings are stored in. */
export function quantityStoredUnit(quantity: ReadingQuantity): string | undefined {
  return baseUnitForQuantity(quantity)
}

/** Is `unit` one the person can pick for `quantity`? */
export function isPickableUnit(quantity: ReadingQuantity, unit: string | undefined): boolean {
  return unit !== undefined && unitsForQuantity(quantity).includes(unit)
}

/**
 * A stored number shown in the unit the person picked. A unit that cannot be
 * converted to (unknown, another dimension) shows the number as stored.
 */
export function storedToPicked(stored: number, storedUnit: string, picked: string): number {
  if (picked === storedUnit) return stored
  const converted = tryConvertUnit(stored, storedUnit, picked)
  return converted === undefined ? stored : tidy(converted)
}

/** What a person typed (`{ value, unit }`), brought to the stored unit. Throws `QuantityUnitError`. */
export function typedToStored(typed: QuantityValue, storedUnit: string): StoredQuantity {
  return {
    value: convertQuantityInput({ value: typed.value, unit: typed.unit, target: storedUnit }),
    unit: typed.unit,
  }
}

/** Bounds declared in the stored unit, expressed in the picked unit. */
export function boundsInPicked(
  bounds: QuantityBounds,
  storedUnit: string,
  picked: string,
): QuantityBounds {
  return {
    ...(bounds.min === undefined ? {} : { min: storedToPicked(bounds.min, storedUnit, picked) }),
    ...(bounds.max === undefined ? {} : { max: storedToPicked(bounds.max, storedUnit, picked) }),
  }
}

/** Is a stored number outside the bounds (both in the stored unit)? */
export function outsideBounds(value: number | undefined, bounds: QuantityBounds): boolean {
  if (value === undefined) return false
  if (bounds.min !== undefined && value < bounds.min) return true
  return bounds.max !== undefined && value > bounds.max
}
