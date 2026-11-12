import type { ReactElement } from 'react'
import { PlugCard } from '../scenes/plug/PlugCard'
import type { CardOrientation } from '../shell/model'
import { useCardCommon } from './use-card-common'
import { useSwitchPower } from './use-switch-power'

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

/** The plug card of a real device: `switch`, and `timed-run` when the device binds it. */
export function ConnectedPlugCard({
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
    <PlugCard
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
