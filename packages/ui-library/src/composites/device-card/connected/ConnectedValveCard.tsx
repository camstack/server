import { DeviceFeature, type ValveStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { ValveCard } from '../scenes/valve/ValveCard'
import { coarseDuration } from './coarse-duration'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/**
 * A valve (`valve`): open, close, stop and — when the device declares
 * `valve-positionable` — a position. Home Assistant's valve always implements
 * `setPosition`; the feature is what makes the slider real.
 */
export function ConnectedValveCard({
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
  const slice = useDeviceStateSlice(dev?.valve === undefined ? undefined : dev.state.valve)
  const { display, applyOptimisticAction } = useOptimisticSlice<ValveStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.valve
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, {
    fail: card.fail,
    succeed: card.succeed,
  })
  const has = (method: string): boolean => card.implements('valve', method)
  return (
    <ValveCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        activity: display.state,
        since:
          display.lastChangedAt > 0 ? coarseDuration(Date.now() - display.lastChangedAt, t) : null,
        position: display.position,
        positionable: card.features.includes(DeviceFeature.ValvePositionable),
        canOpen: has('open'),
        canClose: has('close'),
        canStop: has('stop'),
      }}
      actions={{
        ...card.actions,
        onOpen: () => send({ state: 'opening' }, () => cap.open({})),
        onClose: () => send({ state: 'closing' }, () => cap.close({})),
        onStop: () => send({ state: 'stopped' }, () => cap.stop({})),
        onPosition: (position) => {
          const set = cap.setPosition
          if (set !== undefined) send({ position }, () => set({ position }))
        },
      }}
    />
  )
}
