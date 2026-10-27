import type { Sensor } from '@apocaliss92/nodewitt'
import {
  ambientLightSensorCapability,
  BaseDevice,
  type BatteryStatus,
  batteryCapability,
  type DeviceContext,
  type DeviceFeature,
  errMsg,
  humiditySensorCapability,
  ingestReading,
  type InferNativeProvider,
  numericSensorCapability,
  quantityFromUnit,
  type ReadingQuantity,
  pressureSensorCapability,
  temperatureSensorCapability,
} from '@camstack/types'
import { z } from 'zod'
import { ecowittFacades } from '../ecowitt-gateway.js'
import {
  batteryModeForUnit,
  capForQuantity,
  readingQuantityFor,
  type EcowittSensorCap,
  valueFieldForCap,
} from '../ecowitt-mapping.js'

/**
 * Persisted config every Ecowitt sensor child carries. `sensorId` resolves the
 * live reading from the gateway's client; `gatewayId` selects the gateway (its
 * Hub stableId); `quantity` is the Ecowitt physical quantity that drives the cap
 * selection; `system`/`integrationId` are provenance.
 */
export const ecowittSensorSchema = z.object({
  sensorId: z.string().min(1).describe('Ecowitt sensor stable id'),
  gatewayId: z.string().min(1).describe('Parent gateway Hub stableId'),
  quantity: z.string().min(1).describe('Ecowitt physical quantity'),
  system: z.literal('ecowitt').optional(),
  integrationId: z.string().optional(),
})

export type EcowittSensorConfig = z.infer<typeof ecowittSensorSchema>

const SUPPORTED_CAPS: ReadonlySet<EcowittSensorCap> = new Set([
  'temperature-sensor',
  'humidity-sensor',
  'pressure-sensor',
  'ambient-light-sensor',
  'numeric-sensor',
])

/**
 * One Ecowitt sensor as a CamStack `Sensor`-type accessory child. Registers ONE
 * typed sensor cap (chosen from the sensor's quantity) and — when the sensor
 * reports a battery — an additional `battery` cap. The slice is fed from the
 * live facade reading on each `sensorChanged` push (and seeded on activate).
 *
 * Battery convention (plan §6.8): Ecowitt sensors carry per-sensor battery, so a
 * separate cap is registered per child (vs the vacuum's embedded field). The
 * library discriminates two battery forms via `batteryUnit`:
 *   - `'%'` (binary/bar batteries, already decoded to a percent) → the typed
 *     `battery` cap (which models a 0..100 percentage).
 *   - `'V'` (raw voltage, e.g. WS90/WH90/WS85 capacitor + soil/leaf push) →
 *     `battery.voltage`. A voltage has no honest percentage, so `level`
 *     stays null. The field lives on `battery`, so a numeric primary sensor
 *     and a voltage battery do not share a slice.
 */
