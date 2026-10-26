import type { BatteryUnit, Quantity, SensorCategory } from '@apocaliss92/nodewitt'
import { DeviceRole, type ReadingQuantity } from '@camstack/types'

/**
 * Pure mapping from an Ecowitt {@link Quantity} to the camstack typed sensor cap
 * the accessory child registers. Unit-tested in isolation.
 *
 * Per the plan, the station is modelled as typed sensors (model A), NOT the
 * `weather` cap — a raw station never reports a sky-state `condition`, so the
 * `weather` cap's `condition` field would be permanently null.
 *
 * Presentation is split: the *cap* carries the raw value (a real typed cap for
 * temperature/humidity/pressure that the thermostat surface also consumes;
 * `numeric-sensor` — value + live unit + precision — for everything else), and
 * the *role* (see {@link roleForQuantity}) drives the icon/label/canonical
 * unit. Weather metrics (wind/rain/uv/irradiance) ride `numeric-sensor` + a
 * typed role — the same pattern HA uses for `battery`/`signal_strength` (a
 * typed role on the generic numeric cap). No per-metric cap is introduced.
 */
export type EcowittSensorCap =
  | 'temperature-sensor'
  | 'humidity-sensor'
  | 'pressure-sensor'
  | 'ambient-light-sensor'
  | 'numeric-sensor'

/**
 * Map an Ecowitt quantity to its camstack sensor cap. Pure, total.
 *
 * Only temperature/humidity/pressure get a dedicated typed cap (the thermostat
 * surface consumes them); every other quantity rides `numeric-sensor` and is
 * typed by its {@link roleForQuantity} role instead. Accepts a plain `string`
 * so a persisted config value flows through without a cast — any unrecognised
 * string falls to `numeric-sensor`, the same safe default the tail uses.
 */
export function capForQuantity(quantity: Quantity | string): EcowittSensorCap {
  switch (quantity) {
    case 'temperature':
      return 'temperature-sensor'
    case 'humidity':
      return 'humidity-sensor'
    case 'pressure':
      return 'pressure-sensor'
    // ── Everything else → generic numeric (unit/precision live in the slice);
    //    the typed DeviceRole supplies the icon/label/canonical unit. ──
    default:
      return 'numeric-sensor'
  }
}

/**
 * Map an Ecowitt quantity to the semantic {@link DeviceRole} that drives the
 * child's icon/label (and, in future, its canonical unit). Pure, total — an
 * unrecognised quantity falls to {@link DeviceRole.NumericSensor}.
 *
 * This is where weather metrics get their typing: wind/rain/uv/irradiance ride
 * the generic `numeric-sensor` cap but carry a typed role, so the UI renders a
 * wind / rain / UV / solar glyph instead of a bare hash.
 */
/** Ecowitt quantity → the stored reading quantity. Unknown names return null. */
export function readingQuantityFor(quantity: Quantity | string): ReadingQuantity | null {
  switch (quantity) {
    case 'temperature':
      return 'temperature'
    case 'humidity':
      return 'humidity'
    case 'pressure':
      return 'pressure'
    case 'wind_speed':
      return 'speed'
    case 'wind_direction':
      return 'angle'
    case 'precipitation':
      return 'precipitation'
    case 'precipitation_rate':
      return 'precipitation-rate'
    case 'uv':
      return 'index'
    case 'irradiance':
      return 'irradiance'
    case 'lightning_distance':
      return 'length'
    case 'lightning_count':
      return 'count'
    default:
      return null
  }
}

export function roleForQuantity(quantity: Quantity | string): DeviceRole {
  switch (quantity) {
    case 'temperature':
      return DeviceRole.TemperatureSensor
    case 'humidity':
      return DeviceRole.HumiditySensor
    case 'pressure':
      return DeviceRole.PressureSensor
    case 'wind_speed':
    case 'wind_direction':
      return DeviceRole.WindSensor
    case 'precipitation':
    case 'precipitation_rate':
      return DeviceRole.RainSensor
    case 'uv':
      return DeviceRole.UvSensor
    case 'irradiance':
      // Solar irradiance (W/m²) is a power-flux density, not photometric lux —
      // a solar-radiation role, distinct from ambient-light.
      return DeviceRole.SolarRadiationSensor
    case 'lightning_distance':
    case 'lightning_count':
    case 'vpd':
      return DeviceRole.NumericSensor
    default:
      return DeviceRole.NumericSensor
  }
}

/**
 * How a sensor's battery reading is surfaced as a cap, from its `batteryUnit`:
 *   - `'percent'` → typed `battery` cap (0..100), for a `'%'` battery.
 *   - `'voltage'` → `numeric-sensor` cap (unit `'V'`), for a `'V'` (raw-volts)
 *     battery — a voltage has no honest percentage, so the percentage-shaped
 *     `battery` cap is not used.
 *   - `'none'`    → no battery cap (the sensor reports no battery).
 */
