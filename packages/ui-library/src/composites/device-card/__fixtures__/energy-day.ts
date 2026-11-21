import type { EnergyDayTotals } from '../connected/energy-day'

/** A recorded day of an energy system with solar, grid, storage and a heat pump (kWh). */
export const energyDayTotalsFixture: EnergyDayTotals = {
  producedKwh: 9.3,
  heatPumpKwh: 21.9,
  importedKwh: 17.4,
  exportedKwh: 0.1,
  chargedKwh: 3.8,
  dischargedKwh: 3.2,
}
