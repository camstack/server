import { formatReading, type ReadingQuantity } from '@dominevo/types'
import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import { useUnitPreferences } from '../../../../contexts/unit-preferences'
import { preferenceForQuantity, type UnitPreferences } from '../../../../lib/unit-preferences'
import { type BottomRow, rowStats, rowTrend } from '../../shell/bottom-rows'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import { SCENE_DRAWING_CLASS } from '../../shell/scene-layout'
import { WeatherStationIllustration } from './WeatherStationIllustration'
import {
  anemometerSpinRate,
  stationCategories,
  stationCompassOf,
  stationModules,
  type StationCategoryId,
  type StationReadingId,
  type WeatherStationCardActions,
  type WeatherStationCardModel,
} from './model'

export interface WeatherStationCardProps {
  readonly model: WeatherStationCardModel
  readonly actions?: WeatherStationCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
  /** The primary trend line, drawn under the readings. */
  readonly trend?: ReactElement
}

const DASH = '—'

const READING_TEST_ID: Readonly<Record<StationReadingId, string>> = {
  temperature: 'dc-station-temp',
  humidity: 'dc-station-humidity',
  dew: 'dc-station-dew',
  speed: 'dc-station-wind',
  gust: 'dc-station-gust',
  bearing: 'dc-station-bearing',
  rate: 'dc-station-rain',
  daily: 'dc-station-rain-daily',
  event: 'dc-station-rain-event',
  solar: 'dc-station-solar',
  uv: 'dc-station-uv',
  pressure: 'dc-station-pressure',
}

function formatQuantity(
  value: number,
  quantity: ReadingQuantity,
  preferences: UnitPreferences,
  precision: number,
): string {
  const rendered = formatReading({
    value,
    quantity,
    precision,
    preference: preferenceForQuantity(preferences, quantity),
  })
  return rendered.unit.length === 0 ? rendered.text : `${rendered.text}${rendered.unit}`
}

function textOf(value: number | null, format: (n: number) => string): string {
  return value === null ? DASH : format(value)
}

function categoryLabel(id: StationCategoryId, t: UiTextFn): string {
  switch (id) {
    case 'climate':
      return t('uiLibrary.deviceCard.weatherStation.catClimate', 'Temperature & humidity')
    case 'wind':
      return t('uiLibrary.deviceCard.weatherStation.catWind', 'Wind')
    case 'rain':
      return t('uiLibrary.deviceCard.weatherStation.catRain', 'Rain')
    case 'sun':
      return t('uiLibrary.deviceCard.weatherStation.catSun', 'Sun')
    case 'pressure':
      return t('uiLibrary.deviceCard.weatherStation.catPressure', 'Pressure')
  }
}

function readingName(id: StationReadingId, t: UiTextFn): string {
  switch (id) {
    case 'temperature':
      return t('uiLibrary.deviceCard.weatherStation.temperature', 'Temperature')
    case 'humidity':
      return t('uiLibrary.deviceCard.weatherStation.humidity', 'Humidity')
    case 'dew':
      return t('uiLibrary.deviceCard.weatherStation.dewPoint', 'Dew point')
    case 'speed':
      return t('uiLibrary.deviceCard.weatherStation.speed', 'Speed')
    case 'gust':
      return t('uiLibrary.deviceCard.weatherStation.gust', 'Gust')
    case 'bearing':
      return t('uiLibrary.deviceCard.weatherStation.direction', 'Direction')
    case 'rate':
      return t('uiLibrary.deviceCard.weatherStation.rainRate', 'Rain')
    case 'daily':
      return t('uiLibrary.deviceCard.weatherStation.rainDaily', 'Today')
    case 'event':
      return t('uiLibrary.deviceCard.weatherStation.rainEvent', 'Event')
    case 'solar':
      return t('uiLibrary.deviceCard.weatherStation.solar', 'Solar')
    case 'uv':
      return t('uiLibrary.deviceCard.weatherStation.uv', 'UV')
    case 'pressure':
      return t('uiLibrary.deviceCard.weatherStation.pressure', 'Pressure')
  }
}

function readingValue(
  id: StationReadingId,
  value: number | null,
  preferences: UnitPreferences,
): string {
  switch (id) {
    case 'temperature':
    case 'dew':
      return textOf(value, (n) => formatQuantity(n, 'temperature', preferences, 1))
    case 'humidity':
      return textOf(value, (n) => `${Math.round(n)}%`)
    case 'speed':
    case 'gust':
      return textOf(value, (n) => formatQuantity(n, 'speed', preferences, 1))
    case 'bearing':
      return textOf(value, (n) => stationCompassOf(n))
    case 'rate':
      return textOf(value, (n) => formatQuantity(n, 'precipitation-rate', preferences, 1))
    case 'daily':
    case 'event':
      return textOf(value, (n) => formatQuantity(n, 'precipitation', preferences, 1))
    case 'solar':
      return textOf(value, (n) => formatQuantity(n, 'irradiance', preferences, 0))
    case 'uv':
      return textOf(value, (n) => String(Math.round(n * 10) / 10))
    case 'pressure':
      return textOf(value, (n) => formatQuantity(n, 'pressure', preferences, 0))
  }
}

/** One labelled row per category that has a reading, same rows as the energy card. */
function categoryRows(
  model: WeatherStationCardModel,
  t: UiTextFn,
  preferences: UnitPreferences,
): readonly BottomRow[] {
  return stationCategories(model).map((cat) =>
    rowStats(`station-${cat.id}`, {
      label: categoryLabel(cat.id, t),
      testId: `dc-station-cat-${cat.id}`,
      stats: cat.readings.map((reading) => ({
        id: reading.id,
        name: readingName(reading.id, t),
        value: readingValue(reading.id, reading.value, preferences),
        testId: READING_TEST_ID[reading.id],
      })),
    }),
  )
}

/**
 * One outdoor station: the mast draws the modules the readings support, and
 * the numbers sit in categories. A category with nothing to say is omitted;
 * a gap inside one that is drawn is a dash.
 */
export function WeatherStationCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
  trend,
}: WeatherStationCardProps): ReactElement {
  const t = useUiText()
  const preferences = useUnitPreferences()
  return (
    <DeviceCard
      kind="weather-station"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      state={{
        label: t('uiLibrary.deviceCard.weatherStation.state', 'Station'),
        since: model.since,
        tone: 'info',
      }}
      scene={{
        image: (
          <WeatherStationIllustration
            modules={stationModules(model)}
            spinRate={anemometerSpinRate(model.windSpeed)}
            bearing={model.windBearing}
            className={SCENE_DRAWING_CLASS}
          />
        ),
        bottom: [
          ...categoryRows(model, t, preferences),
          ...(trend === undefined ? [] : [rowTrend('trend', { trend })]),
        ],
      }}
    />
  )
}
