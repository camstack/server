/**
 * One station slice from the outdoor group's live sensors — the same poll
 * that feeds the children. A sensor the station does not have stays null.
 */
import { ingestReading, type ReadingQuantity, type WeatherStationStatus } from '@camstack/types'

export type StationField = Exclude<keyof WeatherStationStatus, 'lastFetchedAt'>

export interface StationSensorSample {
  readonly id: string
  readonly quantity: string
  readonly name?: string | undefined
  readonly value: number | null
  readonly unit: string
  readonly lastUpdated: number
}

export interface StationRefusal {
  readonly sensorId: string
  readonly unit: string
  readonly reason: string
}

export interface StationSliceResult {
  readonly status: WeatherStationStatus
  readonly refused: readonly StationRefusal[]
}

const EMPTY: Record<StationField, null> = {
  temperature: null,
  humidity: null,
  pressure: null,
  windSpeed: null,
  windGust: null,
  windBearing: null,
  rainRate: null,
  rainDaily: null,
  rainEvent: null,
  uv: null,
  solarRadiation: null,
  dewPoint: null,
  feelsLike: null,
  vpd: null,
  windGustMax: null,
  windBearingAvg: null,
  rain24h: null,
  rainWeekly: null,
  rainMonthly: null,
  rainYearly: null,
}

/** Field-key → station field. A lower rank wins when two sensors share a field. */
const BY_KEY: Readonly<Record<string, { readonly field: StationField; readonly rank: number }>> = {
  tempf: { field: 'temperature', rank: 0 },
  humidity: { field: 'humidity', rank: 0 },
  baromrelin: { field: 'pressure', rank: 0 },
  baromabsin: { field: 'pressure', rank: 1 },
  '0x09': { field: 'pressure', rank: 0 },
  '0x08': { field: 'pressure', rank: 1 },
  windspeedmph: { field: 'windSpeed', rank: 0 },
  windgustmph: { field: 'windGust', rank: 0 },
  winddir: { field: 'windBearing', rank: 0 },
  rainratein: { field: 'rainRate', rank: 0 },
  rrain_piezo: { field: 'rainRate', rank: 1 },
  dailyrainin: { field: 'rainDaily', rank: 0 },
  drain_piezo: { field: 'rainDaily', rank: 1 },
  eventrainin: { field: 'rainEvent', rank: 0 },
  erain_piezo: { field: 'rainEvent', rank: 1 },
  uv: { field: 'uv', rank: 0 },
  solarradiation: { field: 'solarRadiation', rank: 0 },
  dewpoint: { field: 'dewPoint', rank: 0 },
  dewpointf: { field: 'dewPoint', rank: 0 },
  // Gateway hex ids (8E:<id>) of the same readings, plus the two decimal-string ids.
  '0x02': { field: 'temperature', rank: 0 },
  '0x07': { field: 'humidity', rank: 0 },
  '0x03': { field: 'dewPoint', rank: 0 },
  '3': { field: 'feelsLike', rank: 0 },
  '5': { field: 'vpd', rank: 0 },
  '0x0B': { field: 'windSpeed', rank: 0 },
  '0x0C': { field: 'windGust', rank: 0 },
  '0x19': { field: 'windGustMax', rank: 0 },
  maxdailygust: { field: 'windGustMax', rank: 0 },
  '0x0A': { field: 'windBearing', rank: 0 },
  '0x6D': { field: 'windBearingAvg', rank: 0 },
  winddir_avg10m: { field: 'windBearingAvg', rank: 1 },
  '0x15': { field: 'solarRadiation', rank: 0 },
  '0x17': { field: 'uv', rank: 0 },
  '0x0D': { field: 'rainEvent', rank: 0 },
  '0x0E': { field: 'rainRate', rank: 0 },
  '0x7C': { field: 'rain24h', rank: 0 },
  '0x10': { field: 'rainDaily', rank: 0 },
  '0x11': { field: 'rainWeekly', rank: 0 },
  weeklyrainin: { field: 'rainWeekly', rank: 0 },
  wrain_piezo: { field: 'rainWeekly', rank: 1 },
  '0x12': { field: 'rainMonthly', rank: 0 },
  monthlyrainin: { field: 'rainMonthly', rank: 0 },
  mrain_piezo: { field: 'rainMonthly', rank: 1 },
  '0x13': { field: 'rainYearly', rank: 0 },
  yearlyrainin: { field: 'rainYearly', rank: 0 },
  yrain_piezo: { field: 'rainYearly', rank: 1 },
}

const QUANTITY_OF: Readonly<Record<StationField, ReadingQuantity>> = {
  temperature: 'temperature',
  humidity: 'humidity',
  pressure: 'pressure',
  windSpeed: 'speed',
  windGust: 'speed',
  windBearing: 'angle',
  rainRate: 'precipitation-rate',
  rainDaily: 'precipitation',
  rainEvent: 'precipitation',
  uv: 'index',
  solarRadiation: 'irradiance',
  dewPoint: 'temperature',
  feelsLike: 'temperature',
  // A vapour-pressure deficit is stored in kPa, not the pressure base (hPa): see `storedValue`.
  vpd: 'none',
  windGustMax: 'speed',
  windBearingAvg: 'angle',
  rain24h: 'precipitation',
  rainWeekly: 'precipitation',
  rainMonthly: 'precipitation',
  rainYearly: 'precipitation',
}

function fieldKeyOf(sensorId: string): string {
  return sensorId.slice(sensorId.lastIndexOf(':') + 1)
}

/**
 * True when the sensor id names a reading the station slice carries by key. The station
 * is the owner of these readings and of their history, so no standalone sensor device is
 * kept for one. A sensor the key table does not know (battery, lightning, a channel) is not.
 */
