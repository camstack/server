/**
 * `energy-system` → the energy card. Pure: the connected card reads the slice,
 * these turn it into the scene's node powers and today's totals. The storage
 * is read from the model's `storage` part, never from the `battery` cap (#522).
 */
import { type EnergySystemStatus, energySystemSelfConsumptionPct } from '@camstack/types'
import type { EnergyFlows, EnergyToday } from '../scenes/energy/model'

/**
 * Node powers signed against the bus (+ into it): the cap's grid is already
 * + import; its storage is + charging, which takes power OUT of the bus, so the
 * scene's battery is its negation. A part the system lacks draws no node.
 */
export function energyFlowsOf(status: EnergySystemStatus): EnergyFlows {
  const storageW = status.storage?.powerW ?? null
  return {
    solarW: status.solar?.powerW ?? null,
    gridW: status.grid?.powerW ?? null,
    batteryW: storageW === null ? null : -storageW,
    batteryPct: status.storage?.stateOfChargePct ?? null,
    houseW: status.house?.powerW ?? null,
    heatPumpW: status.heatPump?.powerW ?? null,
  }
}

const tenth = (v: number | null): number | null => (v === null ? null : Math.round(v * 10) / 10)

/** Today's totals, to a tenth of a kWh; null when the system reports none of them. */
export function energyTodayOf(status: EnergySystemStatus): EnergyToday | null {
  const today: EnergyToday = {
    producedKwh: tenth(status.solar?.todayKwh ?? null),
    selfConsumptionPct: energySystemSelfConsumptionPct(status),
    importedKwh: tenth(status.grid?.importTodayKwh ?? null),
    exportedKwh: tenth(status.grid?.exportTodayKwh ?? null),
    heatPumpKwh: tenth(status.heatPump?.todayKwh ?? null),
  }
  return Object.values(today).some((v) => v !== null) ? today : null
}
