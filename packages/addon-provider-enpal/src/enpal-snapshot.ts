/** One data point the box reported: its dotted key, a finite number, and where it came from. */
export interface EnpalReading {
  /** The dotted key the box's device page uses, e.g. `Power.DC.Total`. */
  readonly key: string
  readonly value: number
  /** Unit symbol after normalisation (`W`, `kWh`, `%`, `°C` ...), or undefined for a bare number. */
  readonly unit: string | undefined
  /** The Influx measurement or the device-page card the point sat in. */
  readonly measurement: string | undefined
}

export type EnpalSourceKind = 'influxdb' | 'device-page'

export type EnpalErrorKind =
  | 'unreachable'
  | 'timeout'
  | 'unauthorized'
  | 'token-missing'
  | 'bad-response'
  | 'empty'

/** Why the preferred source was not used when the snapshot came from the fallback. */
export interface EnpalFallbackReason {
  readonly kind: EnpalErrorKind
  readonly message: string
}

/** Every point the box reported in one poll. */
export interface EnpalSnapshot {
  readonly source: EnpalSourceKind
  readonly readings: ReadonlyMap<string, EnpalReading>
  /** Ms epoch of the poll. */
  readonly fetchedAt: number
  readonly fallbackReason?: EnpalFallbackReason
}

/**
 * Firmware 8.51 appended `.Inverter` to several inverter keys. Mapping them back keeps one
 * key per data point (the same table the Home Assistant component keeps).
 */
const KEY_ALIASES: Readonly<Record<string, string>> = {
  'Energy.Battery.Charge.Day.Inverter': 'Energy.Battery.Charge.Day',
  'Energy.Battery.Discharge.Day.Inverter': 'Energy.Battery.Discharge.Day',
  'Mode.Forcible.Charge.Discharge.Inverter': 'Mode.Forcible.Charge.Discharge',
  'Power.AC.Phase.A.Inverter': 'Power.AC.Phase.A',
  'Power.AC.Phase.B.Inverter': 'Power.AC.Phase.B',
  'Power.AC.Phase.C.Inverter': 'Power.AC.Phase.C',
  'Power.Battery.Charge.Discharge.Inverter': 'Power.Battery.Charge.Discharge',
  'Power.Battery.Charge.Max.Inverter': 'Power.Battery.Charge.Max',
  'Power.Battery.Discharge.Max.Inverter': 'Power.Battery.Discharge.Max',
}

export function canonicalKey(key: string): string {
  return KEY_ALIASES[key] ?? key
}

/**
 * Index readings by canonical key. The box writes some keys into two measurements: the first
 * occurrence wins.
 */
export function createSnapshot(
  source: EnpalSourceKind,
  readings: readonly EnpalReading[],
  fetchedAt: number,
  fallbackReason?: EnpalFallbackReason,
): EnpalSnapshot {
  const map = new Map<string, EnpalReading>()
  for (const reading of readings) {
    const key = canonicalKey(reading.key)
    if (map.has(key)) continue
    map.set(key, { ...reading, key })
  }
  return {
    source,
    readings: map,
    fetchedAt,
    ...(fallbackReason !== undefined ? { fallbackReason } : {}),
  }
}
