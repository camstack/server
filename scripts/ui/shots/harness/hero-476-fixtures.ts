/** Fixture data of the planning#476 mockups (invented values). */
import type { EnergyFlows } from './hero-476-art'

export interface ModeDef {
  readonly key: string
  readonly label: string
  readonly options: readonly {
    readonly value: string
    readonly label: string
  }[]
  readonly initial: string
}

/** The independent system modes, each with its REAL values (not one profile selector). */
export const SYSTEM_MODES: readonly ModeDef[] = [
  {
    key: 'silent',
    label: 'Silenzioso',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'auto', label: 'Auto' },
      { value: 'on', label: 'On' },
    ],
    initial: 'off',
  },
  {
    key: 'absent',
    label: 'Assente',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
    initial: 'off',
  },
  {
    key: 'aux',
    label: 'Riscaldatore aggiuntivo',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'manual', label: 'Manuale' },
      { value: 'auto', label: 'Auto' },
    ],
    initial: 'off',
  },
  {
    key: 'holiday',
    label: 'Vacanza',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'schedule', label: 'Programma' },
    ],
    initial: 'off',
  },
]

/** The real moment of the fixture: PV 1234 W, battery 98,9 % charging 339 W, grid 5 W, house 895 W. */
export const NOW_FLOWS: EnergyFlows = {
  pv: 1234,
  battery: 339,
  grid: 5,
  house: 895,
  heatPump: null,
  soc: 98.9,
}
/**
 * Illustrative, the opposite directions: night, battery discharging, grid importing. The
 * house total is the sum of the sources (0 + 1180 + 3403) and the heat pump a share of it.
 */
export const NIGHT_FLOWS: EnergyFlows = {
  pv: 0,
  battery: -1180,
  grid: 3403,
  house: 4583,
  heatPump: 2991,
  soc: 61.4,
}
/** A heat pump linked at the real moment: a small share of the 895 W. */
export const LINKED_FLOWS: EnergyFlows = { ...NOW_FLOWS, heatPump: 310 }

export const HP_CHILDREN = [
  { id: 2301, stableId: 'hp', type: 'heater', name: 'Pompa di calore' },
  { id: 2302, stableId: 'hc1', type: 'thermostat', name: 'Circuito 1' },
  { id: 2303, stableId: 'hc2', type: 'thermostat', name: 'Circuito 2' },
  { id: 2304, stableId: 'dhw1', type: 'water_heater', name: 'Acqua calda' },
  { id: 2305, stableId: 'sc1', type: 'sensor', name: 'Solare' },
] as const

export const EN_CHILDREN = [
  { id: 2401, stableId: 'sys', type: 'sensor', name: 'Impianto' },
  { id: 2402, stableId: 'bat', type: 'sensor', name: 'Batteria' },
  { id: 2403, stableId: 'inv', type: 'sensor', name: 'Inverter' },
  { id: 2404, stableId: 'grid', type: 'sensor', name: 'Rete' },
] as const
