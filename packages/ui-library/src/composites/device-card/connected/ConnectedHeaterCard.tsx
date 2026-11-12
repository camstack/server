import type { ReactElement } from 'react'
import { HeaterCard } from '../scenes/heater/HeaterCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'
import { useSwitchPower } from './use-switch-power'

/** The heater card of a real `switch` with the role `switch-heater`: power and its timed run. */
export function ConnectedHeaterCard({
  deviceId,
  canActuate = true,
  orientation,
  optimistic = true,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const card = useCardCommon({ deviceId, canActuate })
  const power = useSwitchPower({ deviceId, optimistic, card })
  if (!power.bound || power.on === undefined) return null
  return (
    <HeaterCard
      orientation={orientation}
      showName={showName}
      model={{ common: card.common, on: power.on, since: power.since, timer: power.timer }}
      actions={{
        ...card.actions,
        onPower: power.onPower,
        onTimerStart: power.onTimerStart,
        onTimerStop: power.onTimerStop,
      }}
    />
  )
}
