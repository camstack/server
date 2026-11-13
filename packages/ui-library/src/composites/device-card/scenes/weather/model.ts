import type { CardCommon, CardCommonActions } from '../../shell/model'

/** The sky the card draws; a condition the card does not know draws as `cloudy`. */
export type WeatherSky =
  | 'sunny'
  | 'night'
  | 'partlyCloudy'
  | 'cloudy'
  | 'rain'
  | 'snow'
  | 'fog'
  | 'wind'
  | 'storm'

export interface WeatherCardModel {
  readonly common: CardCommon
  /** The condition as the provider names it (`sunny`, `partlycloudy`); null when none yet. */
  readonly condition: string | null
  /** "updated 10 min ago". */
  readonly since: string | null
  /** °C; null when not reported. */
  readonly temperature: number | null
  /** %; null when not reported. */
  readonly humidity: number | null
  /** hPa; null when not reported. */
  readonly pressure: number | null
  /** m/s; null when not reported. */
  readonly windSpeed: number | null
  /** Degrees, meteorological (where it blows from); null when not reported. */
  readonly windBearing: number | null
}

/** A weather card commands nothing: only the shell's actions. */
export type WeatherCardActions = CardCommonActions

/** The sky drawn for a provider's condition word. */
export function weatherSkyOf(condition: string | null): WeatherSky {
  switch (condition) {
    case 'sunny':
      return 'sunny'
    case 'clear-night':
      return 'night'
    case 'partlycloudy':
      return 'partlyCloudy'
    case 'rainy':
    case 'pouring':
      return 'rain'
    case 'snowy':
    case 'snowy-rainy':
    case 'hail':
      return 'snow'
    case 'fog':
      return 'fog'
    case 'windy':
    case 'windy-variant':
      return 'wind'
    case 'lightning':
    case 'lightning-rainy':
      return 'storm'
    default:
      return 'cloudy'
  }
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'] as const

/** The eight-point compass word for a bearing. */
export function compassOf(bearing: number): string {
  const index = Math.round((((bearing % 360) + 360) % 360) / 45) % COMPASS.length
  return COMPASS[index] ?? 'N'
}

/** m/s to km/h. */
export function kmhOf(metresPerSecond: number): number {
  return metresPerSecond * 3.6
}
