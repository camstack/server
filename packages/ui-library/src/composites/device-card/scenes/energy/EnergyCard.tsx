import type { ReactElement } from 'react'
import { type UiTextFn, useUiText } from '../../../../contexts/ui-text'
import {
  EnergyFlowIllustration,
  type EnergyNodeId,
  type EnergyNodeView,
} from '../../illustrations/EnergyFlowIllustration'
import { type BottomRow, rowStats } from '../../shell/bottom-rows'
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

const kwh = (v: number | null): string | null => (v === null ? null : `${v} kWh`)
const pct = (v: number | null): string | null => (v === null ? null : `${Math.round(v)}%`)
const hours = (v: number | null): string | null => (v === null ? null : `≈ ${v.toFixed(1)} h`)

/** The scene label already says "Charging · 74%", so the Charge pill would repeat it. */
function sceneShowsBatteryCharge(flows: EnergyFlows): boolean {
  return flows.batteryW !== null && flows.batteryPct !== null
}

interface TodayRowSpec {
  readonly id: string
  readonly label: string
  readonly cells: readonly (readonly [string, string, string | null])[]
}

/**
 * Today's totals gathered by what they answer, at most four to a row: where the
 * energy went, how much of it stayed home, the battery, and what it cycled.
 */
function todayRows(today: EnergyToday, t: UiTextFn, omitCharge: boolean): readonly TodayRowSpec[] {
  const e = (key: string, fallback: string): string =>
    t(`uiLibrary.deviceCard.energy.${key}`, fallback)
  return [
    {
      id: 'flows',
      label: e('rowFlows', 'Energy'),
      cells: [
        ['produced', e('produced', 'Produced'), kwh(today.producedKwh)],
        ['house', e('houseToday', 'House'), kwh(today.houseKwh)],
        ['imported', e('imported', 'Imported'), kwh(today.importedKwh)],
        ['exported', e('exported', 'Exported'), kwh(today.exportedKwh)],
      ],
    },
    {
      id: 'share',
      label: e('rowShare', 'Share'),
      cells: [
        ['self', e('selfConsumption', 'Self-use'), pct(today.selfConsumptionPct)],
        ['sufficiency', e('selfSufficiency', 'Self-sufficiency'), pct(today.selfSufficiencyPct)],
      ],
    },
    {
      id: 'heatPump',
      label: e('rowHeatPump', 'Heat pump'),
      cells: [
        ['heatPump', e('hpToday', 'Today'), kwh(today.heatPumpKwh)],
        ['heatPumpNow', e('hpNow', 'Now'), pct(today.heatPumpShareNowPct)],
      ],
    },
    {
      id: 'battery',
      label: e('rowBattery', 'Battery'),
      cells: [
        ...(omitCharge ? [] : [['soc', e('soc', 'Charge'), pct(today.socPct)] as const]),
        ['health', e('health', 'Health'), pct(today.healthPct)],
        ['autonomy', e('autonomy', 'Autonomy'), hours(today.autonomyHours)],
        ['charged', e('chargedToday', 'Charged'), kwh(today.chargedTodayKwh)],
        ['discharged', e('dischargedToday', 'Discharged'), kwh(today.dischargedTodayKwh)],
      ],
    },
  ]
}

const MAX_STATS_PER_ROW = 4

/** Splits n cells into the fewest rows of at most four, as even as possible (5 becomes 3 + 2). */
function evenChunks<T>(items: readonly T[]): readonly (readonly T[])[] {
  const rows = Math.ceil(items.length / MAX_STATS_PER_ROW)
  const size = Math.ceil(items.length / Math.max(1, rows))
  return Array.from({ length: rows }, (_, i) => items.slice(i * size, (i + 1) * size))
}

/** One `rowStats` per group (more when a group holds over four); a missing input is omitted, never 0. */
function todayBottom(today: EnergyToday, t: UiTextFn, omitCharge: boolean): readonly BottomRow[] {
  return todayRows(today, t, omitCharge).flatMap((row) => {
    const stats = row.cells.flatMap(([id, name, value]) =>
      value === null ? [] : [{ id, name, value }],
    )
    return evenChunks(stats).map((chunk, i) =>
      rowStats(`today-${row.id}-${i}`, {
        label: i === 0 ? row.label : undefined,
        stats: chunk,
        testId: 'dc-energy-today',
        cellTestId: 'dc-energy-today-chip',
      }),
    )
  })
}

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
        columns: {},
        image: (
          <EnergyFlowIllustration
            nodes={energyNodes(model.flows, t)}
            ariaLabel={t('uiLibrary.deviceCard.energy.flows', 'Energy flows')}
            className="h-auto w-full max-w-96"
          />
        ),
        bottom:
          model.today === null
            ? []
            : todayBottom(model.today, t, sceneShowsBatteryCharge(model.flows)),
      }}
    />
  )
}
