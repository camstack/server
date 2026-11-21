/** The energy-system page of the approved mockup: the five systems, the mockup's data (kW → W). */
import type { TimeSeriesDef } from '../../charts/TimeSeriesChart'
import { type EnergyFlowSpan, energyFlowSpans } from '../connected/energy-day'
import { ENERGY_NODE_SLOT } from '../illustrations/EnergyFlowIllustration'
import { energyActivityOf, type EnergyCardModel, type EnergyFlows } from '../scenes/energy/model'
import type { CardOrientation } from '../shell/model'
import { mockupCommon } from './common'

export interface EnergyFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: EnergyCardModel
}

/** The energy page draws no supply, no remote, no battery corner and no power corner. */
function common(name: string, integration: string): EnergyCardModel['common'] {
  return {
    ...mockupCommon({ name, integration, watts: 0, supplyName: '', consumables: [], remote: [] }),
    power: null,
    battery: null,
    supply: null,
    remote: null,
  }
}

const kw = (v: number | null): number | null => (v === null ? null : Math.round(v * 1000))

function flows(
  pv: number,
  grid: number,
  bat: number | null,
  soc: number | null,
  house: number,
  hp: number | null,
): EnergyFlows {
  return {
    solarW: kw(pv),
    gridW: kw(grid),
    batteryW: kw(bat),
    batteryPct: soc,
    houseW: kw(house),
    heatPumpW: kw(hp),
  }
}

const NO_DAILY_FACTS: Pick<
  NonNullable<EnergyCardModel['today']>,
  | 'houseKwh'
  | 'householdKwh'
  | 'sources'
  | 'netGridKwh'
  | 'selfSufficiencyPct'
  | 'autonomyHours'
  | 'chargedTodayKwh'
  | 'dischargedTodayKwh'
  | 'socPct'
  | 'healthPct'
  | 'heatPumpShareNowPct'
> = {
  houseKwh: null,
  householdKwh: null,
  sources: null,
  netGridKwh: null,
  selfSufficiencyPct: null,
  autonomyHours: null,
  chargedTodayKwh: null,
  dischargedTodayKwh: null,
  socPct: null,
  healthPct: null,
  heatPumpShareNowPct: null,
}

function system(
  id: string,
  caption: string,
  name: string,
  integration: string,
  f: EnergyFlows,
  since: string | null,
  today: EnergyCardModel['today'],
  orientation: CardOrientation = 'vertical',
): EnergyFixture {
  return {
    id,
    caption,
    orientation,
    model: {
      common: common(name, integration),
      activity: energyActivityOf(f),
      since,
      flows: f,
      today,
    },
  }
}

export function energyFixtures(): readonly EnergyFixture[] {
  return [
    system(
      'energy-day',
      'Giorno · il sole carica, alimenta e cede',
      'Impianto solare',
      'Enpal',
      flows(4.2, -0.5, -2.6, 78, 0.6, 0.5),
      '4.2 kW',
      {
        ...NO_DAILY_FACTS,
        producedKwh: 18.4,
        selfConsumptionPct: 82,
        importedKwh: 1.2,
        exportedKwh: 4.1,
        netGridKwh: -2.9,
        heatPumpKwh: 6.8,
        houseKwh: 14.8,
        selfSufficiencyPct: 92,
        autonomyHours: 6.4,
        chargedTodayKwh: 5.1,
        dischargedTodayKwh: 2.3,
        socPct: 78,
        healthPct: 97,
        heatPumpShareNowPct: 83,
      },
    ),
    system(
      'energy-evening',
      'Sera · la batteria alimenta casa e pompa',
      'Impianto solare',
      'Enpal',
      flows(0.3, 0, 1.5, 54, 1.1, 0.7),
      '0.3 kW',
      {
        ...NO_DAILY_FACTS,
        producedKwh: 21.0,
        selfConsumptionPct: 88,
        importedKwh: 1.2,
        exportedKwh: 4.6,
        netGridKwh: -3.4,
        heatPumpKwh: 8.9,
        houseKwh: 16.4,
        selfSufficiencyPct: 93,
        autonomyHours: 4.1,
        chargedTodayKwh: 3.6,
        dischargedTodayKwh: 5.8,
        socPct: 54,
        healthPct: 97,
        heatPumpShareNowPct: 64,
      },
    ),
    system(
      'energy-winter',
      'Inverno · la pompa tira da sole, batteria e rete',
      'Impianto solare',
      'Enpal',
      flows(0.8, 1.4, 1.2, 31, 0.7, 2.7),
      '0.8 kW',
      {
        ...NO_DAILY_FACTS,
        producedKwh: 5.2,
        selfConsumptionPct: 100,
        importedKwh: 9.8,
        exportedKwh: 0,
        netGridKwh: 9.8,
        heatPumpKwh: 21.4,
        houseKwh: 15.0,
        selfSufficiencyPct: 35,
        autonomyHours: 1.8,
        chargedTodayKwh: 1.1,
        dischargedTodayKwh: 7.4,
        socPct: 31,
        healthPct: 96,
        heatPumpShareNowPct: 79,
      },
    ),
    system(
      'energy-night',
      'Notte, tariffa bassa · la rete carica la batteria',
      'Impianto solare',
      'Enpal',
      flows(0, 2.5, -2.0, 22, 0.5, 0),
      'dalla rete',
      {
        ...NO_DAILY_FACTS,
        producedKwh: 0,
        selfConsumptionPct: 0,
        importedKwh: 6.1,
        exportedKwh: 0,
        netGridKwh: 6.1,
        heatPumpKwh: 3.2,
        houseKwh: 6.1,
        selfSufficiencyPct: 0,
        autonomyHours: 2.2,
        chargedTodayKwh: 4.0,
        dischargedTodayKwh: 0.4,
        socPct: 22,
        healthPct: 97,
        heatPumpShareNowPct: 0,
      },
    ),
    system(
      'energy-plain',
      'Senza batteria né pompa',
      'Inverter garage',
      'Fronius',
      flows(2.8, -2.1, null, null, 0.7, null),
      '2.8 kW',
      {
        ...NO_DAILY_FACTS,
        producedKwh: 9.6,
        selfConsumptionPct: 41,
        importedKwh: 0.8,
        exportedKwh: 5.7,
        netGridKwh: -4.9,
        heatPumpKwh: null,
        houseKwh: 4.7,
        selfSufficiencyPct: 83,
      },
      'horizontal',
    ),
  ]
}

