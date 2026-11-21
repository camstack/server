import type { ReactElement, ReactNode } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { type UiTextFn, useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { DeviceHistoryView } from '../../device-history/DeviceHistoryView'
import { useDeviceSeriesList } from '../../device-history/use-device-history'
import { CameraCard } from '../scenes/camera/CameraCard'
import { sinceText } from './since-text'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import type { CardHistory, CardState } from '../shell/model'
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

/** What a camera answered per generic cap; `undefined` is a cap it does not bind (D315). */
export interface CameraStateInputs {
  readonly battery: { readonly sleeping: boolean } | undefined
  readonly sleep: { readonly sleeping: boolean } | undefined
  readonly motion:
    | { readonly detected: boolean; readonly lastDetectedAt: number | null }
    | undefined
}

/**
 * The camera's state line, from generic caps only: asleep (`low-power-sleep`,
 * else the battery's own flag), motion now, else awake, with the time of the
 * last motion as the "since". Nothing is said about a fact the camera does not
 * answer.
 */
export function cameraStateOf(input: CameraStateInputs, now: number, t: UiTextFn): CardState {
  const { motion } = input
  const sleeping = input.sleep?.sleeping ?? input.battery?.sleeping
  if (sleeping === true) {
    return { label: t('uiLibrary.deviceCard.camera.asleep', 'Asleep'), since: null, tone: 'muted' }
  }
  if (motion?.detected === true) {
    return {
      label: t('uiLibrary.deviceCard.camera.motionNow', 'Motion now'),
      since: null,
      tone: 'warning',
    }
  }
  const since = motion === undefined ? undefined : sinceText(motion.lastDetectedAt, now, t)
  return {
    label: sleeping === false ? t('uiLibrary.deviceCard.camera.awake', 'Awake') : '',
    since:
      since === undefined
        ? null
        : t('uiLibrary.deviceCard.camera.motionSince', 'motion {{since}} ago', { since }),
    tone: 'primary',
  }
}

/**
 * The card of a camera: the base device card with the host's scene full width
 * and nothing over it. Its state line says asleep / motion / awake; battery,
 * the on-motion switch and the History view (opened from the state line, only
 * once device-history answered with a series, D315) come from the base card.
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
  const state = cameraStateOf({ battery, sleep, motion }, Date.now(), t)
  return (
    <CameraCard
      common={{ ...card.common, history }}
      state={state}
      scene={scene}
      showName={showName}
    />
  )
}