export class EcowittSensorDevice extends BaseDevice<typeof ecowittSensorSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly sensorId: string
  private readonly gatewayId: string
  private readonly capName: EcowittSensorCap
  private readonly valueKey: string
  private readonly ecowittQuantity: string
  /**
   * Which battery cap (if any) was registered for this sensor:
   *   - `'percent'` → the typed `battery` cap (percentage),
   *   - `'voltage'` → `battery.voltage` (level stays null),
   *   - `'none'`    → no battery cap.
   */
  private batteryMode: 'percent' | 'voltage' | 'none' = 'none'

  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const persisted = ecowittSensorSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, ecowittSensorSchema, { type: ctx.deviceMeta.type })
    this.sensorId = persisted.sensorId
    this.gatewayId = persisted.gatewayId
    const cap = capForQuantity(persisted.quantity)
    this.capName = SUPPORTED_CAPS.has(cap) ? cap : 'numeric-sensor'
    this.valueKey = valueFieldForCap(this.capName)
    this.ecowittQuantity = String(persisted.quantity)
    this.online = true
    const named = readingQuantityFor(persisted.quantity)
    void this.updateSourceInfo({
      id: this.sensorId,
      system: 'ecowitt',
      ...(this.capName === 'numeric-sensor' && named !== null ? { quantity: named } : {}),
    })
  }

  private resolveSensor(): Sensor | null {
    return ecowittFacades.getSensor(this.gatewayId, this.sensorId)
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    // Register the cap(s) + seed cold-start, THEN attach the live listener and
    // replay the current value (mirrors the HA / Dreame ordering: registerNativeCap
    // first so the slice schema is installed before any setCapState).
    this.registerSensorCap()
    this.maybeRegisterBatteryCap()
    this.attachSnapshotListener()
    this.recomputeSlice()
  }

  override async removeDevice(): Promise<void> {
    if (this.snapshotUnsub) {
      try {
        this.snapshotUnsub()
      } catch {
        // best-effort
      }
      this.snapshotUnsub = null
    }
  }

  /** Subscribe to per-gateway snapshot ticks (recompute this sensor's slice).
   *  Uses the resolver's shared fan-out bus rather than the facade EventEmitter
   *  directly, so N sensors on one gateway never trip Node's MaxListeners cap.
   *  Works even before the facade exists — `recomputeSlice` no-ops on a missing
   *  sensor and replays once the gateway pumps the first snapshot. */
  private attachSnapshotListener(): void {
    const onSnapshot = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('ecowitt sensor: snapshot handler error', {
          meta: { sensorId: this.sensorId, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = ecowittFacades.onSnapshot(this.gatewayId, onSnapshot)
  }

  /** Recompute + write this sensor's typed cap slice (+ battery) from the live reading. */
  private recomputeSlice(): void {
    const sensor = this.resolveSensor()
    if (sensor === null) return
    const lastFetchedAt = sensor.lastUpdated || Date.now()
    const stored = this.toBase(sensor.value, sensor.unit)
    const slice: Record<string, unknown> = {
      [this.valueKey]: stored === null ? null : clampForCap(this.capName, stored),
      lastFetchedAt,
    }
    this.runtimeState.setCapState(this.capName, slice)

    if (
      this.batteryMode === 'percent' &&
      sensor.batteryUnit === '%' &&
      typeof sensor.battery === 'number'
    ) {
      const next: BatteryStatus = {
        level: Math.max(0, Math.min(100, sensor.battery)),
        charging: 'none',
        sleeping: false,
        lastUpdated: lastFetchedAt,
      }
      this.runtimeState.setCapState('battery', next)
    }

    if (
      this.batteryMode === 'voltage' &&
      sensor.batteryUnit === 'V' &&
      typeof sensor.battery === 'number' &&
      Number.isFinite(sensor.battery)
    ) {
      const next: BatteryStatus = {
        level: null,
        voltage: sensor.battery,
        charging: 'none',
        sleeping: false,
        lastUpdated: lastFetchedAt,
      }
      this.runtimeState.setCapState('battery', next)
    }
  }

  private registerSensorCap(): void {
    switch (this.capName) {
      case 'temperature-sensor': {
        const COLD = { temperature: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
          getStatus: async () => this.readSlice(COLD),
        }
        this.ctx.registerNativeCap(temperatureSensorCapability, provider)
        this.runtimeState.setCapState(this.capName, COLD)
        return
      }
      case 'humidity-sensor': {
        const COLD = { humidity: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof humiditySensorCapability> = {
          getStatus: async () => this.readSlice(COLD),
        }
        this.ctx.registerNativeCap(humiditySensorCapability, provider)
        this.runtimeState.setCapState(this.capName, COLD)
        return
      }
      case 'pressure-sensor': {
        const COLD = { pressure: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof pressureSensorCapability> = {
          getStatus: async () => this.readSlice(COLD),
        }
        this.ctx.registerNativeCap(pressureSensorCapability, provider)
        this.runtimeState.setCapState(this.capName, COLD)
        return
      }
      case 'ambient-light-sensor': {
        const COLD = { illuminance: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof ambientLightSensorCapability> = {
          getStatus: async () => this.readSlice(COLD),
        }
        this.ctx.registerNativeCap(ambientLightSensorCapability, provider)
        this.runtimeState.setCapState(this.capName, COLD)
        return
      }
      case 'numeric-sensor': {
        const COLD = { value: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof numericSensorCapability> = {
          getStatus: async () => this.readSlice(COLD),
        }
        this.ctx.registerNativeCap(numericSensorCapability, provider)
        this.runtimeState.setCapState(this.capName, COLD)
        return
      }
    }
  }

  /**
   * Register the `battery` cap. Percent batteries fill `level`. Voltage
   * batteries fill `voltage` and leave `level` null.
   */
  private maybeRegisterBatteryCap(): void {
    const sensor = this.resolveSensor()
    if (sensor === null) return
    const mode = batteryModeForUnit(sensor.batteryUnit)
    if (mode === 'percent') {
      this.registerPercentBatteryCap()
    } else if (mode === 'voltage') {
      this.registerVoltageBatteryCap()
    }
  }

  /** Register the typed `battery` (percentage) cap for a `%`-unit battery. */
  private registerPercentBatteryCap(): void {
    const COLD: BatteryStatus = {
      level: 0,
      charging: 'none',
      sleeping: false,
      lastUpdated: 0,
    }
    const provider: InferNativeProvider<typeof batteryCapability> = {
      getStatus: async () => this.runtimeState.getCapState<BatteryStatus>('battery') ?? COLD,
      // Ecowitt sensors are read-only — there is no wake path.
      wakeForStream: async () => ({ awoke: true, durationMs: 0 }),
    }
    this.ctx.registerNativeCap(batteryCapability, provider)
    this.runtimeState.setCapState('battery', COLD)
    this.batteryMode = 'percent'
  }

  /** Voltage batteries share the `battery` cap. `level` stays unknown. */
  private registerVoltageBatteryCap(): void {
    const COLD: BatteryStatus = {
      level: null,
      voltage: null,
      charging: 'unknown',
      sleeping: false,
      lastUpdated: 0,
    }
    const provider: InferNativeProvider<typeof batteryCapability> = {
      getStatus: async () => this.runtimeState.getCapState<BatteryStatus>('battery') ?? COLD,
      wakeForStream: async () => ({ awoke: true, durationMs: 0 }),
    }
    this.ctx.registerNativeCap(batteryCapability, provider)
    this.runtimeState.setCapState('battery', COLD)
    this.batteryMode = 'voltage'
  }

  private readSlice<T extends Record<string, unknown>>(fallback: T): T {
    return this.runtimeState.getCapState<T>(this.capName) ?? fallback
  }

  /** Station number → the quantity's base. An unknown unit publishes null. */
  private toBase(value: number, unit: string): number | null {
    const named = readingQuantityFor(this.ecowittQuantity)
    const fromUnit = unit.length === 0 ? undefined : quantityFromUnit(unit)
    const quantity: ReadingQuantity | null =
      named ?? (unit.length === 0 ? 'none' : (fromUnit ?? null))
    if (quantity === null || quantity === 'device') {
      this.ctx.logger.warn('numeric reading refused', {
        tags: { deviceId: this.id },
        meta: { quantity: 'device', unit, reason: 'unknown-unit' },
      })
      return null
    }
    const result = ingestReading({
      value,
      rawUnit: unit.length > 0 ? unit : undefined,
      quantity,
    })
    if (!result.ok) {
      this.ctx.logger.warn('numeric reading refused', {
        tags: { deviceId: this.id },
        meta: { quantity, unit, reason: result.reason },
      })
      return null
    }
    if (this.capName === 'numeric-sensor' && this.sourceInfo.quantity !== quantity) {
      void this.updateSourceInfo({ quantity })
    }
    return result.value
  }
}

/** Clamp a raw SI value to the cap's slice constraints (humidity/lux are bounded). */
function clampForCap(cap: EcowittSensorCap, value: number): number {
  if (!Number.isFinite(value)) return 0
  if (cap === 'humidity-sensor') return Math.max(0, Math.min(100, value))
  if (cap === 'ambient-light-sensor') return Math.max(0, value)
  return value
}
