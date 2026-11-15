import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { WeatherStationCard } from '../scenes/weather-station/WeatherStationCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { sinceText } from './since-text'
import { PrimaryTrend } from './PrimaryTrend'
import { useCardCommon } from './use-card-common'

/** A physical weather station (`weather-station`): the outdoor readings. */
export function ConnectedWeatherStationCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const status = useDeviceStateSlice(
    dev === undefined || dev === null || dev.weatherStation === undefined
      ? undefined
      : dev.state.weatherStation,
  )
  if (status === undefined) return null
  return (
    <WeatherStationCard
      orientation={orientation}
      showName={showName}
      trend={<PrimaryTrend deviceId={deviceId} label={card.common.name} />}
      actions={card.actions}
      model={{
        common: card.common,
        since:
          sinceText(status.lastFetchedAt === 0 ? null : status.lastFetchedAt, Date.now(), t) ??
          null,
        temperature: status.temperature,
        humidity: status.humidity,
        pressure: status.pressure,
        windSpeed: status.windSpeed,
        windGust: status.windGust,
        windBearing: status.windBearing,
        rainRate: status.rainRate,
        rainDaily: status.rainDaily,
        rainEvent: status.rainEvent,
        uv: status.uv,
        solarRadiation: status.solarRadiation,
        dewPoint: status.dewPoint,
      }}
    />
  )
}
