import { DeviceRole } from '@camstack/types'
import type { ReactElement } from 'react'
import { useDeviceManagerGetDevice } from '../../../generated/system-hooks'
import { PlugCard } from '../scenes/plug/PlugCard'
import type { CardOrientation } from '../shell/model'
import { useCardCommon } from './use-card-common'
import { usePowerCycle } from './use-power-cycle'
import { useSwitchPower } from './use-switch-power'

export interface ConnectedCardProps {
  readonly deviceId: number
  /** False when the viewer may look but not command (default: true). */
  readonly canActuate?: boolean
  readonly orientation?: CardOrientation
  /** Show a command's effect before the device confirms it (default: true). */
  /** Draw the device name (default true); false when the host already names the device. */
  readonly showName?: boolean
}

/**
 * The plug card of a real device: `switch`, `timed-run` when the device binds it,
 * and the switch's native power cycle when its provider declares one.
 */
export function ConnectedPlugCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const card = useCardCommon({ deviceId, canActuate })
  const power = useSwitchPower({ deviceId, card })
  const cycle = usePowerCycle({ deviceId, card })
  const role = useDeviceManagerGetDevice({ deviceId }).data?.role
  if (!power.bound || power.on === undefined) return null
  return (
    <PlugCard
      orientation={orientation}
      showName={showName}
      model={{
        common: card.common,
        on: power.on,
        since: power.since,
        timer: power.timer,
        powerCycle: cycle.declared,
        art: role === DeviceRole.PoePort ? 'port' : 'socket',
      }}
      actions={{
        ...card.actions,
        onPower: power.onPower,
        onTimerStart: power.onTimerStart,
        onTimerStop: power.onTimerStop,
        onPowerCycle: cycle.onPowerCycle,
      }}
    />
  )
}
