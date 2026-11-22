import { formatNumeric } from '../../../../lib/format-numeric'
import type { CardCommon, CardCommonActions } from '../../shell/model'

/** `sun` while the panels produce, otherwise `idle`. */
export type EnergyActivity = 'sun' | 'idle'

/**
 * Every value is a NODE power in watts, signed against the house bus:
 * + flows INTO the bus, − out of it. Solar only produces (≥ 0); the grid
 * imports (+) or exports (−); the battery discharges (+) or charges (−);
 * the house and the heat pump only consume (≥ 0, drawn leaving the bus).
 * Pair flows (sun → battery) are not measured, so the card never draws one.
 * `null` = the system has no such node, and the card draws none.
 */
export interface EnergyFlows {
  readonly solarW: number | null
  readonly gridW: number | null
  readonly batteryW: number | null
  /** The battery's charge, 0..100; null when unreported. */
  readonly batteryPct: number | null
  readonly houseW: number | null
  readonly heatPumpW: number | null
  /** The grid exists but has not answered its power: its node shows "—", still. */
  readonly gridPowerUnknown?: boolean
}

/**
 * Today's totals and the derived daily facts. A null is not drawn — a missing
 * input is never shown as 0. Percents are 0..100; `autonomyHours` is stored
 * kWh divided by the current house load.
 */
export interface EnergyToday {
  readonly producedKwh: number | null
  readonly selfConsumptionPct: number | null
  readonly importedKwh: number | null
  readonly exportedKwh: number | null
  /** Imported − exported, kWh: + drew from the grid, − fed it. Null unless both are known. */
  readonly netGridKwh: number | null
  readonly heatPumpKwh: number | null
  /** Everything consumed (household + heat pump), kWh. */
  readonly houseKwh: number | null
  /** The household alone (consumption minus the heat pump), kWh. */
  readonly householdKwh: number | null
  /** Where the consumption came from; null unless the balance is known. */
  readonly sources: EnergySourceSplit | null
  /** 1 − import today / house consumption today, clamped to 0..100. */
  readonly selfSufficiencyPct: number | null
  readonly autonomyHours: number | null
  readonly chargedTodayKwh: number | null
  readonly dischargedTodayKwh: number | null
  readonly socPct: number | null
  readonly healthPct: number | null
  /** Heat pump power ÷ house power, right now. */
  readonly heatPumpShareNowPct: number | null
  /**
   * The heat pump's COP over the day and right now, from the linked heat pump
   * device (D1076). Absent when the system has no link; null when a reading is
   * missing — never a 0 or a division by it.
   */
  readonly heatPumpCop?: number | null
  readonly heatPumpCopNow?: number | null
}

/** Shares of the consumption by origin, each 0..100. */
export interface EnergySourceSplit {
  readonly solarPct: number
  readonly batteryPct: number
  readonly gridPct: number
}

export interface EnergyCardModel {
  readonly common: CardCommon
  readonly activity: EnergyActivity
  readonly since: string | null
  readonly flows: EnergyFlows
  readonly today: EnergyToday | null
  /** Display precision resolved for the system device (Customize → Display); absent = the default rule. */
  readonly precision?: number
}

export type EnergyCardActions = CardCommonActions

/** Below this a node is drawn still (no running dots, no arrow). */
export const ENERGY_STILL_BELOW_W = 50

export function energyIsStill(watts: number | null): boolean {
  return watts === null || Math.abs(watts) < ENERGY_STILL_BELOW_W
}

export function energyActivityOf(flows: EnergyFlows): EnergyActivity {
  return energyIsStill(flows.solarW) ? 'idle' : 'sun'
}

/** "4.2 kW" — the magnitude only; the arrow says the direction. */
export function formatKw(watts: number, precision?: number): string {
  return `${formatNumeric(Math.abs(watts) / 1000, precision)} kW`
}

/** "4.2 kWh" — the magnitude only. */
export function formatKwh(kwh: number, precision?: number): string {
  return `${formatNumeric(Math.abs(kwh), precision)} kWh`
}
