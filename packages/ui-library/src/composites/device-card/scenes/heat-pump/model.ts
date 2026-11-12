import type { CardCommon, CardCommonActions } from '../../shell/model'

/** What the heat pump is doing: `defrost` only when the gateway says so. */
export type HeatPumpActivity = 'heat' | 'dhw' | 'cool' | 'idle' | 'defrost'

/** One value a selector offers, already in words. */
export interface HeatPumpOption {
  readonly id: string
  readonly label: string
}

/** The selector a circuit offers: its operation mode, or (hot water) its temperature level. */
export interface HeatPumpCircuitPicker {
  readonly kind: 'mode' | 'level'
  readonly value: string | null
  readonly options: readonly HeatPumpOption[]
}

export interface HeatPumpCircuitView {
  readonly id: string
  readonly label: string
  /** What the circuit is doing, in words ("Heating", "53°"). */
  readonly status: string
  /** The secondary detail ("21° · flow 30°", "Eco"); null when there is none. */
  readonly detail: string | null
  /** Null when the gateway names no values to choose from. */
  readonly picker: HeatPumpCircuitPicker | null
}

export const HEAT_PUMP_SYSTEM_MODES = ['silent', 'away', 'additionalHeater', 'holiday'] as const
export type HeatPumpSystemModeId = (typeof HEAT_PUMP_SYSTEM_MODES)[number]

/** A system mode the gateway declares, with its real values. */
export interface HeatPumpSystemModeView {
  readonly id: HeatPumpSystemModeId
  readonly value: string | null
  readonly options: readonly HeatPumpOption[]
  /**
   * The value "on" writes when the mode is an off / on pair (holiday: the
   * programme that is set, else the first allowed one); null draws a menu.
   */
  readonly toggleOn: string | null
}

export interface HeatPumpCardModel {
  readonly common: CardCommon
  readonly activity: HeatPumpActivity
  readonly since: string | null
  readonly temperatures: {
    readonly outdoor: number | null
    readonly supply: number | null
    readonly return: number | null
  }
  readonly pressureBar: number | null
  /** 0..100; null when the gateway does not report it. */
  readonly compressorPct: number | null
  readonly thermalW: number | null
  readonly electricalW: number | null
  /** Instantaneous COP; null when it cannot be computed. */
  readonly cop: number | null
  readonly circuits: readonly HeatPumpCircuitView[]
  /** Only the modes the gateway declares, in the order silent, away, additional heater, holiday. */
  readonly system: readonly HeatPumpSystemModeView[]
}

export interface HeatPumpCardActions extends CardCommonActions {
  readonly onCircuit: (
    circuitId: string,
    kind: HeatPumpCircuitPicker['kind'],
    value: string,
  ) => void
  readonly onSystemMode: (id: HeatPumpSystemModeId, value: string) => void
}
