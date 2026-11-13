import type { PetFountainStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { PetFountainCard } from '../scenes/pet/PetFountainCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { petFaultOf, petFountainActivityOf } from './pet-model'
import { sinceText } from './since-text'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

/** A drinking fountain (`pet-fountain`): the pump switch and the tank's level. */
export function ConnectedPetFountainCard({
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
    dev?.petFountain === undefined ? undefined : dev.state.petFountain,
  )
  const { display, applyOptimisticAction } = useOptimisticSlice<PetFountainStatus>(slice, {
    enabled: optimistic,
  })
  const cap = dev?.petFountain
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, {
    fail: card.fail,
    succeed: card.succeed,
  })
  return (
    <PetFountainCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        activity: petFountainActivityOf(display),
        since: sinceText(display.lastFetchedAt, Date.now(), t) ?? null,
        fault: petFaultOf(display.error),
        waterLevel: display.waterLevel,
        pump: card.implements('pet-fountain', 'setPump') ? display.pumpRunning === true : null,
      }}
      actions={{
        ...card.actions,
        onPump: (on) => send({ pumpRunning: on }, () => cap.setPump({ on })),
      }}
    />
  )
}
