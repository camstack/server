import { DeviceType, timedRunLimitOf, timedRunMaxIn } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { PlugCard } from '../scenes/plug/PlugCard'
import type { PlugTimer } from '../scenes/plug/model'
import type { CardOrientation } from '../shell/model'
import { coarseDuration } from './coarse-duration'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

export interface ConnectedCardProps {
  readonly deviceId: number
  /** False when the viewer may look but not command (default: true). */
  readonly canActuate?: boolean
  readonly orientation?: CardOrientation
  /** Show a command's effect before the device confirms it (default: true). */
  readonly optimistic?: boolean
  /** Draw the device name (default true); false when the host already names the device. */
  readonly showName?: boolean
}

const DEVICE_TYPES: ReadonlySet<string> = new Set(Object.values(DeviceType))
const isDeviceType = (value: string): value is DeviceType => DEVICE_TYPES.has(value)

/** The plug card of a real device: `switch`, and `timed-run` when the device binds it. */
export function ConnectedPlugCard({
  deviceId,
  canActuate = true,
  orientation,
  optimistic = true,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const { common, actions, deviceType, role, fail, succeed } = useCardCommon({
    deviceId,
    canActuate,
  })
  const slice = useDeviceStateSlice(dev?.state.switch)
  const run = useDeviceStateSlice(dev?.timedRun === undefined ? undefined : dev.state.timedRun)
  const { display, applyOptimisticAction } = useOptimisticSlice(slice, {
    enabled: optimistic,
  })
  const cap = dev?.switch
  if (cap === undefined || display === undefined) return null

  const limit =
    deviceType !== null && isDeviceType(deviceType) ? timedRunLimitOf(deviceType, role) : null
  const timedRun = dev?.timedRun
  const timer: PlugTimer | null =
    timedRun === undefined || run === undefined || limit === null || limit.unit !== 'min'
      ? null
      : {
          defaultMinutes:
            run.quickRun?.unit === 'min' ? run.quickRun.duration : limit.quickRunDefault,
          maxMinutes: timedRunMaxIn(limit),
          endsAt: run.activeUntil,
        }
  return (
    <PlugCard
      orientation={orientation}
      showName={showName}
      model={{
        common,
        on: display.on,
        since:
          typeof display.lastChangedAt === 'number'
            ? coarseDuration(Date.now() - display.lastChangedAt, t)
            : null,
        timer,
      }}
      actions={{
        ...actions,
        onPower: (on) =>
          reportedCommand(applyOptimisticAction, { fail, succeed })({ on }, () =>
            cap.setState({ on }),
          ),
        onTimerStart: (minutes) =>
          void timedRun?.runFor({ duration: minutes, unit: 'min' }).then(succeed, fail),
        onTimerStop: () => void timedRun?.cancel({}).then(succeed, fail),
      }}
    />
  )
}
