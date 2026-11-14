import type { CardCommon, CardCommonActions } from '../../shell/model'

/** One station reading. Null means the station does not report it. */
export interface WeatherStationCardModel {
  readonly common: CardCommon
  /** "updated 10 min ago". */
  readonly since: string | null
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

/** A station card commands nothing. */
export type WeatherStationCardActions = CardCommonActions

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** The eight-point compass word for a bearing. */
export function stationCompassOf(bearing: number): string {
  const index = Math.round((((bearing % 360) + 360) % 360) / 45) % COMPASS.length
  return COMPASS[index] ?? 'N'
}
