import type { ReactElement } from 'react'
import { SirenCard } from '../scenes/siren/SirenCard'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { useCardCommon } from './use-card-common'
import { useSwitchPower } from './use-switch-power'

/**
 * A siren (a `siren` device, or a switch in the siren role): sound and
 * silence through its `switch`. Tone, duration and volume are drawn only when
 * a cap declares them — none does yet.
 */
export function ConnectedSirenCard({
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
    <SirenCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        activity: power.on === null ? 'unknown' : power.on ? 'sounding' : 'silent',
        since: power.since,
        switchable: card.implements('switch', 'setState'),
      }}
      actions={{ ...card.actions, onSound: power.onPower }}
    />
  )
}
