/**
 * Shared resolution of a sensor's display string. The stored number is always
 * the quantity's base unit (D944 §4). A display preference (default metric)
 * or an operator override picks the label; the value is converted to match.
 */
import type { DeviceDisplayOverride, ReadingQuantity, RoleDisplayDefault } from '@camstack/types'
import {
  DEFAULT_DISPLAY_PREFERENCE,
  baseUnitOf,
  canConvertUnit,
  displayUnitFor,
  formatReading,
  normalizeUnit,
  tryConvertUnit,
  type DisplayPreference,
} from '@camstack/types'
import { formatNumeric } from './format-numeric'
import { preferenceForQuantity, type UnitPreferences } from './unit-preferences'

export interface SensorDisplayInput {
  /** Per-device override from the row (`DeviceInfo.display`). */
  readonly display?: DeviceDisplayOverride
  /** Cap name for `perCap` refinement (e.g. 'numeric-sensor'); undefined skips it. */
  readonly capName?: string
  /** Role default (`roleDisplayDefaults[device.role]`). */
  readonly roleDefault?: RoleDisplayDefault
  /** Quantity of the stored number. `device` reads `deviceQuantity`. */
  readonly quantity?: ReadingQuantity
  /** The device's chosen quantity when `quantity` is `device`. */
  readonly deviceQuantity?: ReadingQuantity
  /** Precision declared on the reading, when the operator has not overridden it. */
  readonly declarationPrecision?: number
  /** Read-time preference for this one reading. Wins over `unitPreferences`. */
  readonly preference?: DisplayPreference
  /** The user's unit preferences (`useUnitPreferences()`); metric and °C when absent. */
  readonly unitPreferences?: UnitPreferences
}

export interface ResolvedSensorDisplay {
  /** Display unit — `''` when the quantity has none. */
  readonly unit: string
  /** Display precision (int 0-10) or undefined for auto-format. */
  readonly precision: number | undefined
  /** Convert a base-unit value into the display unit. */
  readonly toDisplayValue: (raw: number) => number
  /** Convert a display-unit value back into the stored base. */
  readonly fromDisplayValue: (shown: number) => number
  /** Text and unit for one base-unit sample. */
  readonly format: (raw: number) => { readonly text: string; readonly unit: string }
}

function canonUnit(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  return normalizeUnit(raw) ?? raw
}

function concreteQuantity(input: SensorDisplayInput): ReadingQuantity | undefined {
  if (input.quantity === undefined) return undefined
  if (input.quantity === 'device') {
    const chosen = input.deviceQuantity
    if (chosen === undefined || chosen === 'device') return undefined
    return chosen
  }
  return input.quantity
}

export function resolveSensorDisplay(input: SensorDisplayInput): ResolvedSensorDisplay {
  const perCap = input.capName !== undefined ? input.display?.perCap?.[input.capName] : undefined
  const precision =
    perCap?.precision ??
    input.display?.precision ??
    input.roleDefault?.precision ??
    input.declarationPrecision

  const quantity = concreteQuantity(input)
  const preference =
    input.preference ??
    (input.unitPreferences === undefined
      ? DEFAULT_DISPLAY_PREFERENCE
      : preferenceForQuantity(input.unitPreferences, quantity))
  const base = quantity === undefined ? undefined : baseUnitOf(quantity)
  const preferred = quantity === undefined ? undefined : displayUnitFor(quantity, preference)
  const overrideUnit = canonUnit(perCap?.unit ?? input.display?.unit ?? input.roleDefault?.unit)
  const overrideOk =
    overrideUnit !== undefined &&
    base !== undefined &&
    overrideUnit !== base &&
    canConvertUnit(base, overrideUnit)
  const unit = overrideOk ? overrideUnit : (preferred ?? '')

  const scales = quantity === 'duration' || quantity === 'information' || quantity === 'duration-ms'

  const toDisplayValue = (raw: number): number => {
    if (scales || base === undefined || unit.length === 0 || unit === base) return raw
    return tryConvertUnit(raw, base, unit) ?? raw
  }

  const fromDisplayValue = (shown: number): number => {
    if (scales || base === undefined || unit.length === 0 || unit === base) return shown
    return tryConvertUnit(shown, unit, base) ?? shown
  }

  const format = (raw: number): { readonly text: string; readonly unit: string } => {
    if (quantity !== undefined && !overrideOk) {
      const rendered = formatReading({ value: raw, quantity, preference, precision })
      return { text: rendered.text, unit: rendered.unit }
    }
    return { text: formatNumeric(toDisplayValue(raw), precision), unit }
  }

  return { unit, precision, toDisplayValue, fromDisplayValue, format }
}
