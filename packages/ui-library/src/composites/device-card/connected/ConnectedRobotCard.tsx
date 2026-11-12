import type { LawnMowerControlStatus, VacuumControlStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import type { CardCommon } from '../shell/model'
import { RobotCard } from '../scenes/robot/RobotCard'
import { coarseDuration } from './coarse-duration'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { mowerActivityOf, vacuumActivityOf } from './robot-model'
import { useCardCommon } from './use-card-common'
import { reportedCall, reportedCommand } from './use-command-notice'

const noop = (): void => undefined

/** The robot's own battery reading stands in when no `battery` cap reports one. */
function withBattery(common: CardCommon, level: number | null): CardCommon {
  if (common.battery !== null || level === null) return common
  return { ...common, battery: { level } }
}

/** A robot vacuum (`vacuum-control`): clean, pause, dock, locate, suction. */
export function ConnectedVacuumCard({
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
    dev?.vacuumControl === undefined ? undefined : dev.state.vacuumControl,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<VacuumControlStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.vacuumControl
  if (cap === undefined || display === undefined) return null
  const report = { fail: card.fail, succeed: card.succeed }
  const send = reportedCommand(applyOptimisticAction, report)
  const call = reportedCall(report)
  const speeds = display.availableFanSpeeds
  return (
    <RobotCard
      orientation={orientation}
      showName={showName}
      model={{
        common: withBattery(card.common, display.batteryLevel),
        mower: false,
        activity: vacuumActivityOf(display),
        errorLabel: display.state === 'error' ? display.errorLabel : null,
        since: coarseDuration(Date.now() - display.lastChangedAt, t),
        suction: speeds.length > 0 ? { options: speeds, value: display.fanSpeed } : null,
        progress: display.progress,
        controls: { start: true, pause: true, dock: true, locate: true },
        mapUrl: null,
      }}
      actions={{
        ...card.actions,
        onStart: () => send({ state: 'cleaning' }, () => cap.start({})),
        onPause: () => send({ state: 'paused' }, () => cap.pause({})),
        onDock: () => send({ state: 'returning' }, () => cap.returnToBase({})),
        onLocate: () => void call(() => cap.locate({})),
        onSuction: (speed) => send({ fanSpeed: speed }, () => cap.setFanSpeed({ speed })),
      }}
    />
  )
}

/** A robot mower (`lawn-mower-control`): mow, pause, dock; its code as the status line. */
export function ConnectedMowerCard({
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
    dev?.lawnMowerControl === undefined ? undefined : dev.state.lawnMowerControl,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<LawnMowerControlStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.lawnMowerControl
  if (cap === undefined || display === undefined) return null
  const report = { fail: card.fail, succeed: card.succeed }
  const send = reportedCommand(applyOptimisticAction, report)
  const call = reportedCall(report)
  const code = display.currentCodeLabel
  return (
    <RobotCard
      orientation={orientation}
      showName={showName}
      model={{
        common: withBattery(card.common, display.batteryLevel),
        mower: true,
        activity: mowerActivityOf(display),
        errorLabel: display.activity === 'error' ? code : null,
        since: code ?? coarseDuration(Date.now() - display.lastChangedAt, t),
        suction: null,
        progress: display.progress,
        controls: { start: true, pause: true, dock: true, locate: false },
        mapUrl: null,
      }}
      actions={{
        ...card.actions,
        onStart: () => send({ activity: 'mowing' }, () => cap.startMowing({})),
        onPause: () => send({ activity: 'paused' }, () => cap.pause({})),
        // No `returning` activity in the cap: the mower reports docked only once it is.
        onDock: () => void call(() => cap.dock({})),
        onLocate: noop,
        onSuction: noop,
      }}
    />
  )
}
