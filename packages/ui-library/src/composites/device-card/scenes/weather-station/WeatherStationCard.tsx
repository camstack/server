import { formatReading, type ReadingQuantity } from '@camstack/types'
import type { ReactElement } from 'react'
import { useUiText } from '../../../../contexts/ui-text'
import { useUnitPreferences } from '../../../../contexts/unit-preferences'
import { cn } from '../../../../lib/cn'
import { preferenceForQuantity, type UnitPreferences } from '../../../../lib/unit-preferences'
import { CardIcon } from '../../parts/CardIcon'
import { rowStats } from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_ICON_CLASS } from '../../shell/scene-layout'
import {
  stationCompassOf,
  type WeatherStationCardActions,
  type WeatherStationCardModel,
} from './model'

export interface WeatherStationCardProps {
  readonly model: WeatherStationCardModel
  readonly actions?: WeatherStationCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

interface StationStat {
  readonly id: string
  readonly name: string
  readonly value: string
  readonly testId: string
}

function formatStationReading(
  value: number | null,
  quantity: ReadingQuantity,
  preferences: UnitPreferences,
  precision: number,
): string | null {
  if (value === null) return null
  const rendered = formatReading({
    value,
    quantity,
    precision,
    preference: preferenceForQuantity(preferences, quantity),
  })
  return rendered.unit.length === 0 ? rendered.text : `${rendered.text}${rendered.unit}`
}

/**
 * One physical station: temperature large, the rest only when the station
 * reports them. A missing reading is an em dash on the primary row and is
 * omitted from the rest — never a zero.
 */
export function WeatherStationCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: WeatherStationCardProps): ReactElement {
  const t = useUiText()
  const preferences = useUnitPreferences()
  const temperature = formatStationReading(model.temperature, 'temperature', preferences, 1)
  const speed = formatStationReading(model.windSpeed, 'speed', preferences, 1)
  const gust = formatStationReading(model.windGust, 'speed', preferences, 1)
  const wind =
    speed === null && model.windBearing === null
      ? null
      : [speed ?? '—', model.windBearing === null ? null : stationCompassOf(model.windBearing)]
          .filter((part) => part !== null)
          .join(' ')
  const primary: StationStat[] = [
    {
      id: 'humidity',
      name: t('uiLibrary.deviceCard.weatherStation.humidity', 'Humidity'),
      value: model.humidity === null ? '—' : `${Math.round(model.humidity)}%`,
      testId: 'dc-station-humidity',
    },
    {
      id: 'wind',
      name: t('uiLibrary.deviceCard.weatherStation.wind', 'Wind'),
      value: wind ?? '—',
      testId: 'dc-station-wind',
    },
    {
      id: 'pressure',
      name: t('uiLibrary.deviceCard.weatherStation.pressure', 'Pressure'),
      value: formatStationReading(model.pressure, 'pressure', preferences, 0) ?? '—',
      testId: 'dc-station-pressure',
    },
  ]
  const extra: StationStat[] = []
  const rain = formatStationReading(model.rainRate, 'precipitation-rate', preferences, 1)
  const daily = formatStationReading(model.rainDaily, 'precipitation', preferences, 1)
  const eventRain = formatStationReading(model.rainEvent, 'precipitation', preferences, 1)
  const dew = formatStationReading(model.dewPoint, 'temperature', preferences, 1)
  const solar = formatStationReading(model.solarRadiation, 'irradiance', preferences, 0)
  if (gust !== null)
    extra.push({
      id: 'gust',
      name: t('uiLibrary.deviceCard.weatherStation.gust', 'Gust'),
      value: gust,
      testId: 'dc-station-gust',
    })
  if (rain !== null)
    extra.push({
      id: 'rain-rate',
      name: t('uiLibrary.deviceCard.weatherStation.rainRate', 'Rain'),
      value: rain,
      testId: 'dc-station-rain',
    })
  if (daily !== null)
    extra.push({
      id: 'rain-daily',
      name: t('uiLibrary.deviceCard.weatherStation.rainDaily', 'Today'),
      value: daily,
      testId: 'dc-station-rain-daily',
    })
  if (eventRain !== null)
    extra.push({
      id: 'rain-event',
      name: t('uiLibrary.deviceCard.weatherStation.rainEvent', 'Event'),
      value: eventRain,
      testId: 'dc-station-rain-event',
    })
  if (model.uv !== null)
    extra.push({
      id: 'uv',
      name: t('uiLibrary.deviceCard.weatherStation.uv', 'UV'),
      value: String(Math.round(model.uv * 10) / 10),
      testId: 'dc-station-uv',
    })
  if (solar !== null)
    extra.push({
      id: 'solar',
      name: t('uiLibrary.deviceCard.weatherStation.solar', 'Solar'),
      value: solar,
      testId: 'dc-station-solar',
    })
  if (dew !== null)
    extra.push({
      id: 'dew',
      name: t('uiLibrary.deviceCard.weatherStation.dewPoint', 'Dew point'),
      value: dew,
      testId: 'dc-station-dew',
    })
  return (
    <DeviceCard
      kind="weather-station"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity="cloudy"
      state={{
        label: t('uiLibrary.deviceCard.weatherStation.state', 'Station'),
        since: model.since,
        tone: 'info',
      }}
      scene={{
        image: (
          <span className="flex items-center justify-center gap-3">
            <b className="text-xl tabular-nums text-primary" data-testid="dc-station-temp">
              {temperature ?? '—'}
            </b>
            <CardIcon glyph="cloudy" className={cn(SCENE_ICON_CLASS, 'text-info')} />
          </span>
        ),
        bottom: [
          rowStats('readings', { stats: primary }),
          ...(extra.length === 0 ? [] : [rowStats('extra', { stats: extra })]),
        ],
      }}
    />
  )
}
