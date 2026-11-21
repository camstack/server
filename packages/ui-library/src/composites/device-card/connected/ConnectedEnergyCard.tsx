import type { EnergySystemStatus } from '@camstack/types'
import { type ReactElement, useState } from 'react'
import { useOptionalSystem, useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { EnergyCard, energySince } from '../scenes/energy/EnergyCard'
import { energyActivityOf } from '../scenes/energy/model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { energyFlowsOf, energyTodayOf } from './energy-model'
import { EnergyDayPanel } from '../parts/EnergyDayPanel'
import { useEnergyDay } from './use-energy-day'
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
  // The Precision set in Customize on THIS device wins; none = the default number rule.
  const precision = useOptionalSystem()?.getDeviceInfo(deviceId)?.display?.precision
  const card = useCardCommon({ deviceId, canActuate })
  const slice: EnergySystemStatus | undefined = useDeviceStateSlice(
    dev?.energySystem === undefined ? undefined : dev.state.energySystem,
  )
  const [dayOffset, setDayOffset] = useState(0)
  const day = useEnergyDay(deviceId, dayOffset, t)
  if (dev?.energySystem === undefined || slice === undefined) return null
  const flows = energyFlowsOf(slice)
  const isToday = dayOffset === 0
  return (
    <EnergyCard
      nodesLive={isToday}
      orientation={orientation}
      showName={showName}
      trend={
        <EnergyDayPanel
          dayStart={day.window.from}
          isToday={isToday}
          canNext={!isToday}
          onPrev={() => setDayOffset((o) => o + 1)}
          onNext={() => setDayOffset((o) => Math.max(0, o - 1))}
          onToday={() => setDayOffset(0)}
          status={day.status}
          powerSeries={day.powerSeries}
          socSeries={day.socSeries}
          flowSpans={day.flowSpans}
          range={day.window}
        />
      }
      model={{
        common: { ...card.common, battery: null, power: null },
        activity: energyActivityOf(flows),
        since: energySince(flows, t, precision),
        flows,
        ...(precision === undefined ? {} : { precision }),
        // Today reads the system's own day totals; another day reads its recorded counters.
        today: isToday ? energyTodayOf(slice) : day.today,
      }}
      actions={card.actions}
    />
  )
}
