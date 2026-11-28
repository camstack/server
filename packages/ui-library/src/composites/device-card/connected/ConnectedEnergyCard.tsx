import type { EnergySystemStatus } from '@dominevo/types'
import { type ReactElement, useState } from 'react'
import { useOptionalSystem, useTrpcClient } from '../../../contexts/system-context'
import { useUiText } from '../../../contexts/ui-text'
import { useDeviceProxy, useDeviceStateSlice } from '../../../hooks/use-device-proxy'
import { EnergyDayPanel } from '../parts/EnergyDayPanel'
import { EnergyCard, energySince } from '../scenes/energy/EnergyCard'
import { type EnergyToday, energyActivityOf } from '../scenes/energy/model'
import type { ConnectedCardProps } from './ConnectedPlugCard'
import { energyDayWindow } from './energy-day'
import { energyFlowsOf, energyTodayOf, withHeatPumpCop, withLinkedHeatPump } from './energy-model'
import { useCardCommon } from './use-card-common'
import { useEnergyDay } from './use-energy-day'
import { useHeatPumpLink, useLinkedHeatPump } from './use-heat-pump-link'

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
  // A linked heat pump (D1076) is read from its own device, never mixed with the system's branch;
  // while the link read is pending, or when none holds, the system's own branch stands.
  const link = useHeatPumpLink(deviceId)
  const linked = useLinkedHeatPump(
    link.status === 'linked' ? link.sourceDeviceId : null,
    energyDayWindow(Date.now(), dayOffset),
  )
  const day = useEnergyDay(deviceId, dayOffset, t, linked === null ? undefined : linked.dayKwh)
  if (dev?.energySystem === undefined || slice === undefined) return null
  const effective = linked === null ? slice : withLinkedHeatPump(slice, linked)
  const flows = energyFlowsOf(effective)
  const isToday = dayOffset === 0
  const withLinked = (today: EnergyToday | null): EnergyToday | null =>
    linked === null ? today : withHeatPumpCop(today, linked, isToday)
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
          range={day.chartRange}
        />
      }
      model={{
        common: { ...card.common, battery: null, power: null },
        activity: energyActivityOf(flows),
        since: energySince(flows, t, precision),
        flows,
        ...(precision === undefined ? {} : { precision }),
        // Today reads the system's own day totals; another day reads its recorded counters.
        today: withLinked(isToday ? energyTodayOf(effective) : day.today),
      }}
      actions={card.actions}
    />
  )
}
