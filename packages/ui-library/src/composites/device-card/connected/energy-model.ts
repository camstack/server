/**
 * `energy-system` → the energy card. Pure: the connected card reads the slice,
 * these turn it into the scene's node powers and today's totals. The storage
 * is read from the model's `storage` part, never from the `battery` cap (#522).
 */
import { type EnergySystemStatus, energySystemSelfConsumptionPct } from '@camstack/types'
import type { EnergyFlows, EnergyToday } from '../scenes/energy/model'

/** Derived daily facts. Null is a missing input, not a stand-in for zero. */
export interface EnergyDailyFacts {
  readonly selfSufficiencyPct: number | null
  readonly producedKwh: number | null
  readonly houseKwh: number | null
  readonly importedKwh: number | null
  readonly exportedKwh: number | null
  readonly autonomyHours: number | null
  readonly chargedTodayKwh: number | null
  readonly dischargedTodayKwh: number | null
  readonly socPct: number | null
  readonly healthPct: number | null
  readonly heatPumpShareNowPct: number | null
}

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

/**
 * House consumption today, kWh. The slice's own day total when the system
 * reported one; otherwise produced + imported − exported, and only when all
 * three of those are known. A missing input stays null, never 0 (D393).
 */
function houseConsumptionTodayKwh(status: EnergySystemStatus): number | null {
  const reported = status.house?.todayKwh ?? null
  if (reported !== null) return reported
  const produced = status.solar?.todayKwh ?? null
  const imported = status.grid?.importTodayKwh ?? null
  const exported = status.grid?.exportTodayKwh ?? null
  if (produced === null || imported === null || exported === null) return null
  return produced + imported - exported
}

function selfSufficiencyPct(houseKwh: number | null, importKwh: number | null): number | null {
  if (houseKwh === null || importKwh === null || houseKwh <= 0) return null
  return Math.max(0, Math.min(100, (1 - importKwh / houseKwh) * 100))
}

/** Stored kWh ÷ current house load (kW). Hidden when the load is ≤ 0 or unknown. */
function autonomyHours(status: EnergySystemStatus): number | null {
  const stored = status.storage?.storedKwh ?? null
  const houseW = status.house?.powerW ?? null
  if (stored === null || houseW === null || houseW <= 0) return null
  return stored / (houseW / 1000)
}

/** Heat pump's share of the house load right now. Null when either power is unknown. */
function heatPumpShareNowPct(status: EnergySystemStatus): number | null {
  const heatPumpW = status.heatPump?.powerW ?? null
  const houseW = status.house?.powerW ?? null
  if (heatPumpW === null || houseW === null || houseW <= 0) return null
  return (heatPumpW / houseW) * 100
}

/** The daily facts of one energy-system slice. Pure; a missing input is null. */
export function energyDailyFacts(status: EnergySystemStatus): EnergyDailyFacts {
  const house = houseConsumptionTodayKwh(status)
  return {
    selfSufficiencyPct: selfSufficiencyPct(house, status.grid?.importTodayKwh ?? null),
    producedKwh: tenth(status.solar?.todayKwh ?? null),
    houseKwh: tenth(house),
    importedKwh: tenth(status.grid?.importTodayKwh ?? null),
    exportedKwh: tenth(status.grid?.exportTodayKwh ?? null),
    autonomyHours: autonomyHours(status),
    chargedTodayKwh: tenth(status.storage?.chargedTodayKwh ?? null),
    dischargedTodayKwh: tenth(status.storage?.dischargedTodayKwh ?? null),
    socPct: status.storage?.stateOfChargePct ?? null,
    healthPct: status.storage?.healthPct ?? null,
    heatPumpShareNowPct: heatPumpShareNowPct(status),
  }
}

/** Today's totals, to a tenth of a kWh; null when the system reports none of them. */
export function energyTodayOf(status: EnergySystemStatus): EnergyToday | null {
  const facts = energyDailyFacts(status)
  const today: EnergyToday = {
    producedKwh: facts.producedKwh,
    selfConsumptionPct: energySystemSelfConsumptionPct(status),
    importedKwh: facts.importedKwh,
    exportedKwh: facts.exportedKwh,
    heatPumpKwh: tenth(status.heatPump?.todayKwh ?? null),
    houseKwh: facts.houseKwh,
    selfSufficiencyPct: facts.selfSufficiencyPct,
    autonomyHours: facts.autonomyHours,
    chargedTodayKwh: facts.chargedTodayKwh,
    dischargedTodayKwh: facts.dischargedTodayKwh,
    socPct: facts.socPct,
    healthPct: facts.healthPct,
    heatPumpShareNowPct: facts.heatPumpShareNowPct,
  }
  return Object.values(today).some((v) => v !== null) ? today : null
}
