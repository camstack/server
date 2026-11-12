import type { WaterHeaterStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { WaterHeaterCard } from '../scenes/water-heater/WaterHeaterCard'
import { coarseDuration } from './coarse-duration'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'
import {
  WATER_HEATER_OFF_MODE,
  waterHeaterActivityOf,
  waterHeaterModeLabel,
  waterHeaterModeOptions,
  waterHeaterOnMode,
} from './water-heater-model'

/**
 * A water heater (`water-heater`): target within its range, operation mode,
 * away, and power through the `off` mode (back on in the last mode it ran) —
 * each only when the device declares it and the binding implements the method.
 */
export function ConnectedWaterHeaterCard({
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
    dev?.waterHeater === undefined ? undefined : dev.state.waterHeater,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<WaterHeaterStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.waterHeater
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, { fail: card.fail, succeed: card.succeed })
  const has = (method: string): boolean => card.implements('water-heater', method)
  const activity = waterHeaterActivityOf(display)
  const onMode = has('setOperationMode') ? waterHeaterOnMode(display) : null
  const setMode = (mode: string): void =>
    send({ operationMode: mode }, () => cap.setOperationMode({ mode }))
  const since =
    activity === 'off'
      ? coarseDuration(Date.now() - display.lastChangedAt, t)
      : activity === 'heat' || display.operationMode === null
        ? null
        : waterHeaterModeLabel(display.operationMode, t)
  return (
    <WaterHeaterCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        activity,
        since,
        currentTemp: display.currentTemp,
        targetTemp: display.targetTemp,
        targetSettable: has('setTargetTemp'),
        minTemp: display.minTemp,
        maxTemp: display.maxTemp,
        mode: display.operationMode,
        modes: has('setOperationMode') ? waterHeaterModeOptions(display.availableModes, t) : [],
        away: has('setAway') ? display.away : null,
        power: onMode === null ? null : activity !== 'off',
      }}
      actions={{
        ...card.actions,
        onPower: (on) => {
          const mode = on ? onMode : WATER_HEATER_OFF_MODE
          if (mode !== null) setMode(mode)
        },
        onTarget: (temp) => send({ targetTemp: temp }, () => cap.setTargetTemp({ temp })),
        onMode: setMode,
        onAway: (on) => send({ away: on }, () => cap.setAway({ on })),
      }}
    />
  )
}
