import { formatReading, type ReadingQuantity } from '@camstack/types'
import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { useUnitPreferences } from '../../../../contexts/unit-preferences'
import { cn } from '../../../../lib/cn'
import { preferenceForQuantity, type UnitPreferences } from '../../../../lib/unit-preferences'
import { CardIcon } from '../../parts/CardIcon'
import { columnValue } from '../../shell/column-items'
import { rowStats } from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_ICON_CLASS } from '../../shell/scene-layout'
import {
  compassOf,
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

/** A base-unit reading in the signed-in user's units, symbol included. */
export function formatWeatherReading(
  value: number | null,
  quantity: ReadingQuantity,
  preferences: UnitPreferences,
): string | null {
  if (value === null) return null
  const rendered = formatReading({
    value,
    quantity,
    precision: 0,
    preference: preferenceForQuantity(preferences, quantity),
  })
  return rendered.unit.length === 0 ? rendered.text : `${rendered.text}${rendered.unit}`
}

/**
 * A weather source: the temperature large on the left, the sky in the
 * middle, humidity, wind and pressure on the right — each only when the
 * provider reports it ("—" while it has not yet). Units follow the signed-in
 * preferences. It commands nothing.
 */
export function WeatherCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: WeatherCardProps): ReactElement {
  const t = useUiText()
  const preferences = useUnitPreferences()
  const sky = weatherSkyOf(model.condition)
  const speed = formatWeatherReading(model.windSpeed, 'speed', preferences)
  const wind =
    speed === null
      ? null
      : `${speed}${model.windBearing === null ? '' : ` ${compassOf(model.windBearing)}`}`
  const temperature = formatWeatherReading(model.temperature, 'temperature', preferences)
  const pressure = formatWeatherReading(model.pressure, 'pressure', preferences)
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
        columns: {
          left: [
            columnValue('temperature', {
              value: temperature ?? '—',
              testId: 'dc-weather-temp',
            }),
          ],
        },
        image: <CardIcon glyph={sky} className={cn(SCENE_ICON_CLASS, SKY_TONE[sky])} />,
        bottom: [
          rowStats('readings', {
            stats: [
              {
                id: 'humidity',
                name: t('uiLibrary.deviceCard.weather.humidity', 'Humidity'),
                value: model.humidity === null ? '—' : `${Math.round(model.humidity)}%`,
                testId: 'dc-weather-humidity',
              },
              {
                id: 'wind',
                name: t('uiLibrary.deviceCard.weather.wind', 'Wind'),
                value: wind ?? '—',
                testId: 'dc-weather-wind',
              },
              {
                id: 'pressure',
                name: t('uiLibrary.deviceCard.weather.pressure', 'Pressure'),
                value: pressure ?? '—',
                testId: 'dc-weather-pressure',
              },
            ],
          }),
        ],
      }}
    />
  )
}
