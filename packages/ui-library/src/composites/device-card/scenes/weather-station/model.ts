import type { CardCommon, CardCommonActions } from '../../shell/model'

/** Readings the station may report. Null means that sensor is absent. */
export interface StationReadings {
  readonly temperature: number | null
  readonly humidity: number | null
  readonly pressure: number | null
  readonly windSpeed: number | null
  readonly windGust: number | null
  readonly windBearing: number | null
  readonly rainRate: number | null
  readonly rainDaily: number | null
  readonly rainEvent: number | null
  readonly uv: number | null
  readonly solarRadiation: number | null
  readonly dewPoint: number | null
}

/** One physical outdoor station. */
export interface WeatherStationCardModel extends StationReadings {
  readonly common: CardCommon
  /** "updated 10 min ago". */
  readonly since: string | null
}

/** A station card commands nothing. */
export type WeatherStationCardActions = CardCommonActions

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** The eight-point compass word for a bearing. */
export function stationCompassOf(bearing: number): string {
  const index = Math.round((((bearing % 360) + 360) % 360) / 45) % COMPASS.length
  return COMPASS[index] ?? 'N'
}

/** Degrees clockwise from north, 0..360. Null when the vane has no bearing. */
export function stationBearingDeg(bearing: number | null): number | null {
  if (bearing === null || !Number.isFinite(bearing)) return null
  return ((bearing % 360) + 360) % 360
}

/** Cup revolutions per second for each metre per second of wind. */
export const ANEMOMETER_REVS_PER_MPS: number = 0.5

/**
 * How fast the cups turn. Zero when the wind is unknown, calm, or negative —
 * a higher speed is always a faster spin.
 */
export function anemometerSpinRate(windSpeed: number | null): number {
  if (windSpeed === null || !(windSpeed > 0)) return 0
  return windSpeed * ANEMOMETER_REVS_PER_MPS
}

/**
 * Sensor modules on the mast, in drawing order. Chosen from the readings the
 * station actually reports — never from the vendor.
 */
export const STATION_MODULE_ORDER = ['anemometer', 'vane', 'shield', 'rain', 'sun'] as const
export type StationModule = (typeof STATION_MODULE_ORDER)[number]

function hasWind(readings: StationReadings): boolean {
  return readings.windSpeed !== null || readings.windGust !== null || readings.windBearing !== null
}

function hasClimate(readings: StationReadings): boolean {
  return readings.temperature !== null || readings.humidity !== null || readings.dewPoint !== null
}

function hasRain(readings: StationReadings): boolean {
  return readings.rainRate !== null || readings.rainDaily !== null || readings.rainEvent !== null
}

function hasSun(readings: StationReadings): boolean {
  return readings.solarRadiation !== null || readings.uv !== null
}

export function stationModules(readings: StationReadings): readonly StationModule[] {
  const present: readonly (readonly [StationModule, boolean])[] = [
    ['anemometer', hasWind(readings)],
    ['vane', hasWind(readings)],
    ['shield', hasClimate(readings)],
    ['rain', hasRain(readings)],
    ['sun', hasSun(readings)],
  ]
  return present.flatMap(([id, on]) => (on ? [id] : []))
}

export const STATION_CATEGORY_ORDER = ['climate', 'wind', 'rain', 'sun', 'pressure'] as const
export type StationCategoryId = (typeof STATION_CATEGORY_ORDER)[number]

export type StationReadingId =
  | 'temperature'
  | 'humidity'
  | 'dew'
  | 'speed'
  | 'gust'
  | 'bearing'
  | 'rate'
  | 'daily'
  | 'event'
  | 'solar'
  | 'uv'
  | 'pressure'

export interface StationReadingSlot {
  readonly id: StationReadingId
  readonly value: number | null
}

export interface StationCategory {
  readonly id: StationCategoryId
  readonly readings: readonly StationReadingSlot[]
}

function category(
  id: StationCategoryId,
  readings: readonly StationReadingSlot[],
): StationCategory | null {
  if (readings.every((reading) => reading.value === null)) return null
  return { id, readings }
}

/** Categories that have at least one reading. A null slot stays, for the dash. */
export function stationCategories(readings: StationReadings): readonly StationCategory[] {
  const rows: readonly (StationCategory | null)[] = [
    category('climate', [
      { id: 'temperature', value: readings.temperature },
      { id: 'humidity', value: readings.humidity },
      { id: 'dew', value: readings.dewPoint },
    ]),
    category('wind', [
      { id: 'speed', value: readings.windSpeed },
      { id: 'gust', value: readings.windGust },
      { id: 'bearing', value: readings.windBearing },
    ]),
    category('rain', [
      { id: 'rate', value: readings.rainRate },
      { id: 'daily', value: readings.rainDaily },
      { id: 'event', value: readings.rainEvent },
    ]),
    category('sun', [
      { id: 'solar', value: readings.solarRadiation },
      { id: 'uv', value: readings.uv },
    ]),
    category('pressure', [{ id: 'pressure', value: readings.pressure }]),
  ]
  return rows.flatMap((row) => (row === null ? [] : [row]))
}
