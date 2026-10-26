/**
 * A numeric reading is stored in the base unit of its quantity (D944 §4).
 * The base symbol lives here — never as a sibling field on the device slice.
 *
 * `energy` is stored in kWh even though `UNIT_TABLE`'s linear origin is Wh:
 * history, Matter and the field name already count kilowatt-hours.
 * `concentration-ppb` is separate so VOC parts-per-billion are not divided
 * by 1000 into ppm. `device` is a polymorphic reading (numeric-sensor,
 * numeric control): the quantity is chosen once, on the device, at adopt.
 */
import { z } from 'zod'

const READING_QUANTITY_VALUES = [
  'temperature',
  'pressure',
  'speed',
  'precipitation',
  'precipitation-rate',
  'length',
  'area',
  'illuminance',
  'irradiance',
  'power',
  'energy',
  'voltage',
  'current',
  'apparent-power',
  'humidity',
  'percentage',
  'concentration-volume',
  'concentration-mass',
  'concentration-ppb',
  'volume',
  'duration',
  'duration-ms',
  'information',
  'sound-level',
  'signal-level',
  'colour-temperature',
  'angle',
  'bitrate',
  'rate',
  'mass',
  'index',
  'ratio',
  'count',
  'none',
  'device',
] as const

export const READING_QUANTITIES: typeof READING_QUANTITY_VALUES = READING_QUANTITY_VALUES

export type ReadingQuantity = (typeof READING_QUANTITIES)[number]

const readingQuantitySchemaValue = z.enum(READING_QUANTITIES)
export const ReadingQuantitySchema: z.ZodType<ReadingQuantity> = readingQuantitySchemaValue

const QUANTITY_SET: ReadonlySet<string> = new Set(READING_QUANTITIES)

export function isReadingQuantity(value: unknown): value is ReadingQuantity {
  return typeof value === 'string' && QUANTITY_SET.has(value)
}

/**
 * Stored unit symbol for a quantity. `none` means the number is dimensionless
 * (or an index / ratio / count). `device` means the cap has no single unit.
 */
export const QUANTITY_BASE: Readonly<Record<ReadingQuantity, string>> = {
  temperature: '°C',
  pressure: 'hPa',
  speed: 'm/s',
  precipitation: 'mm',
  'precipitation-rate': 'mm/h',
  length: 'm',
  area: 'm²',
  illuminance: 'lx',
  irradiance: 'W/m²',
  power: 'W',
  energy: 'kWh',
  voltage: 'V',
  current: 'A',
  'apparent-power': 'VA',
  humidity: '%',
  percentage: '%',
  'concentration-volume': 'ppm',
  'concentration-mass': 'µg/m³',
  'concentration-ppb': 'ppb',
  volume: 'L',
  duration: 's',
  'duration-ms': 'ms',
  information: 'B',
  'sound-level': 'dBFS',
  'signal-level': 'dBm',
  'colour-temperature': 'mired',
  angle: '°',
  bitrate: 'kbps',
  rate: 'fps',
  mass: 'kg',
  index: 'none',
  ratio: 'none',
  count: 'none',
  none: 'none',
  device: 'device',
}

/** The stored unit, or `undefined` when the quantity has no unit symbol. */
export function baseUnitOf(quantity: ReadingQuantity): string | undefined {
  const symbol = QUANTITY_BASE[quantity]
  if (symbol === 'none' || symbol === 'device') return undefined
  return symbol
}

/**
 * History catalog label for a quantity. Index and ratio keep the labels the
 * series already used (`count`, `ratio`). A polymorphic reading has no
 * single label.
 */
export function historyUnitFor(quantity: ReadingQuantity): string | undefined {
  if (quantity === 'index' || quantity === 'count') return 'count'
  if (quantity === 'ratio') return 'ratio'
  return baseUnitOf(quantity)
}

/** Zod `.meta()` bag for a numeric reading. Precision is a display hint. */
export type ReadingMeta = {
  readonly [key: string]: unknown
  readonly quantity: ReadingQuantity
  readonly precision?: number
  readonly label?: string
}

export function readingMeta(
  quantity: ReadingQuantity,
  extras?: { readonly precision?: number; readonly label?: string },
): ReadingMeta {
  return {
    quantity,
    ...(extras?.precision !== undefined ? { precision: extras.precision } : {}),
    ...(extras?.label !== undefined ? { label: extras.label } : {}),
  }
}

/** Imperial display symbol when it differs from the stored base. */
const IMPERIAL_DISPLAY: Partial<Readonly<Record<ReadingQuantity, string>>> = {
  temperature: '°F',
  pressure: 'inHg',
  speed: 'mph',
  precipitation: 'in',
  'precipitation-rate': 'in/h',
  length: 'ft',
  volume: 'gal',
}

const DISPLAY_PREFERENCE_VALUES = ['metric', 'imperial'] as const
export const DISPLAY_PREFERENCES: typeof DISPLAY_PREFERENCE_VALUES = DISPLAY_PREFERENCE_VALUES
export type DisplayPreference = (typeof DISPLAY_PREFERENCES)[number]

export const DEFAULT_DISPLAY_PREFERENCE: DisplayPreference = 'metric'

/** Display symbol for a preference. Duration and information are scaled by the formatter. */
export function displayUnitFor(
  quantity: ReadingQuantity,
  preference: DisplayPreference,
): string | undefined {
  const base = baseUnitOf(quantity)
  if (base === undefined) return undefined
  if (preference === 'imperial') {
    const imperial = IMPERIAL_DISPLAY[quantity]
    if (imperial !== undefined) return imperial
  }
  return base
}
