/** The energy-system page of the approved mockup: the five systems, the mockup's data (kW → W). */
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
        producedKwh: 18.4,
        selfConsumptionPct: 82,
        importedKwh: 1.2,
        exportedKwh: 4.1,
        heatPumpKwh: 6.8,
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
        producedKwh: 21.0,
        selfConsumptionPct: 88,
        importedKwh: 1.2,
        exportedKwh: 4.6,
        heatPumpKwh: 8.9,
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
        producedKwh: 5.2,
        selfConsumptionPct: 100,
        importedKwh: 9.8,
        exportedKwh: 0,
        heatPumpKwh: 21.4,
      },
    ),
    system(
      'energy-night',
      'Notte, tariffa bassa · la rete carica la batteria',
      'Impianto solare',
      'Enpal',
      flows(0, 2.5, -2.0, 22, 0.5, 0),
      'dalla rete',
      { producedKwh: 0, selfConsumptionPct: 0, importedKwh: 6.1, exportedKwh: 0, heatPumpKwh: 3.2 },
    ),
    system(
      'energy-plain',
      'Senza batteria né pompa',
      'Inverter garage',
      'Fronius',
      flows(2.8, -2.1, null, null, 0.7, null),
      '2.8 kW',
      {
        producedKwh: 9.6,
        selfConsumptionPct: 41,
        importedKwh: 0.8,
        exportedKwh: 5.7,
        heatPumpKwh: null,
      },
      'horizontal',
    ),
  ]
}
