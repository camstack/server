/**
 * Render a stored base-unit reading (D944 §4). The preference defaults to
 * metric. An operator override is applied by the caller via `convertUnit`
 * before this, or by passing the already-chosen display unit through
 * `resolveSensorDisplay` — this function is the quantity → string step.
 */
import { tryConvertUnit } from './convert.js'
import {
  DEFAULT_DISPLAY_PREFERENCE,
  type DisplayPreference,
  type ReadingQuantity,
  baseUnitOf,
  displayUnitFor,
} from './quantity.js'

export interface FormatReadingInput {
  readonly value: number
  readonly quantity: ReadingQuantity
  readonly preference?: DisplayPreference
  readonly precision?: number
  /** Concrete quantity when `quantity` is `device`. */
  readonly deviceQuantity?: ReadingQuantity
}

export interface FormattedReading {
  readonly text: string
  readonly unit: string
  readonly value: number
}

interface Scaled {
  readonly value: number
  readonly unit: string
}

const DURATION_STEPS: readonly Scaled[] = [
  { value: 86400, unit: 'd' },
  { value: 3600, unit: 'h' },
  { value: 60, unit: 'min' },
]

const INFO_STEPS: readonly { readonly factor: number; readonly unit: string }[] = [
  { factor: 1024 ** 4, unit: 'TiB' },
  { factor: 1024 ** 3, unit: 'GiB' },
  { factor: 1024 ** 2, unit: 'MiB' },
  { factor: 1024, unit: 'KiB' },
]

function formatMagnitude(value: number, precision: number | undefined): string {
  if (!Number.isFinite(value)) return ''
  if (precision !== undefined) return value.toFixed(precision)
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function scaleDuration(seconds: number): Scaled {
  const abs = Math.abs(seconds)
  for (const step of DURATION_STEPS) {
    if (abs >= step.value) return { value: seconds / step.value, unit: step.unit }
  }
  return { value: seconds, unit: 's' }
}

function scaleInformation(bytes: number): Scaled {
  const abs = Math.abs(bytes)
  for (const step of INFO_STEPS) {
    if (abs >= step.factor) return { value: bytes / step.factor, unit: step.unit }
  }
  return { value: bytes, unit: 'B' }
}

function resolvedQuantity(input: FormatReadingInput): ReadingQuantity {
  if (input.quantity === 'device') return input.deviceQuantity ?? 'none'
  return input.quantity
}

export function formatReading(input: FormatReadingInput): FormattedReading {
  const quantity = resolvedQuantity(input)
  const precision = input.precision
  if (!Number.isFinite(input.value)) {
    return { text: '', unit: '', value: input.value }
  }
  if (quantity === 'duration' || quantity === 'duration-ms') {
    const seconds = quantity === 'duration-ms' ? input.value / 1000 : input.value
    const scaled = scaleDuration(seconds)
    return {
      text: formatMagnitude(scaled.value, precision),
      unit: scaled.unit,
      value: scaled.value,
    }
  }
  if (quantity === 'information') {
    const scaled = scaleInformation(input.value)
    return {
      text: formatMagnitude(scaled.value, precision),
      unit: scaled.unit,
      value: scaled.value,
    }
  }
  const preference = input.preference ?? DEFAULT_DISPLAY_PREFERENCE
  const base = baseUnitOf(quantity)
  const display = displayUnitFor(quantity, preference)
  if (base === undefined || display === undefined) {
    return { text: formatMagnitude(input.value, precision), unit: '', value: input.value }
  }
  const converted = tryConvertUnit(input.value, base, display)
  if (converted === undefined) {
    return { text: formatMagnitude(input.value, precision), unit: base, value: input.value }
  }
  return { text: formatMagnitude(converted, precision), unit: display, value: converted }
}
