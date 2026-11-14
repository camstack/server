import type { ReactElement } from 'react'
import { Skeleton } from '../../../primitives/skeleton'
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
  if (!power.bound) return null
  // An unanswered switch is not off: the card stays pending until the slice answers.
  if (power.on === undefined) {
    return <Skeleton className="h-72 w-full" data-testid="dc-card-pending" />
  }
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
