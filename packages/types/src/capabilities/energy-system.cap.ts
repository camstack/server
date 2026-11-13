import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Energy system (#513): the one READ-ONLY cap of a home energy installation —
 * solar production, the grid connection, the house, a heat pump where the
 * system meters one, and the storage. Each part is a branch of one bus.
 *
 * A part the system does not have is `null` (the whole object); a value the
 * system did not report is `null`, never `0` (D393).
 *
 * Signs, all in watts:
 * - `solar.powerW`, `house.powerW`, `heatPump.powerW` are magnitudes (≥ 0);
 * - `grid.powerW` is + importing, − exporting;
 * - `storage.powerW` is + charging, − discharging.
 *
 * The storage is a FIELD of this model, never the `battery` cap: that cap says
 * a device runs on a battery and feeds the low-battery alerts, and a home
 * storage at 19 % is not a device about to go flat (#522).
 *
 * Lifetime kWh are counters (D944); a `…TodayKwh` is the system's own day total.
 * The self-consumption share is not a field: it derives at read time
 * ({@link energySystemSelfConsumptionPct}).
 */

/** Production: the panels. */
export const EnergySolarSchema = z.object({
  powerW: z.number().nullable().meta(readingMeta('power')),
  /** Lifetime production, kWh. */
  energyKwh: z.number().nullable().meta(readingMeta('energy')),
  /** Produced today, kWh. */
  todayKwh: z.number().nullable().meta(readingMeta('energy')),
})
export type EnergySolar = z.infer<typeof EnergySolarSchema>

/** The grid connection: + import, − export. */
export const EnergyGridSchema = z.object({
  powerW: z.number().nullable().meta(readingMeta('power')),
  /** Lifetime imported, kWh. */
  importKwh: z.number().nullable().meta(readingMeta('energy')),
  /** Lifetime exported, kWh. */
  exportKwh: z.number().nullable().meta(readingMeta('energy')),
  importTodayKwh: z.number().nullable().meta(readingMeta('energy')),
  exportTodayKwh: z.number().nullable().meta(readingMeta('energy')),
})
export type EnergyGrid = z.infer<typeof EnergyGridSchema>

/** A consumer on the bus (the house, the heat pump): power and energy drawn. */
export const EnergyConsumerSchema = z.object({
  powerW: z.number().nullable().meta(readingMeta('power')),
  /** Lifetime consumption, kWh. */
  energyKwh: z.number().nullable().meta(readingMeta('energy')),
  /** Consumed today, kWh. */
  todayKwh: z.number().nullable().meta(readingMeta('energy')),
})
export type EnergyConsumer = z.infer<typeof EnergyConsumerSchema>

/** The home storage (accumulo): + charging, − discharging. */
export const EnergyStorageSchema = z.object({
  /** State of charge, 0..100. */
  stateOfChargePct: z.number().nullable().meta(readingMeta('percentage')),
  /** Energy held now, kWh. */
  storedKwh: z.number().nullable().meta(readingMeta('energy')),
  /** Usable capacity, kWh. */
  capacityKwh: z.number().nullable().meta(readingMeta('energy')),
  powerW: z.number().nullable().meta(readingMeta('power')),
  /** Lifetime charged, kWh. */
  chargedKwh: z.number().nullable().meta(readingMeta('energy')),
  /** Lifetime discharged, kWh. */
  dischargedKwh: z.number().nullable().meta(readingMeta('energy')),
  chargedTodayKwh: z.number().nullable().meta(readingMeta('energy')),
  dischargedTodayKwh: z.number().nullable().meta(readingMeta('energy')),
})
export type EnergyStorage = z.infer<typeof EnergyStorageSchema>

export const EnergySystemStatusSchema = z.object({
  solar: EnergySolarSchema.nullable(),
  grid: EnergyGridSchema.nullable(),
  house: EnergyConsumerSchema.nullable(),
  heatPump: EnergyConsumerSchema.nullable(),
  storage: EnergyStorageSchema.nullable(),
  /** Ms epoch when the slice was last read from the system. */
  lastFetchedAt: z.number(),
})
export type EnergySystemStatus = z.infer<typeof EnergySystemStatusSchema>

/**
 * Today's self-consumption: the share of today's production that was not
 * exported, in percent. Null unless both totals are known and something was
 * produced — a missing total is never a 0 or a division by it (D393).
 */
export function energySystemSelfConsumptionPct(status: EnergySystemStatus): number | null {
  const produced = status.solar?.todayKwh ?? null
  const exported = status.grid?.exportTodayKwh ?? null
  if (produced === null || exported === null || produced <= 0) return null
  return Math.max(0, Math.min(100, ((produced - exported) / produced) * 100))
}

export const energySystemCapability = {
  name: 'energy-system',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.EnergySystem],
  methods: {},
  status: {
    schema: EnergySystemStatusSchema,
    kind: 'push',
  },
  runtimeState: EnergySystemStatusSchema,
  /**
   * Runtime-state durability: **session** — the system answers on the next
   * poll, so a restart that clears the slice loses nothing a reader needs (the
   * series are recorded). See `RuntimeStateDurability`.
   */
  durability: 'session',
  /**
   * History (D850): every power is a gauge, every lifetime kWh a counter (the
   * kWh of a period is computed at read time, D944). A part the system does not
   * have is null and records nothing. Day totals are not recorded: they are the
   * counters' difference over the day.
   */
  history: {
    fields: {
      'solar.powerW': { kind: 'gauge', unit: 'W', deadband: 50, displayName: 'Solar power' },
      'solar.energyKwh': { kind: 'counter', unit: 'kWh', displayName: 'Solar energy' },
      'grid.powerW': { kind: 'gauge', unit: 'W', deadband: 50, displayName: 'Grid power' },
      'grid.importKwh': { kind: 'counter', unit: 'kWh', displayName: 'Grid import' },
      'grid.exportKwh': { kind: 'counter', unit: 'kWh', displayName: 'Grid export' },
      'house.powerW': { kind: 'gauge', unit: 'W', deadband: 50, displayName: 'House power' },
      'house.energyKwh': { kind: 'counter', unit: 'kWh', displayName: 'House energy' },
      'heatPump.powerW': {
        kind: 'gauge',
        unit: 'W',
        deadband: 50,
        displayName: 'Heat pump power',
      },
      'heatPump.energyKwh': { kind: 'counter', unit: 'kWh', displayName: 'Heat pump energy' },
      'storage.stateOfChargePct': {
        kind: 'gauge',
        unit: '%',
        deadband: 1,
        displayName: 'Storage charge',
      },
      'storage.storedKwh': {
        kind: 'gauge',
        unit: 'kWh',
        deadband: 0.05,
        displayName: 'Stored energy',
      },
      'storage.powerW': {
        kind: 'gauge',
        unit: 'W',
        deadband: 50,
        displayName: 'Storage power',
      },
      'storage.chargedKwh': { kind: 'counter', unit: 'kWh', displayName: 'Storage charged' },
      'storage.dischargedKwh': {
        kind: 'counter',
        unit: 'kWh',
        displayName: 'Storage discharged',
      },
    },
  },
  volatileStateFields: ['lastFetchedAt'],
  vocabulary: { noun: t('Energy system', 'Sistema energetico'), order: 4020 },
} as const satisfies CapabilityDefinition

export type IEnergySystemProvider = InferProvider<typeof energySystemCapability>
