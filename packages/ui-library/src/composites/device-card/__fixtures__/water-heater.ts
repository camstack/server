/** The water-heater page of the approved mockup: four heaters, the mockup's data. */
import type { WaterHeaterCardModel, WaterHeaterModeOption } from '../scenes/water-heater/model'
import type { CardOrientation } from '../shell/model'
import { mockupCommon } from './common'

export interface WaterHeaterFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: WaterHeaterCardModel
}

const modes = (...labels: readonly string[]): readonly WaterHeaterModeOption[] =>
  labels.map((label) => ({ id: label.toLowerCase(), label }))

/** The water page draws the supply and the anode, but no remote and no battery. */
function common(
  name: string,
  integration: string,
  watts: number | null,
): WaterHeaterCardModel['common'] {
  const base = mockupCommon({
    name,
    integration,
    watts: watts ?? 0,
    supplyName: 'Interruttore boiler',
    consumables: [
      { key: 'anode', label: 'Anodo di magnesio', percent: 55, resetLabel: 'Sostituito' },
    ],
    remote: [],
  })
  return {
    ...base,
    power: watts === null ? null : base.power,
    battery: null,
    remote: null,
  }
}

const ARISTON = modes('Eco', 'Comfort', 'Boost')

export function waterHeaterFixtures(): readonly WaterHeaterFixture[] {
  return [
    {
      id: 'water-idle',
      caption: 'Pompa di calore · in temperatura',
      orientation: 'vertical',
      model: {
        common: common('Acqua calda', 'Bosch HomeCom', null),
        activity: 'idle',
        since: 'Eco',
        currentTemp: 53.3,
        targetTemp: 51,
        targetSettable: true,
        minTemp: 30,
        maxTemp: 60,
        mode: 'eco',
        modes: modes('Spento', 'Bassa', 'Alta', 'Programma', 'Eco'),
        away: false,
        power: true,
      },
    },
    {
      id: 'water-heat',
      caption: 'Riscalda',
      orientation: 'vertical',
      model: {
        common: common('Boiler', 'Ariston', 1500),
        activity: 'heat',
        since: 'pronto tra 50 min',
        currentTemp: 41,
        targetTemp: 60,
        targetSettable: true,
        minTemp: 40,
        maxTemp: 80,
        mode: 'boost',
        modes: ARISTON,
        away: false,
        power: true,
      },
    },
    {
      id: 'water-away',
      caption: 'Fuori casa',
      orientation: 'vertical',
      model: {
        common: common('Boiler mansarda', 'Ariston', 0),
        activity: 'away',
        since: 'Eco',
        currentTemp: 38,
        targetTemp: 45,
        targetSettable: true,
        minTemp: 40,
        maxTemp: 80,
        mode: 'eco',
        modes: ARISTON,
        away: true,
        power: true,
      },
    },
    {
      id: 'water-off',
      caption: 'Spento',
      orientation: 'vertical',
      model: {
        common: common('Boiler cantina', 'Shelly', 0),
        activity: 'off',
        since: '1 g',
        currentTemp: 22,
        targetTemp: 55,
        targetSettable: true,
        minTemp: 40,
        maxTemp: 75,
        mode: 'eco',
        modes: modes('Eco', 'Comfort'),
        away: null,
        power: false,
      },
    },
  ]
}
