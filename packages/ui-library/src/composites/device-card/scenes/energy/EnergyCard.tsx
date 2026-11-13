import type { ReactElement, ReactNode } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import {
  EnergyFlowIllustration,
  type EnergyNodeId,
  type EnergyNodeView,
} from '../../illustrations/EnergyFlowIllustration'
import { ValueChip } from '../../parts/ValueChip'
import { DeviceCard } from '../../shell/DeviceCard'
import type { CardOrientation } from '../../shell/model'
import {
  type EnergyCardActions,
  type EnergyCardModel,
  type EnergyFlows,
  type EnergyToday,
  energyIsStill,
  formatKw,
} from './model'

export interface EnergyCardProps {
  readonly model: EnergyCardModel
  readonly actions: EnergyCardActions
  readonly orientation?: CardOrientation
  readonly showName?: boolean
}

function gridLabel(watts: number, t: UiTextFn): string {
  if (energyIsStill(watts)) return t('uiLibrary.deviceCard.energy.grid', 'Grid')
  return watts > 0
    ? t('uiLibrary.deviceCard.energy.import', 'Import')
    : t('uiLibrary.deviceCard.energy.export', 'Export')
}

function batteryLabel(watts: number, pct: number | null, t: UiTextFn): string {
  const word = energyIsStill(watts)
    ? t('uiLibrary.deviceCard.energy.batteryIdle', 'Idle')
    : watts > 0
      ? t('uiLibrary.deviceCard.energy.discharging', 'Discharging')
      : t('uiLibrary.deviceCard.energy.charging', 'Charging')
  return pct === null ? word : `${word} · ${Math.round(pct)}%`
}

/** The nodes the system has, in drawing order; a null power draws no node. */
export function energyNodes(flows: EnergyFlows, t: UiTextFn): readonly EnergyNodeView[] {
  const out: EnergyNodeView[] = []
  const add = (id: EnergyNodeId, watts: number | null, label: (w: number) => string): void => {
    if (watts === null) return
    out.push({
      id,
      watts,
      label: label(watts),
      value: formatKw(watts),
      still: energyIsStill(watts),
    })
  }
  add('solar', flows.solarW, () => t('uiLibrary.deviceCard.energy.solar', 'Solar'))
  add('grid', flows.gridW, (w) => gridLabel(w, t))
  add('battery', flows.batteryW, (w) => batteryLabel(w, flows.batteryPct, t))
  // The house and the heat pump only consume: drawn leaving the bus.
  add('house', flows.houseW === null ? null : -Math.abs(flows.houseW), () =>
    t('uiLibrary.deviceCard.energy.house', 'Home'),
  )
  add('heatPump', flows.heatPumpW === null ? null : -Math.abs(flows.heatPumpW), () =>
    t('uiLibrary.deviceCard.energy.heatPump', 'Heat pump'),
  )
  return out
}

/** "· 4.2 kW" while producing; otherwise where the house draws from. */
export function energySince(flows: EnergyFlows, t: UiTextFn): string | null {
  if (!energyIsStill(flows.solarW) && flows.solarW !== null) return formatKw(flows.solarW)
  if (flows.batteryW !== null && !energyIsStill(flows.batteryW) && flows.batteryW > 0)
    return t('uiLibrary.deviceCard.energy.fromBattery', 'from the battery')
  if (flows.gridW !== null && !energyIsStill(flows.gridW) && flows.gridW > 0)
    return t('uiLibrary.deviceCard.energy.fromGrid', 'from the grid')
  return null
}

function Today({ today, t }: { readonly today: EnergyToday; readonly t: UiTextFn }): ReactNode {
  const items: readonly (readonly [string, string, string | null])[] = [
    ['produced', t('uiLibrary.deviceCard.energy.produced', 'Produced'), kwh(today.producedKwh)],
    [
      'self',
      t('uiLibrary.deviceCard.energy.selfConsumption', 'Self-use'),
      today.selfConsumptionPct === null ? null : `${Math.round(today.selfConsumptionPct)}%`,
    ],
    ['imported', t('uiLibrary.deviceCard.energy.imported', 'Imported'), kwh(today.importedKwh)],
    ['exported', t('uiLibrary.deviceCard.energy.exported', 'Exported'), kwh(today.exportedKwh)],
    [
      'heatPump',
      t('uiLibrary.deviceCard.energy.heatPumpToday', 'Heat pump'),
      kwh(today.heatPumpKwh),
    ],
  ]
  return (
    <ul data-testid="dc-energy-today" className="flex flex-wrap justify-center gap-1.5">
      {items.flatMap(([id, label, value]) =>
        value === null
          ? []
          : [
              <li key={id}>
                <ValueChip data-testid="dc-energy-today-chip">
                  <span>{label}</span>
                  <span className="font-semibold tabular-nums text-foreground">{value}</span>
                </ValueChip>
              </li>,
            ],
      )}
    </ul>
  )
}

const kwh = (v: number | null): string | null => (v === null ? null : `${v} kWh`)

/**
 * An energy system: solar, grid, battery, house and heat pump as branches of
 * one bus, each running dots in or out at the speed of its power, and
 * today's totals below. Every node is drawn only when the system reports it.
 */
export function EnergyCard({
  model,
  actions,
  orientation = 'vertical',
  showName = true,
}: EnergyCardProps): ReactElement {
  const t = useUiText()
  const producing = model.activity === 'sun'
  return (
    <DeviceCard
      kind="energy"
      common={model.common}
      actions={actions}
      orientation={orientation}
      showName={showName}
      activity={model.activity}
      state={{
        label: producing
          ? t('uiLibrary.deviceCard.energy.producing', 'Producing')
          : t('uiLibrary.deviceCard.energy.notProducing', 'Not producing'),
        since: model.since,
        tone: producing ? 'primary' : 'muted',
      }}
      scene={{
        fx: null,
        left: null,
        image: (
          <EnergyFlowIllustration
            nodes={energyNodes(model.flows, t)}
            ariaLabel={t('uiLibrary.deviceCard.energy.flows', 'Energy flows')}
            className="h-auto w-full max-w-67"
          />
        ),
        right: null,
        bottom: model.today === null ? null : <Today today={model.today} t={t} />,
      }}
    />
  )
}
