/**
 * `energy-system` → the energy card. Pure: the connected card reads the slice,
 * these turn it into the scene's node powers and today's totals. The storage
 * is read from the model's `storage` part, never from the `battery` cap (#522).
 */
import type { EnergySystemStatus } from '@camstack/types'
import type { EnergyFlows, EnergySourceSplit, EnergyToday } from '../scenes/energy/model'

/** Derived daily facts. Null is a missing input, not a stand-in for zero. */
export interface EnergyDailyFacts {
  readonly selfSufficiencyPct: number | null
  readonly producedKwh: number | null
  readonly houseKwh: number | null
  readonly importedKwh: number | null
  readonly exportedKwh: number | null
  readonly netGridKwh: number | null
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
    // A grid that exists but has not answered its power keeps its node (as unknown, D393).
    gridPowerUnknown: status.grid !== null && status.grid.powerW === null,
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
function reportedConsumptionTodayKwh(status: EnergySystemStatus): number | null {
  const house = status.house?.todayKwh ?? null
  if (status.heatPump === null) return house
  // The house excludes the heat pump: both day totals are needed to sum them.
  const pump = status.heatPump.todayKwh
  return house === null || pump === null ? null : house + pump
}

function houseConsumptionTodayKwh(status: EnergySystemStatus): number | null {
  const reported = reportedConsumptionTodayKwh(status)
  if (reported !== null) return reported
  return balanceConsumptionKwh(todayBalanceInput(status))
}

function todayBalanceInput(status: EnergySystemStatus): EnergyBalanceInput {
  return {
    producedKwh: status.solar?.todayKwh ?? null,
    importedKwh: status.grid?.importTodayKwh ?? null,
    exportedKwh: status.grid?.exportTodayKwh ?? null,
    chargedKwh: status.storage?.chargedTodayKwh ?? null,
    dischargedKwh: status.storage?.dischargedTodayKwh ?? null,
    heatPumpKwh: status.heatPump?.todayKwh ?? null,
    hasStorage: status.storage !== null,
  }
}

export function selfSufficiencyPct(
  houseKwh: number | null,
  importKwh: number | null,
): number | null {
  if (houseKwh === null || importKwh === null || houseKwh <= 0) return null
  return Math.max(0, Math.min(100, (1 - importKwh / houseKwh) * 100))
}

/**
 * Self-consumption: the share of the production that was not exported, 0..100.
 * Null when the production or the export is unknown, or nothing was produced (D393).
 */
export function selfConsumptionPct(
  producedKwh: number | null,
  exportedKwh: number | null,
): number | null {
  if (producedKwh === null || exportedKwh === null || producedKwh <= 0) return null
  return Math.max(0, Math.min(100, ((producedKwh - exportedKwh) / producedKwh) * 100))
}

/** Net grid, kWh: imported − exported (+ drew, − fed). Null unless both are known. */
export function netGridKwh(importedKwh: number | null, exportedKwh: number | null): number | null {
  if (importedKwh === null || exportedKwh === null) return null
  return tenth(importedKwh - exportedKwh)
}

/**
 * Everything the installation consumes right now: the house (which excludes the heat
 * pump) plus the heat pump. Null when a part that exists has no reading (D393).
 */
function totalConsumptionW(status: EnergySystemStatus): number | null {
  const houseW = status.house?.powerW ?? null
  if (status.heatPump === null) return houseW
  const pumpW = status.heatPump.powerW
  if (pumpW === null) return null
  if (status.house === null) return pumpW
  return houseW === null ? null : houseW + pumpW
}

/** Stored kWh ÷ current total load (kW). Hidden when the load is ≤ 0 or unknown. */
function autonomyHours(status: EnergySystemStatus): number | null {
  const stored = status.storage?.storedKwh ?? null
  const houseW = totalConsumptionW(status)
  if (stored === null || houseW === null || houseW <= 0) return null
  return stored / (houseW / 1000)
}

/** Heat pump's share of the total consumption (house + heat pump) right now, 0..100. */
function heatPumpShareNowPct(status: EnergySystemStatus): number | null {
  const heatPumpW = status.heatPump?.powerW ?? null
  const totalW = totalConsumptionW(status)
  if (heatPumpW === null || totalW === null || totalW <= 0) return null
  return Math.max(0, Math.min(100, (heatPumpW / totalW) * 100))
}

/** The day totals the energy balance reads, kWh; null = that counter is unknown. */
export interface EnergyBalanceInput {
  readonly producedKwh: number | null
  readonly importedKwh: number | null
  readonly exportedKwh: number | null
  readonly chargedKwh: number | null
  readonly dischargedKwh: number | null
  readonly heatPumpKwh: number | null
  /** The system has a battery: its two counters must be known, a missing pair is not 0. */
  readonly hasStorage: boolean
}

export interface EnergyBalance {
  /** produced + imported − exported + discharged − charged; null when an input is unknown. */
  readonly consumptionKwh: number | null
  /** The consumption minus the heat pump, floored at 0. */
  readonly householdKwh: number | null
  /** 1 − imported / consumption, 0..100. */
  readonly selfSufficiencyPct: number | null
  readonly sources: EnergySourceSplit | null
}

/**
 * produced + imported − exported + discharged − charged. The storage counters
 * are both absent only for a system without storage (no contribution); a system
 * with storage needs both, and one known alone is an unknown balance (D393).
 */
export function balanceConsumptionKwh(input: EnergyBalanceInput): number | null {
  const { producedKwh: p, importedKwh: i, exportedKwh: x, chargedKwh: c, dischargedKwh: d } = input
  if (p === null || i === null || x === null || (c === null) !== (d === null)) return null
  if (input.hasStorage && c === null) return null
  return p + i - x + (d ?? 0) - (c ?? 0)
}

const share = (kwh: number, of: number): number => Math.max(0, Math.min(100, (kwh / of) * 100))

/**
 * The energy balance of a day: what was consumed and where it came from. The
 * storage counters are both absent for a system without storage (no
 * contribution); only one of them known is an unknown balance (D393).
 */
export function energyBalance(input: EnergyBalanceInput, hasHeatPump: boolean): EnergyBalance {
  const { producedKwh: p, importedKwh: i, exportedKwh: x, chargedKwh: c, dischargedKwh: d } = input
  const consumption = balanceConsumptionKwh(input)
  const household =
    consumption === null
      ? null
      : !hasHeatPump
        ? consumption
        : input.heatPumpKwh === null
          ? null
          : Math.max(0, consumption - input.heatPumpKwh)
  const sources =
    consumption === null || consumption <= 0 || p === null || i === null || x === null
      ? null
      : {
          solarPct: share(Math.max(0, p - x - (c ?? 0)), consumption),
          batteryPct: share(d ?? 0, consumption),
          gridPct: share(i, consumption),
        }
  return {
    consumptionKwh: tenth(consumption),
    householdKwh: tenth(household),
    selfSufficiencyPct: selfSufficiencyPct(consumption, i),
    sources,
  }
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
    netGridKwh: netGridKwh(
      status.grid?.importTodayKwh ?? null,
      status.grid?.exportTodayKwh ?? null,
    ),
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
  const balance = energyBalance(todayBalanceInput(status), status.heatPump !== null)
  const today: EnergyToday = {
    producedKwh: facts.producedKwh,
    selfConsumptionPct: selfConsumptionPct(
      status.solar?.todayKwh ?? null,
      status.grid?.exportTodayKwh ?? null,
    ),
    importedKwh: facts.importedKwh,
    exportedKwh: facts.exportedKwh,
    netGridKwh: facts.netGridKwh,
    heatPumpKwh: tenth(status.heatPump?.todayKwh ?? null),
    houseKwh: facts.houseKwh,
    householdKwh: tenth(status.house?.todayKwh ?? null) ?? balance.householdKwh,
    sources: balance.sources,
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