const HOUR_MS = 3_600_000

interface DayPoint {
  readonly t: number
  readonly v: number
}

/** A sunny day's curves on a fixed local day, one point a quarter hour: invented, for the previews. */
export function energyDayFixture(dayStart: number): {
  readonly powerSeries: readonly TimeSeriesDef[]
  readonly socSeries: readonly TimeSeriesDef[]
  readonly flowSpans: readonly EnergyFlowSpan[]
  readonly range: { readonly from: number; readonly to: number }
} {
  const steps = Array.from({ length: 96 }, (_, i) => i)
  const at = (i: number): number => dayStart + (i * HOUR_MS) / 4
  const sunW = (h: number): number => Math.max(0, Math.sin(((h - 6) / 13) * Math.PI)) * 4200
  const houseW = (h: number): number =>
    450 + (h > 17 && h < 22 ? 1100 : 0) + (h > 6 && h < 9 ? 600 : 0)
  const solar: DayPoint[] = steps.map((i) => ({ t: at(i), v: Math.round(sunW(i / 4)) }))
  const load: DayPoint[] = steps.map((i) => ({ t: at(i), v: houseW(i / 4) }))
  const grid: DayPoint[] = steps.map((i) => {
    const h = i / 4
    const draw = sunW(h) < 900 ? houseW(h) : -Math.max(0, sunW(h) - houseW(h) - 1500)
    return { t: at(i), v: Math.round(draw) }
  })
  const battery: DayPoint[] = steps.map((i) => {
    const h = i / 4
    const surplus = sunW(h) - houseW(h)
    return {
      t: at(i),
      v: Math.round(surplus > 0 ? Math.min(1500, surplus) : -Math.min(1200, -surplus)),
    }
  })
  let soc = 20
  const charge: DayPoint[] = battery.map((p) => {
    soc = Math.max(10, Math.min(100, soc + (p.v / 1000) * 2.5))
    return { t: p.t, v: Math.round(soc) }
  })
  const def = (
    id: string,
    label: string,
    points: readonly DayPoint[],
    colorIndex: number,
    unit: string,
  ): TimeSeriesDef => ({
    id,
    label,
    unit,
    points: unit === 'kW' ? points.map((p) => ({ t: p.t, v: p.v / 1000 })) : points,
    colorIndex,
    interpolation: 'step',
  })
  const range = { from: dayStart, to: dayStart + 24 * HOUR_MS }
  return {
    powerSeries: [
      def('solar', 'Solare', solar, ENERGY_NODE_SLOT.solar, 'kW'),
      def('house', 'Casa', load, ENERGY_NODE_SLOT.house, 'kW'),
      def('grid', 'Rete', grid, ENERGY_NODE_SLOT.grid, 'kW'),
      def('battery', 'Batteria', battery, ENERGY_NODE_SLOT.battery, 'kW'),
    ],
    socSeries: [def('soc', 'Carica batteria', charge, ENERGY_NODE_SLOT.battery, '%')],
    flowSpans: energyFlowSpans(grid, battery, range),
    range,
  }
}
