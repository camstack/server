import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useDeviceCommand } from '../../../hooks/use-device-command'
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
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(
    dev?.waterHeater === undefined ? undefined : dev.state.waterHeater,
  )
  const display = slice
  const runCommand = useDeviceCommand()
  const cap = dev?.waterHeater
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(runCommand, {
    fail: card.fail,
    succeed: card.succeed,
  })
  const has = (method: string): boolean => card.implements('water-heater', method)
  const activity = waterHeaterActivityOf(display)
  const onMode = has('setOperationMode') ? waterHeaterOnMode(display) : null
  const setMode = (mode: string): void => send(() => cap.setOperationMode({ mode }))
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
        onTarget: (temp) => send(() => cap.setTargetTemp({ temp })),
        onMode: setMode,
        onAway: (on) => send(() => cap.setAway({ on })),
      }}
    />
  )
}
