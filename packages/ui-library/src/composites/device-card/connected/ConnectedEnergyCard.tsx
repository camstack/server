import type { EnergySystemStatus } from '@camstack/types'
import type { ReactElement } from 'react'
import { useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { EnergyCard, energySince } from '../scenes/energy/EnergyCard'
import { energyActivityOf } from '../scenes/energy/model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { energyFlowsOf, energyTodayOf } from './energy-model'
import { useCardCommon } from './use-card-common'

/**
 * An energy system (`energy-system`): solar, grid, storage, house and heat
 * pump as branches of one bus, with today's totals. Read-only. The storage is
 * a node of the scene fed by the model; the card draws no battery corner and
 * no power corner — the system is not a device that runs on a battery or
 * draws from a meter of its own (#522).
 */
export function ConnectedEnergyCard({
  deviceId,
  canActuate = true,
  orientation,
  showName = true,
}: ConnectedCardProps): ReactElement | null {
  const t = useUiText()
  const client = useTrpcClient()
  const dev = useDeviceProxy(client, deviceId)
  const card = useCardCommon({ deviceId, canActuate })
  const slice: EnergySystemStatus | undefined = useDeviceStateSlice(
    dev?.energySystem === undefined ? undefined : dev.state.energySystem,
  )
  if (dev?.energySystem === undefined || slice === undefined) return null
  const flows = energyFlowsOf(slice)
  return (
    <EnergyCard
      orientation={orientation}
      showName={showName}
      model={{
        common: { ...card.common, battery: null, power: null },
        activity: energyActivityOf(flows),
        since: energySince(flows, t),
        flows,
        today: energyTodayOf(slice),
      }}
      actions={card.actions}
    />
  )
}
