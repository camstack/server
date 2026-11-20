import type { ReactElement, ReactNode } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { DeviceHistoryView } from '../../device-history/DeviceHistoryView'
import { useDeviceSeriesList } from '../../device-history/use-device-history'
import { CameraCard } from '../scenes/camera/CameraCard'
import { cameraChipsOf } from './camera-chips-model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import type { CardHistory } from '../shell/model'
import { useCardCommon } from './use-card-common'

export interface ConnectedCameraCardProps extends ConnectedCardProps {
  /**
   * The camera's live / snapshot view with its current play behaviour. The host
   * owns it (the admin device page mounts its stream panel), so the card embeds
   * the player a host already has instead of drawing a second one.
   */
  readonly scene: ReactNode
  /** Navigates inside the host app from a history chart's menu. */
  readonly onNavigate?: (path: string) => void
}

/**
 * The card of a camera: the host's scene full width, state chips from the
 * generic `battery`, `low-power-sleep` and `motion` caps over it, and the
 * device history behind a History button (the base card's bounded History view) — only once
 * device-history answered with a series (D315).
 */
export function ConnectedCameraCard({
  deviceId,
  canActuate = true,
  showName = true,
  scene,
  onNavigate,
}: ConnectedCameraCardProps): ReactElement {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const battery = useDeviceStateSlice(dev?.battery === undefined ? undefined : dev.state.battery)
  const sleep = useDeviceStateSlice(
    dev?.lowPowerSleep === undefined ? undefined : dev.state.lowPowerSleep,
  )
  const motion = useDeviceStateSlice(dev?.motion === undefined ? undefined : dev.state.motion)
  const series = useDeviceSeriesList(deviceId)
  const recorded =
    series.presence === 'present' &&
    series.list.status === 'ok' &&
    (series.list.data?.length ?? 0) > 0
  // Charts carry the host's navigation; the interactions list is the card's own.
  const history: CardHistory | null =
    recorded || card.common.history !== null
      ? {
          charts: recorded ? (
            <DeviceHistoryView
              deviceId={deviceId}
              {...(onNavigate === undefined ? {} : { onNavigate })}
            />
          ) : null,
          events: card.common.history?.events ?? null,
        }
      : null
  const chips = cameraChipsOf({ battery, sleep, motion }, Date.now(), t)
  return (
    <CameraCard
      common={card.common}
      chips={chips}
      scene={scene}
      showName={showName}
      history={history}
    />
  )
}
