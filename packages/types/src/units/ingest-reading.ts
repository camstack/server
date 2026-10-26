/**
 * Convert an upstream number into the stored base of its quantity (D944 §4).
 * An unknown unit or a unit from another dimension is a refusal: the caller
 * logs it and publishes null (D393). This function never guesses.
 */
import { normalizeUnit } from '../device/source-info.js'
import { tryConvertUnit, unitDimension } from './convert.js'
import { type ReadingQuantity, baseUnitOf } from './quantity.js'
import type { UnitDimension } from './unit-table.js'

export type IngestRefusal = 'non-finite' | 'unknown-unit' | 'cross-dimension'

export interface IngestReadingInput {
  readonly value: number
  readonly rawUnit: string | undefined
  readonly quantity: ReadingQuantity
}

export type IngestReadingResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: IngestRefusal }

const DIMENSION_QUANTITY: Readonly<Record<UnitDimension, ReadingQuantity>> = {
  temperature: 'temperature',
  pressure: 'pressure',
  speed: 'speed',
  'precipitation-rate': 'precipitation-rate',
  length: 'length',
  area: 'area',
  illuminance: 'illuminance',
  irradiance: 'irradiance',
  power: 'power',
  'apparent-power': 'apparent-power',
  energy: 'energy',
  voltage: 'voltage',
  current: 'current',
  'concentration-volume': 'concentration-volume',
  'concentration-mass': 'concentration-mass',
  mass: 'mass',
  percentage: 'percentage',
  volume: 'volume',
  duration: 'duration',
  information: 'information',
  angle: 'angle',
  'sound-level': 'sound-level',
  'signal-level': 'signal-level',
  'colour-temperature': 'colour-temperature',
  bitrate: 'bitrate',
  rate: 'rate',
}

/**
 * Quantity implied by a unit symbol. `ppb` and `ms` are the two symbols
 * whose stored base is not the dimension's canonical unit. `mm` is length;
 * precipitation is chosen by the caller (a device class), not by the symbol.
 */
export function quantityFromUnit(rawUnit: string | undefined): ReadingQuantity | undefined {
  const unit = normalizeUnit(rawUnit)
  if (unit === undefined) return undefined
  if (unit === 'ppb') return 'concentration-ppb'
  if (unit === 'ms') return 'duration-ms'
  const dimension = unitDimension(unit)
  if (dimension === undefined) return undefined
  return DIMENSION_QUANTITY[dimension]
}

export function ingestReading(input: IngestReadingInput): IngestReadingResult {
  if (!Number.isFinite(input.value)) return { ok: false, reason: 'non-finite' }
  if (input.quantity === 'device') return { ok: false, reason: 'unknown-unit' }
  const raw = input.rawUnit?.trim()
  if (raw === undefined || raw.length === 0) return { ok: true, value: input.value }
  const unit = normalizeUnit(raw)
  if (unit === undefined) return { ok: false, reason: 'unknown-unit' }
  const base = baseUnitOf(input.quantity)
  if (base === undefined) {
    if (unitDimension(unit) !== undefined) return { ok: false, reason: 'cross-dimension' }
    return { ok: false, reason: 'unknown-unit' }
  }
  const converted = tryConvertUnit(input.value, unit, base)
  if (converted === undefined) {
    return unitDimension(unit) === undefined
      ? { ok: false, reason: 'unknown-unit' }
      : { ok: false, reason: 'cross-dimension' }
  }
  return { ok: true, value: converted }
}
