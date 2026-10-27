import { ingestReading, type IngestRefusal, type ReadingQuantity } from '@camstack/types'

/**
 * The box's InfluxDB `unit` tag, as written (including the box's own spelling
 * `Celcius`), to the unit symbol the shared unit table knows. `None` and a blank
 * tag mean a dimensionless number.
 */
const UNIT_TAGS: Readonly<Record<string, string | undefined>> = {
  Percent: '%',
  Celcius: '°C',
  Celsius: '°C',
  None: undefined,
  '': undefined,
}

/** Normalise a raw unit tag or page suffix to a unit symbol, or undefined. */
export function normalizeEnpalUnit(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  const trimmed = raw.trim()
  if (Object.prototype.hasOwnProperty.call(UNIT_TAGS, trimmed)) return UNIT_TAGS[trimmed]
  return trimmed
}

export type EnpalConversion =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: IngestRefusal }

/**
 * A reading in the stored base of `quantity` (W, kWh, V, A, %, °C ...). Wh becomes
 * kWh and kW becomes W here, at the edge. An unknown unit or one of another
 * dimension is a refusal, never a guessed number (D393).
 */
export function toBase(
  value: number,
  unit: string | undefined,
  quantity: ReadingQuantity,
): EnpalConversion {
  return ingestReading({ value, rawUnit: unit, quantity })
}
