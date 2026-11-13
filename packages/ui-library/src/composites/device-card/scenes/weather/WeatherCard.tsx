import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { cn } from '../../../../lib/cn'
import { CardIcon } from '../../parts/CardIcon'
import { InfoTile } from '../../parts/InfoTile'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import {
  compassOf,
  kmhOf,
  type WeatherCardActions,
  type WeatherCardModel,
  type WeatherSky,
  weatherSkyOf,
} from './model'

export interface WeatherCardProps {
  readonly model: WeatherCardModel
  readonly actions?: WeatherCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

const SKY_TONE: Readonly<Record<WeatherSky, string>> = {
  sunny: 'text-warning',
  night: 'text-info',
  partlyCloudy: 'text-warning',
  cloudy: 'text-foreground-muted',
  rain: 'text-info',
  snow: 'text-info',
  fog: 'text-foreground-muted',
  wind: 'text-foreground-muted',
  storm: 'text-warning',
}

export function weatherConditionLabel(condition: string | null, t: UiTextFn): string {
  switch (condition) {
    case null:
      return t('uiLibrary.deviceCard.weather.unknown', 'No reading yet')
    case 'sunny':
      return t('uiLibrary.deviceCard.weather.sunny', 'Sunny')
    case 'clear-night':
      return t('uiLibrary.deviceCard.weather.clearNight', 'Clear night')
    case 'cloudy':
      return t('uiLibrary.deviceCard.weather.cloudy', 'Cloudy')
    case 'partlycloudy':
      return t('uiLibrary.deviceCard.weather.partlyCloudy', 'Partly cloudy')
    case 'rainy':
      return t('uiLibrary.deviceCard.weather.rain', 'Rain')
    case 'pouring':
      return t('uiLibrary.deviceCard.weather.pouring', 'Heavy rain')
    case 'snowy':
      return t('uiLibrary.deviceCard.weather.snow', 'Snow')
    case 'snowy-rainy':
      return t('uiLibrary.deviceCard.weather.sleet', 'Sleet')
    case 'fog':
      return t('uiLibrary.deviceCard.weather.fog', 'Fog')
    case 'windy':
    case 'windy-variant':
      return t('uiLibrary.deviceCard.weather.windy', 'Windy')
    case 'lightning':
    case 'lightning-rainy':
      return t('uiLibrary.deviceCard.weather.storm', 'Thunderstorm')
    case 'hail':
      return t('uiLibrary.deviceCard.weather.hail', 'Hail')
    case 'exceptional':
      return t('uiLibrary.deviceCard.weather.exceptional', 'Exceptional')
    default:
      return condition
  }
}

/**
 * A weather source: the temperature large on the left, the sky in the
 * middle, humidity, wind and pressure on the right — each only when the
 * provider reports it ("—" while it has not yet). It commands nothing.
 */
export function WeatherCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: WeatherCardProps): ReactElement {
  const t = useUiText()
  const sky = weatherSkyOf(model.condition)
  const wind =
    model.windSpeed === null
      ? null
      : `${Math.round(kmhOf(model.windSpeed))} km/h${model.windBearing === null ? '' : ` ${compassOf(model.windBearing)}`}`
  return (
    <DeviceCard
      kind="weather"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={sky}
      state={{
        label: weatherConditionLabel(model.condition, t),
        since: model.since,
        tone: 'info',
      }}
      scene={{
        left: (
          <b
            data-testid="dc-weather-temp"
            className="text-3xl font-semibold tabular-nums text-foreground"
          >
            {model.temperature === null ? '—' : `${model.temperature.toFixed(1)}°`}
          </b>
        ),
        image: <CardIcon glyph={sky} className={cn('h-20 w-20', SKY_TONE[sky])} />,
        right: (
          <div className="grid w-full gap-1.5">
            <InfoTile
              layout="side"
              glyph="humidity"
              label={t('uiLibrary.deviceCard.weather.humidity', 'Humidity')}
              value={model.humidity === null ? null : `${Math.round(model.humidity)}%`}
              testId="dc-weather-humidity"
            />
            <InfoTile
              layout="side"
              glyph="wind"
              label={t('uiLibrary.deviceCard.weather.wind', 'Wind')}
              value={wind}
              testId="dc-weather-wind"
            />
            <InfoTile
              layout="side"
              glyph="gauge"
              label={t('uiLibrary.deviceCard.weather.pressure', 'Pressure')}
              value={model.pressure === null ? null : `${Math.round(model.pressure)} hPa`}
              testId="dc-weather-pressure"
            />
          </div>
        ),
      }}
    />
  )
}
