import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { WeatherCard } from '../scenes/weather/WeatherCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { sinceText } from './since-text'
import { useCardCommon } from './use-card-common'

/**
 * A weather source (`weather`): today's reading. The cap carries no forecast,
 * apparent temperature, rain or UV, so the card draws none of them.
 */
export function ConnectedWeatherCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const status = useDeviceStateSlice(dev?.weather === undefined ? undefined : dev.state.weather)
  if (status === undefined) return null
  return (
    <WeatherCard
      orientation={orientation}
      showName={showName}
      actions={card.actions}
      model={{
        common: card.common,
        condition: status.condition,
        since:
          sinceText(status.lastFetchedAt === 0 ? null : status.lastFetchedAt, Date.now(), t) ??
          null,
        temperature: status.temperature,
        humidity: status.humidity,
        pressure: status.pressure,
        windSpeed: status.windSpeed,
        windBearing: status.windBearing,
      }}
    />
  )
}
