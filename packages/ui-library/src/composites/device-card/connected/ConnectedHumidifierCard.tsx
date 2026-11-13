import type { HumidifierStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { HumidifierCard } from '../scenes/humidifier/HumidifierCard'
import { coarseDuration } from './coarse-duration'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import {
  humidifierActivityOf,
  humidifierModeLabel,
  humidifierModeOptions,
} from './humidifier-model'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/**
 * A humidifier or dehumidifier (`humidifier`): power, target humidity within
 * the device's range and mode — each only when the binding implements it.
 */
export function ConnectedHumidifierCard({
  deviceId,
  canActuate = true,
  orientation,
  optimistic = true,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(
    dev?.humidifier === undefined ? undefined : dev.state.humidifier,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<HumidifierStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.humidifier
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, {
    fail: card.fail,
    succeed: card.succeed,
  })
  const has = (method: string): boolean => card.implements('humidifier', method)
  const activity = humidifierActivityOf(display)
  const since =
    activity === 'off'
      ? coarseDuration(Date.now() - display.lastChangedAt, t)
      : display.mode === null
        ? null
        : humidifierModeLabel(display.mode, t)
  return (
    <HumidifierCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        activity,
        since,
        currentHumidity: display.currentHumidity,
        targetHumidity: display.targetHumidity,
        targetSettable: has('setTargetHumidity'),
        minHumidity: display.minHumidity,
        maxHumidity: display.maxHumidity,
        mode: display.mode,
        modes: has('setMode') ? humidifierModeOptions(display.availableModes, t) : [],
        power: has('setOn') ? display.on : null,
      }}
      actions={{
        ...card.actions,
        onPower: (on) => send({ on }, () => cap.setOn({ on })),
        onTarget: (humidity) =>
          send({ targetHumidity: humidity }, () => cap.setTargetHumidity({ humidity })),
        onMode: (mode) => send({ mode }, () => cap.setMode({ mode })),
      }}
    />
  )
}
