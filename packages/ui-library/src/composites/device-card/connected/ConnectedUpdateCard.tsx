import type { UpdateStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { updatePhaseOf } from '../scenes/update/model'
import { UpdateCard } from '../scenes/update/UpdateCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/**
 * An update entity (`update`). The cap carries no progress, release notes or
 * failure reason, so the card draws none of them.
 */
export function ConnectedUpdateCard({
  deviceId,
  canActuate = true,
  orientation,
  optimistic = true,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice = useDeviceStateSlice(dev?.update === undefined ? undefined : dev.state.update)
  const { display, applyOptimisticAction } = useOptimisticSlice<UpdateStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.update
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, card)
  return (
    <UpdateCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        phase: updatePhaseOf(display),
        current: display.currentVersion,
        available: display.availableVersion,
        stateText: display.state === '' ? null : display.state,
        installable: card.implements('update', 'installUpdate'),
      }}
      actions={{
        ...card.actions,
        onInstall: () => send({ inProgress: true }, () => cap.installUpdate({})),
      }}
    />
  )
}