export type EcowittBatteryMode = 'percent' | 'voltage' | 'none'

/**
 * Decide the battery cap form for a sensor's `batteryUnit`. Pure, total.
 * An absent unit (no battery) → `'none'`; any unexpected value also → `'none'`.
 */
export function batteryModeForUnit(unit: BatteryUnit | undefined): EcowittBatteryMode {
  if (unit === '%') return 'percent'
  if (unit === 'V') return 'voltage'
  return 'none'
}

/** The canonical "value" field name for a typed sensor cap's slice. */
export function valueFieldForCap(cap: EcowittSensorCap): string {
  switch (cap) {
    case 'temperature-sensor':
      return 'celsius'
    case 'humidity-sensor':
      return 'percent'
    case 'pressure-sensor':
      return 'hpa'
    case 'ambient-light-sensor':
      return 'lux'
    case 'numeric-sensor':
      return 'value'
  }
}

/**
 * Build a human label for a sensor. The label is resolved in priority order so
 * SAME-QUANTITY sensors are always distinguishable:
 *
 *   1. The SPECIFIC measurement `name` the library resolved from its hex-id
 *      table (e.g. "Outdoor Temperature", "Wind Gust") — present for the poll /
 *      hex-id path.
 *   2. A specific name derived from the raw gateway FIELD KEY (e.g. `dailyrainin`
 *      → "Daily Rain", `tempinf` → "Indoor Temperature") — covers the push /
 *      named-and-pattern-key path where the library leaves `name` absent and
 *      every same-quantity reading would otherwise collapse to one generic
 *      label (five rain readings all "Precipitation", indoor+outdoor temp both
 *      "Temperature", etc.). See {@link FIELD_KEY_LABEL}.
 *   3. The generic quantity label as a last resort.
 *
 * A channel suffix is appended when present (`temperature` + channel 2 →
 * `Temperature CH2`).
 *
 * `quantity`/`name` accept a plain `string` (not just {@link Quantity}) so a
 * persisted config value flows through without a cast; an unknown quantity falls
 * back to its raw string label. `sensorId` is the nodewitt `Sensor.id`
 * (`<owner>:<key>` or `<owner>:ch<n>:<key>`); the field key is its final
 * colon-segment.
 */
export function sensorLabel(
  quantity: Quantity | string,
  channel: number | undefined,
  name?: string,
  sensorId?: string,
): string {
  // The raw FIELD KEY is the authoritative source of a SPECIFIC name and is
  // tried first: a persisted `name` can be a STALE GENERIC label (discovery
  // stored `sensorLabel(...)` output before this table existed, so re-deriving
  // an already-adopted station would otherwise keep "Temperature"/"Precipitation"
  // for every same-quantity reading). Order: field-key → library/persisted name
  // → generic quantity label.
  const base =
    labelFromFieldKey(sensorId) ??
    (name !== undefined && name.length > 0
      ? name
      : isKnownQuantity(quantity)
        ? QUANTITY_LABEL[quantity]
        : quantity)
  return channel !== undefined ? `${base} CH${channel}` : base
}

/**
 * Resolve a specific human label from a nodewitt sensor id by extracting its raw
 * gateway field key (the final colon-segment of `<owner>[:ch<n>]:<key>`) and
 * looking it up in {@link FIELD_KEY_LABEL}. Returns `undefined` when no id is
 * given or the key is unrecognised, so the caller falls through to the generic
 * quantity label.
 */
function labelFromFieldKey(sensorId: string | undefined): string | undefined {
  if (sensorId === undefined) return undefined
  const key = sensorId.slice(sensorId.lastIndexOf(':') + 1)
  return Object.prototype.hasOwnProperty.call(FIELD_KEY_LABEL, key)
    ? FIELD_KEY_LABEL[key]
    : undefined
}

/**
 * Specific human labels for the raw Ecowitt gateway field keys that the library
 * classifies via its named / pattern tables (the push path) and therefore leaves
 * WITHOUT a `name`. Mirrors the vocabulary the library's hex-id table already
 * uses for the poll path, so a station reached over either transport reads the
 * same. Channel-suffixed keys (`temp3f`, `humidity2`, …) are handled by the
 * `channel` argument and intentionally omitted here.
 */
