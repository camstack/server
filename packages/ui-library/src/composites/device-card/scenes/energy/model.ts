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
}

/** Today's totals (kWh, the self-consumption in %); a null total is not drawn. */
export interface EnergyToday {
  readonly producedKwh: number | null
  readonly selfConsumptionPct: number | null
  readonly importedKwh: number | null
  readonly exportedKwh: number | null
  readonly heatPumpKwh: number | null
}

export interface EnergyCardModel {
  readonly common: CardCommon
  readonly activity: EnergyActivity
  readonly since: string | null
  readonly flows: EnergyFlows
  readonly today: EnergyToday | null
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
export function formatKw(watts: number): string {
  return `${(Math.abs(watts) / 1000).toFixed(1)} kW`
}
