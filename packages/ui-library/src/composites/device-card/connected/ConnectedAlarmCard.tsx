import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useDeviceCommand } from '../../../hooks/use-device-command'
import { AlarmCard } from '../scenes/alarm/AlarmCard'
import { alarmReadingOf } from './alarm-model'
import { coarseDuration } from './coarse-duration'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/**
 * An alarm panel (`alarm-panel`): the declared arm modes and Disarmed in one
 * row; the code, when the panel wants one, goes with the command and nowhere
 * else.
 */
export function ConnectedAlarmCard({
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
    dev?.alarmPanel === undefined ? undefined : dev.state.alarmPanel,
  )
  const display = slice
  const runCommand = useDeviceCommand()
  const cap = dev?.alarmPanel
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(runCommand, {
    fail: card.fail,
    succeed: card.succeed,
  })
  const reading = alarmReadingOf(display)
  return (
    <AlarmCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        activity: reading.activity,
        mode: reading.mode,
        since:
          display.lastChangedAt > 0 ? coarseDuration(Date.now() - display.lastChangedAt, t) : null,
        modes: display.availableModes,
        codeRequired: display.codeRequired,
        canArm: card.implements('alarm-panel', 'arm'),
        canDisarm: card.implements('alarm-panel', 'disarm'),
      }}
      actions={{
        ...card.actions,
        onArm: (mode, code) => send(() => cap.arm(code === null ? { mode } : { mode, code })),
        onDisarm: (code) => send(() => cap.disarm(code === null ? {} : { code })),
      }}
    />
  )
}