const FIELD_KEY_LABEL: Record<string, string> = {
  // ── Temperature ──
  tempinf: 'Indoor Temperature',
  tempf: 'Outdoor Temperature',
  // ── Humidity ──
  humidityin: 'Indoor Humidity',
  humidity: 'Outdoor Humidity',
  // ── Pressure ──
  baromrelin: 'Relative Pressure',
  baromabsin: 'Absolute Pressure',
  // ── Wind ──
  windspeedmph: 'Wind Speed',
  windgustmph: 'Wind Gust',
  maxdailygust: 'Max Daily Gust',
  winddir: 'Wind Direction',
  // ── Solar / UV ──
  solarradiation: 'Solar Radiation',
  uv: 'UV Index',
  // ── Lightning (WH57) ──
  lightning: 'Lightning Distance',
  lightning_num: 'Lightning Count',
  // ── Rain — tipping bucket ──
  rainratein: 'Rain Rate',
  eventrainin: 'Rain Event',
  hourlyrainin: 'Hourly Rain',
  dailyrainin: 'Daily Rain',
  weeklyrainin: 'Weekly Rain',
  monthlyrainin: 'Monthly Rain',
  yearlyrainin: 'Yearly Rain',
  totalrainin: 'Total Rain',
  // ── Rain — piezo (WS90) ──
  rrain_piezo: 'Rain Rate',
  erain_piezo: 'Rain Event',
  hrain_piezo: 'Hourly Rain',
  drain_piezo: 'Daily Rain',
  wrain_piezo: 'Weekly Rain',
  mrain_piezo: 'Monthly Rain',
  yrain_piezo: 'Yearly Rain',
}

/** Type guard: is `q` one of the known {@link Quantity} union members? */
function isKnownQuantity(q: string): q is Quantity {
  return Object.prototype.hasOwnProperty.call(QUANTITY_LABEL, q)
}

const QUANTITY_LABEL: Record<Quantity, string> = {
  temperature: 'Temperature',
  humidity: 'Humidity',
  pressure: 'Pressure',
  wind_speed: 'Wind speed',
  wind_direction: 'Wind direction',
  irradiance: 'Solar irradiance',
  uv: 'UV index',
  precipitation: 'Precipitation',
  precipitation_rate: 'Precipitation rate',
  lightning_distance: 'Lightning distance',
  lightning_count: 'Lightning count',
  vpd: 'VPD',
}

/**
 * The three logical devices a single Ecowitt gateway is split into. One physical
 * gateway/console hosts a heterogeneous set of sensors; rather than one giant
 * Container, we model three focused devices:
 *
 *   - `'gateway'`         — the console itself, its indoor readings, standalone
 *                           external sensors (lightning/rain/combo), AND every
 *                           channel add-on sensor that is NOT the CH1 temp sensor.
 *   - `'weather-station'` — the all-in-one outdoor array / wind-solar console.
 *   - `'temp-sensor-ch1'` — the CH1 channel sensor, split out on its own so the
 *                           common "primary" add-on (a WH31 temp/hum on channel 1)
 *                           is its own device.
 */
export type EcowittDeviceGroup = 'gateway' | 'weather-station' | 'temp-sensor-ch1'

/** All device groups, in stable presentation order. */
export const ECOWITT_DEVICE_GROUPS: readonly EcowittDeviceGroup[] = [
  'gateway',
  'weather-station',
  'temp-sensor-ch1',
] as const

/** Human label for a device group (used as the per-group Container name suffix). */
export function deviceGroupLabel(group: EcowittDeviceGroup): string {
  switch (group) {
    case 'gateway':
      return 'Gateway'
    case 'weather-station':
      return 'Weather Station'
    case 'temp-sensor-ch1':
      return 'Temp Sensor CH1'
  }
}

/**
 * Map a sensor's self-describing nodewitt {@link SensorCategory} (+ its channel)
 * to the camstack {@link EcowittDeviceGroup} it belongs to. Pure, total.
 *
 * The split:
 *   - `weather-station`              → `'weather-station'`.
 *   - `channel-sensor` with channel 1 → `'temp-sensor-ch1'` (the CH1 split-out).
 *   - everything else                → `'gateway'`.
 *
 * CH2..8 grouping (documented decision): channel-sensors on channels 2–8 are
 * deliberately grouped under `'gateway'`, NOT given their own group. The group
 * enum is intentionally a fixed THREE (the product wants exactly gateway /
 * weather-station / CH1-temp surfaces); the gateway device is the natural home
 * for "everything else" — it already owns the console's indoor readings and the
 * standalone external sensors. A per-channel device explosion (CH2…CH8 each their
 * own device) is out of scope here and can be layered on later by widening the
 * enum, without changing this function's `weather-station`/`temp-sensor-ch1`
 * branches. `external` (lightning/rain/combo) and `gateway` (console/indoor)
 * categories also fall here, by design.
 *
 * Accepts an optional `category` (a persisted/older sensor may lack one): an
 * absent category resolves to `'gateway'`, the same safe default nodewitt uses
 * for an unattributed reading.
 */
export function deviceGroupForSensor(
  category: SensorCategory | undefined,
  channel: number | undefined,
): EcowittDeviceGroup {
  if (category === 'weather-station') return 'weather-station'
  if (category === 'channel-sensor' && channel === 1) return 'temp-sensor-ch1'
  return 'gateway'
}