export function isStationReadingSensorId(sensorId: string): boolean {
  return Object.prototype.hasOwnProperty.call(BY_KEY, fieldKeyOf(sensorId))
}

function fieldFromName(sensor: StationSensorSample): { field: StationField; rank: number } | null {
  const name = (sensor.name ?? '').toLowerCase()
  if (name.includes('dew')) return { field: 'dewPoint', rank: 2 }
  switch (sensor.quantity) {
    case 'temperature':
      return name.includes('indoor') ? null : { field: 'temperature', rank: 2 }
    case 'humidity':
      return name.includes('indoor') ? null : { field: 'humidity', rank: 2 }
    case 'pressure':
      return { field: 'pressure', rank: name.includes('absolute') ? 3 : 2 }
    case 'wind_speed':
      return name.includes('gust')
        ? { field: 'windGust', rank: 2 }
        : { field: 'windSpeed', rank: 2 }
    case 'wind_direction':
      return { field: 'windBearing', rank: 2 }
    case 'precipitation_rate':
      return { field: 'rainRate', rank: 2 }
    case 'precipitation':
      if (name.includes('daily')) return { field: 'rainDaily', rank: 2 }
      if (name.includes('event')) return { field: 'rainEvent', rank: 2 }
      return null
    case 'uv':
      return { field: 'uv', rank: 2 }
    case 'irradiance':
      return { field: 'solarRadiation', rank: 2 }
    default:
      return null
  }
}

function classify(sensor: StationSensorSample): { field: StationField; rank: number } | null {
  const keyed = BY_KEY[fieldKeyOf(sensor.id)]
  return keyed ?? fieldFromName(sensor)
}

function storedValue(
  sensor: StationSensorSample,
  field: StationField,
): { ok: true; value: number } | { ok: false; reason: string } | { ok: true; value: null } {
  if (sensor.value === null || !Number.isFinite(sensor.value)) return { ok: true, value: null }
  if (field === 'vpd') {
    // The series is kPa. Read it as a pressure (base hPa) so any pressure unit converts, then back.
    const hpa = ingestReading({
      value: sensor.value,
      rawUnit: sensor.unit.length > 0 ? sensor.unit : 'kPa',
      quantity: 'pressure',
    })
    return hpa.ok ? { ok: true, value: hpa.value / 10 } : { ok: false, reason: hpa.reason }
  }
  const result = ingestReading({
    value: sensor.value,
    rawUnit: sensor.unit.length > 0 ? sensor.unit : undefined,
    quantity: QUANTITY_OF[field],
  })
  if (!result.ok) return { ok: false, reason: result.reason }
  if (field === 'humidity') return { ok: true, value: Math.max(0, Math.min(100, result.value)) }
  return { ok: true, value: result.value }
}

/** The station slice. Unmapped readings stay null — never 0. */
export function stationSliceFromSensors(
  sensors: readonly StationSensorSample[],
): StationSliceResult {
  const grouped = new Map<StationField, StationSensorSample[]>()
  const ranks = new Map<string, number>()
  let lastFetchedAt = 0
  for (const sensor of sensors) {
    const hit = classify(sensor)
    if (hit === null) continue
    const list = grouped.get(hit.field) ?? []
    list.push(sensor)
    grouped.set(hit.field, list)
    ranks.set(sensor.id, hit.rank)
    if (sensor.lastUpdated > lastFetchedAt) lastFetchedAt = sensor.lastUpdated
  }
  const readings: Record<StationField, number | null> = { ...EMPTY }
  const refused: StationRefusal[] = []
  for (const [field, list] of grouped) {
    const ordered = [...list].sort((a, b) => (ranks.get(a.id) ?? 9) - (ranks.get(b.id) ?? 9))
    for (const sensor of ordered) {
      const stored = storedValue(sensor, field)
      if (!stored.ok) {
        refused.push({
          sensorId: sensor.id,
          unit: sensor.unit,
          reason: stored.reason,
        })
        continue
      }
      // A sensor with no value yet must not shadow a lower-ranked one that has one.
      if (stored.value === null) continue
      readings[field] = stored.value
      break
    }
  }
  return { status: { ...readings, lastFetchedAt }, refused }
}

/** Barometer keys of the gateway console (relative first); the station's own array may lack one. */
const GATEWAY_PRESSURE_KEYS: ReadonlySet<string> = new Set([
  'baromrelin',
  'baromabsin',
  '0x09',
  '0x08',
])

/** True for a barometer reading the gateway console itself carries. */
export function isGatewayPressureSensorId(sensorId: string): boolean {
  return GATEWAY_PRESSURE_KEYS.has(fieldKeyOf(sensorId))
}

/**
 * The station slice, with `pressure` borrowed from the gateway console's barometer (relative,
 * else absolute) when the station's own sensors carry none. The gateway sensors stay devices of
 * their own: this only reads them.
 */
export function stationSliceWithGatewayPressure(
  own: readonly StationSensorSample[],
  gateway: readonly StationSensorSample[],
): StationSliceResult {
  const result = stationSliceFromSensors(own)
  if (result.status.pressure !== null) return result
  const borrowed = stationSliceFromSensors(gateway.filter((s) => isGatewayPressureSensorId(s.id)))
  if (borrowed.status.pressure === null) return result
  return {
    status: {
      ...result.status,
      // lastFetchedAt stays the station's own clock: a gateway sample is not a station fetch.
      pressure: borrowed.status.pressure,
    },
    refused: [...result.refused, ...borrowed.refused],
  }
}
