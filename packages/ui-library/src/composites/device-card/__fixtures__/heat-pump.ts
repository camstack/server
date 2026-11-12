/**
 * The heat-pump page of the approved mockup: four pumps, the mockup's data,
 * plus one that declares all four system modes (the mockup draws two).
 */
import type {
  HeatPumpCardModel,
  HeatPumpCircuitView,
  HeatPumpSystemModeView,
} from '../scenes/heat-pump/model'
import type { CardOrientation } from '../shell/model'
import { mockupCommon } from './common'

export interface HeatPumpFixture {
  readonly id: string
  readonly caption: string
  readonly orientation: CardOrientation
  readonly model: HeatPumpCardModel
}

const ON_OFF = [
  { id: 'off', label: 'Off' },
  { id: 'on', label: 'On' },
]
const OPERATION = [
  { id: 'auto', label: 'Auto' },
  { id: 'manual', label: 'Manuale' },
  { id: 'off', label: 'Off' },
]
const DHW_LEVEL = [
  { id: 'off', label: 'Off' },
  { id: 'low', label: 'Bassa' },
  { id: 'high', label: 'Alta' },
  { id: 'eco', label: 'Eco' },
]

/** The heat-pump page draws the supply but no remote and no battery. */
function common(name: string, integration: string, watts: number): HeatPumpCardModel['common'] {
  return {
    ...mockupCommon({
      name,
      integration,
      watts,
      supplyName: 'Interruttore pompa',
      consumables: [
        {
          key: 'dirt',
          label: 'Filtro defangatore',
          percent: 35,
          resetLabel: 'Pulito',
        },
      ],
      remote: [],
    }),
    battery: null,
    remote: null,
  }
}

const circuit = (
  id: string,
  label: string,
  status: string,
  detail: string | null,
  value: string | null = 'auto',
): HeatPumpCircuitView => ({
  id,
  label,
  status,
  detail,
  picker: { kind: 'mode', value, options: OPERATION },
})

const dhw = (status: string, detail: string | null): HeatPumpCircuitView => ({
  id: 'dhw1',
  label: 'Acqua calda',
  status,
  detail,
  picker: { kind: 'level', value: 'eco', options: DHW_LEVEL },
})

const toggle = (id: HeatPumpSystemModeView['id'], on: boolean): HeatPumpSystemModeView => ({
  id,
  value: on ? 'on' : 'off',
  options: ON_OFF,
  toggleOn: 'on',
})

export function heatPumpFixtures(): readonly HeatPumpFixture[] {
  return [
    {
      id: 'heatpump-heat',
      caption: 'Riscalda · tutti i valori',
      orientation: 'vertical',
      model: {
        common: common('Pompa di calore', 'Bosch HomeCom', 1600),
        activity: 'heat',
        since: '25 min',
        temperatures: { outdoor: 8.3, supply: 34.5, return: 29.8 },
        pressureBar: 1.6,
        compressorPct: 45,
        thermalW: 6200,
        electricalW: 1600,
        cop: 3.9,
        circuits: [
          circuit('hc1', 'Circuito 1', 'Riscalda', '21° · mandata 30°'),
          circuit('hc2', 'Circuito 2', 'Spento', null, 'off'),
          dhw('53°', 'Eco'),
        ],
        system: [toggle('silent', false), toggle('away', false)],
      },
    },
    {
      id: 'heatpump-dhw',
      caption: 'Prepara l’acqua calda',
      orientation: 'vertical',
      model: {
        common: common('Pompa di calore', 'Bosch HomeCom', 2300),
        activity: 'dhw',
        since: '25 min',
        temperatures: { outdoor: 8.3, supply: 56, return: 49.5 },
        pressureBar: 1.6,
        compressorPct: 80,
        thermalW: 7100,
        electricalW: 2300,
        cop: 3.1,
        circuits: [
          circuit('hc1', 'Circuito 1', 'In attesa', null),
          circuit('hc2', 'Circuito 2', 'Spento', null, 'off'),
          dhw('Carica', '46° → 51°'),
        ],
        system: [toggle('silent', true), toggle('away', false)],
      },
    },
    {
      id: 'heatpump-idle',
      caption: 'Come arriva oggi da HomeCom: solo l’esterna',
      orientation: 'vertical',
      model: {
        common: { ...common('Heat pump', 'Bosch HomeCom', 0), power: null },
        activity: 'idle',
        since: null,
        temperatures: { outdoor: 8.3, supply: null, return: null },
        pressureBar: null,
        compressorPct: null,
        thermalW: null,
        electricalW: null,
        cop: null,
        circuits: [
          circuit('hc1', 'Circuito 1', 'Manuale', '30°', 'manual'),
          circuit('hc2', 'Circuito 2', 'Manuale', '30°', 'manual'),
          dhw('53.3°', 'Eco'),
        ],
        system: [],
      },
    },
    {
      id: 'heatpump-defrost',
      caption: 'Sbrinamento',
      orientation: 'vertical',
      model: {
        common: common('Pompa di calore', 'Daikin', 400),
        activity: 'defrost',
        since: '25 min',
        temperatures: { outdoor: -2.5, supply: 22, return: 24 },
        pressureBar: 1.4,
        compressorPct: 30,
        thermalW: 0,
        electricalW: 400,
        cop: null,
        circuits: [
          { id: 'hc1', label: 'Riscaldamento', status: 'In attesa', detail: null, picker: null },
          { id: 'dhw1', label: 'Acqua calda', status: '48°', detail: null, picker: null },
        ],
        system: [toggle('silent', false), toggle('away', false)],
      },
    },
    {
      id: 'heatpump-system',
      caption: 'Tutte e quattro le modalità di sistema',
      orientation: 'horizontal',
      model: {
        common: common('Pompa di calore', 'Bosch HomeCom', 1600),
        activity: 'heat',
        since: '25 min',
        temperatures: { outdoor: 8.3, supply: 34.5, return: 29.8 },
        pressureBar: 1.6,
        compressorPct: 45,
        thermalW: 6200,
        electricalW: 1600,
        cop: 3.9,
        circuits: [
          circuit('hc1', 'Circuito 1', 'Riscalda', '21° · mandata 30°'),
          dhw('53°', 'Eco'),
        ],
        system: [
          toggle('silent', false),
          toggle('away', true),
          {
            id: 'additionalHeater',
            value: 'auto',
            options: OPERATION,
            toggleOn: null,
          },
          {
            id: 'holiday',
            value: 'off',
            options: [
              { id: 'off', label: 'Off' },
              { id: 'hm1', label: 'Programma 1' },
              { id: 'hm2', label: 'Programma 2' },
            ],
            toggleOn: 'hm1',
          },
        ],
      },
    },
  ]
}
