import type { PetFountainStatus, PumpCycleStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { useOptimisticSlice } from '../../../hooks/use-optimistic-slice'
import { PetFountainCard } from '../scenes/pet/PetFountainCard'
import type { PetFountainCycle } from '../scenes/pet/model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { petFaultOf, petFountainActivityOf } from './pet-model'
import { sinceText } from './since-text'
import { useCardCommon } from './use-card-common'
import { reportedCommand } from './use-command-notice'

const SECONDS_PER_MINUTE = 60

function minutesOf(seconds: number | null): number | null {
  return seconds === null ? null : Math.round(seconds / SECONDS_PER_MINUTE)
}

/** A drinking fountain (`pet-fountain`): the pump, the tank, and the cycle when composed. */
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
  const cycleSlice = useDeviceStateSlice(
    dev?.pumpCycle === undefined ? undefined : dev.state.pumpCycle,
  )
  const cycleOpt = useOptimisticSlice<PumpCycleStatus>(cycleSlice, { enabled: optimistic })
  const cap = dev?.petFountain
  if (cap === undefined || display === undefined) return null
  const send = reportedCommand(applyOptimisticAction, {
    fail: card.fail,
    succeed: card.succeed,
  })
  const cycleCap = dev?.pumpCycle
  const cycleDisplay = cycleOpt.display
  const cycle: PetFountainCycle | null =
    cycleCap === undefined || cycleDisplay === undefined
      ? null
      : {
          enabled: cycleDisplay.enabled,
          runMinutes: minutesOf(cycleDisplay.onTime),
          restMinutes: minutesOf(cycleDisplay.offTime),
        }
  const sendCycle = reportedCommand(cycleOpt.applyOptimisticAction, {
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
        waterVolume: display.waterVolume,
        pump: display.pumpRunning,
        pumpSwitchable: card.implements('pet-fountain', 'setPump'),
        cycle,
      }}
      actions={{
        ...card.actions,
        onPump: (on) => send({ pumpRunning: on }, () => cap.setPump({ on })),
        onCycle: (on) => {
          if (cycleCap === undefined) return
          sendCycle({ enabled: on }, () => cycleCap.setEnabled({ on }))
        },
        onRunMinutes: (minutes) => {
          if (cycleCap === undefined) return
          sendCycle({ onTime: minutes * SECONDS_PER_MINUTE }, () =>
            cycleCap.setOnMinutes({ minutes }),
          )
        },
        onRestMinutes: (minutes) => {
          if (cycleCap === undefined) return
          sendCycle({ offTime: minutes * SECONDS_PER_MINUTE }, () =>
            cycleCap.setOffMinutes({ minutes }),
          )
        },
      }}
    />
  )
}
