import type {
  EnergyConsumer,
  EnergyGrid,
  EnergySolar,
  EnergyStorage,
  EnergySystemStatus,
} from '@camstack/types'
import {
  computeSlices,
  findSpec,
  type EnpalSliceOptions,
  type SpecSlices,
} from './enpal-catalog.js'
import { LifetimeCounterGuard } from './enpal-counter-guard.js'
import type { EnpalSnapshot } from './enpal-snapshot.js'

/** The `stableIdSuffix` / child key of the Energy system child of the System container. */
export const ENERGY_SYSTEM_CHILD_KEY = 'energy-system'

/** The slice plus one line per reading the box sent that could not be converted. */
export interface EnergySystemComputation {
  readonly status: EnergySystemStatus
  readonly refusals: readonly string[]
}

/**
 * Reads the catalog entries the Sensor children already use, so the Energy system
 * and the sensors agree on every key, unit and sign by construction.
 */
class SpecReader {
  readonly refusals: string[] = []
  private readonly cache = new Map<string, SpecSlices | null>()

  constructor(
    private readonly snapshot: EnpalSnapshot,
    private readonly options: EnpalSliceOptions,
    private readonly now: number,
  ) {}

  private slices(id: string): SpecSlices | null {
    const cached = this.cache.get(id)
    if (cached !== undefined) return cached
    const spec = findSpec(id)
    const out =
      spec === undefined ? null : computeSlices(spec, this.snapshot, this.options, this.now)
    if (out !== null) this.refusals.push(...out.refusals.map((line) => `${id}: ${line}`))
    this.cache.set(id, out)
    return out
  }

  power(id: string): number | null {
    return this.slices(id)?.powerMeter?.power ?? null
  }

  energy(id: string): number | null {
    return this.slices(id)?.powerMeter?.energy ?? null
  }

  numeric(id: string): number | null {
    return this.slices(id)?.numeric?.value ?? null
  }

  meter(id: string): number | null {
    return this.slices(id)?.meter?.value ?? null
  }
}

/** A part whose every value is null is a part the system does not have. */
function present<T extends Readonly<Record<string, number | null>>>(part: T): T | null {
  return Object.values(part).some((v) => v !== null) ? part : null
}

/**
 * The grid power, + import / − export, from the two halves the catalog splits it into.
 * With both halves known it is their difference. With one half only, it is that half
 * while it flows: a zero import with no export reading cannot say whether the house
 * exports, so it is unknown (D393), not "still".
 */
function gridPower(importW: number | null, exportW: number | null): number | null {
  if (importW !== null && exportW !== null) return importW - exportW
  if (importW !== null) return importW > 0 ? importW : null
  if (exportW !== null) return exportW > 0 ? -exportW : null
  return null
}

/**
 * The `energy-system` slice from one snapshot. Signs follow the cap: grid + import,
 * storage + charging (the box's own sign, flipped by "Invert battery power sign").
 */
export function computeEnergySystemStatus(
  snapshot: EnpalSnapshot,
  options: EnpalSliceOptions,
  now: number,
): EnergySystemComputation {
  const read = new SpecReader(snapshot, options, now)
  const solar: EnergySolar = {
    powerW: read.power('pv'),
    energyKwh: read.energy('pv'),
    todayKwh: read.numeric('pv-energy-day'),
  }
  const grid: EnergyGrid = {
    powerW: gridPower(read.power('grid-import'), read.power('grid-export')),
    importKwh: read.energy('grid-import'),
    exportKwh: read.energy('grid-export'),
    importTodayKwh: read.numeric('grid-import-day'),
    exportTodayKwh: read.numeric('grid-export-day'),
  }
  const house: EnergyConsumer = {
    powerW: read.power('house'),
    energyKwh: read.energy('house'),
    todayKwh: read.numeric('house-energy-day'),
  }
  // Enpal reports no day total for the heat pump: the card draws none.
  const heatPump: EnergyConsumer = {
    powerW: read.power('heatpump'),
    energyKwh: read.energy('heatpump'),
    todayKwh: null,
  }
  const storage: EnergyStorage = {
    stateOfChargePct: read.numeric('battery'),
    storedKwh: read.numeric('battery-stored-energy'),
    capacityKwh: read.numeric('battery-capacity'),
    powerW: read.power('battery'),
    chargedKwh: read.meter('battery-charged'),
    dischargedKwh: read.meter('battery-discharged'),
    chargedTodayKwh: read.numeric('battery-charge-day'),
    dischargedTodayKwh: read.numeric('battery-discharge-day'),
    healthPct: read.numeric('battery-health'),
  }
  return {
    status: {
      solar: present(solar),
      grid: present(grid),
      house: present(house),
      heatPump: present(heatPump),
      storage: present(storage),
      lastFetchedAt: now,
    },
    refusals: read.refusals,
  }
}

/**
 * Keeps every lifetime counter of the slice monotonic (one {@link LifetimeCounterGuard}
 * per counter), so one stale low poll never reaches a `counter` history series as a reset.
 * Gauges and day totals pass as read.
 */
export class EnergySystemCounterGuards {
  private readonly guards = new Map<string, LifetimeCounterGuard>()

  private guard(path: string, value: number | null): number | null {
    if (value === null) return null
    let guard = this.guards.get(path)
    if (guard === undefined) {
      guard = new LifetimeCounterGuard()
      this.guards.set(path, guard)
    }
    return guard.accept(value)
  }

  apply(status: EnergySystemStatus): EnergySystemStatus {
    const { solar, grid, house, heatPump, storage } = status
    return {
      ...status,
      solar: solar === null ? null : { ...solar, energyKwh: this.guard('solar', solar.energyKwh) },
      grid:
        grid === null
          ? null
          : {
              ...grid,
              importKwh: this.guard('grid.import', grid.importKwh),
              exportKwh: this.guard('grid.export', grid.exportKwh),
            },
      house: house === null ? null : { ...house, energyKwh: this.guard('house', house.energyKwh) },
      heatPump:
        heatPump === null
          ? null
          : { ...heatPump, energyKwh: this.guard('heatPump', heatPump.energyKwh) },
      storage:
        storage === null
          ? null
          : {
              ...storage,
              chargedKwh: this.guard('storage.charged', storage.chargedKwh),
              dischargedKwh: this.guard('storage.discharged', storage.dischargedKwh),
            },
    }
  }
}
