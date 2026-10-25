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
  type InferNativeProvider,
  numericSensorCapability,
  pressureSensorCapability,
  temperatureSensorCapability,
} from '@camstack/types'
import { z } from 'zod'
import { ecowittFacades } from '../ecowitt-gateway.js'
import {
  batteryModeForUnit,
  capForQuantity,
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

/**
 * Slice key the V-battery `numeric-sensor` cap writes/reads. It is the cap's own
 * name (`'numeric-sensor'`) — the same key the codegen `getStatus` reads — so
 * the manual `setCapState` here lands in the slice the framework serves. Only
 * registered when the PRIMARY cap is NOT itself `numeric-sensor` (no collision).
 */
const BATTERY_VOLTAGE_CAP = numericSensorCapability.name

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
 *   - `'V'` (raw voltage, e.g. WS90/WH90/WS85 capacitor + soil/leaf push) → a
 *     `numeric-sensor` cap carrying the voltage with `unit: 'V'`. A voltage has
 *     no honest percentage, so the percentage-shaped `battery` cap would be
 *     wrong; the generic numeric cap renders the volts verbatim.
 *
 * A child registers AT MOST one battery cap. When the child's PRIMARY sensor cap
 * is itself `numeric-sensor` (e.g. a precipitation channel) a V-battery cannot
 * also be hosted as a second `numeric-sensor` on the same device (the cap slice
 * is keyed by cap name) — that rare case is skipped with a debug note rather
 * than adding a new cap.
 */
export class EcowittSensorDevice extends BaseDevice<typeof ecowittSensorSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly sensorId: string
  private readonly gatewayId: string
  private readonly capName: EcowittSensorCap
  private readonly valueKey: string
  /**
   * Which battery cap (if any) was registered for this sensor:
   *   - `'percent'` → the typed `battery` cap (percentage),
   *   - `'voltage'` → a `numeric-sensor` cap carrying volts (unit `'V'`),
   *   - `'none'`    → no battery cap (no battery, or a V-battery on a sensor
   *     whose primary cap is already `numeric-sensor`).
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
    this.online = true
    void this.updateSourceInfo({ id: this.sensorId, system: 'ecowitt' })
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
    const slice: Record<string, unknown> = {
      [this.valueKey]: clampForCap(this.capName, sensor.value),
      lastFetchedAt,
      ...(sensor.unit.length > 0 ? { unit: sensor.unit } : {}),
    }
    this.runtimeState.setCapState(this.capName, slice)

    if (
      this.batteryMode === 'percent' &&
      sensor.batteryUnit === '%' &&
      typeof sensor.battery === 'number'
    ) {
      const next: BatteryStatus = {
        percentage: Math.max(0, Math.min(100, sensor.battery)),
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
      const next = { value: sensor.battery, unit: 'V', lastFetchedAt }
      this.runtimeState.setCapState(BATTERY_VOLTAGE_CAP, next)
    }
  }

  private registerSensorCap(): void {
    switch (this.capName) {
      case 'temperature-sensor': {
        const COLD = { celsius: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof temperatureSensorCapability> = {
          getStatus: async () => this.readSlice(COLD),
        }
        this.ctx.registerNativeCap(temperatureSensorCapability, provider)
        this.runtimeState.setCapState(this.capName, COLD)
        return
      }
      case 'humidity-sensor': {
        const COLD = { percent: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof humiditySensorCapability> = {
          getStatus: async () => this.readSlice(COLD),
        }
        this.ctx.registerNativeCap(humiditySensorCapability, provider)
        this.runtimeState.setCapState(this.capName, COLD)
        return
      }
      case 'pressure-sensor': {
        const COLD = { hpa: 0, lastFetchedAt: 0 }
        const provider: InferNativeProvider<typeof pressureSensorCapability> = {
          getStatus: async () => this.readSlice(COLD),
        }
        this.ctx.registerNativeCap(pressureSensorCapability, provider)
        this.runtimeState.setCapState(this.capName, COLD)
        return
      }
      case 'ambient-light-sensor': {
        const COLD = { lux: 0, lastFetchedAt: 0 }
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
   * Register the per-sensor battery cap matching the sensor's battery form:
   *   - `'%'` → typed `battery` cap (percentage),
   *   - `'V'` → `numeric-sensor` cap carrying volts (unit `'V'`), unless the
   *     sensor's primary cap is already `numeric-sensor` (slice-key collision),
   *     in which case it is skipped with a debug note.
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
      percentage: 0,
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

  /**
   * Register a `numeric-sensor` (unit `'V'`) cap for a raw-voltage battery. The
   * voltage has no honest percentage, so the percentage-shaped `battery` cap is
   * not used. Skipped when the primary cap already occupies the `numeric-sensor`
   * slice on this device (a second instance would collide).
   */
  private registerVoltageBatteryCap(): void {
    if (this.capName === 'numeric-sensor') {
      this.ctx.logger.debug(
        'ecowitt sensor: V-battery not surfaced — primary cap already numeric-sensor',
        { meta: { sensorId: this.sensorId } },
      )
      return
    }
    const COLD = { value: 0, unit: 'V', lastFetchedAt: 0 }
    const provider: InferNativeProvider<typeof numericSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<typeof COLD>(BATTERY_VOLTAGE_CAP) ?? COLD,
    }
    this.ctx.registerNativeCap(numericSensorCapability, provider)
    this.runtimeState.setCapState(BATTERY_VOLTAGE_CAP, COLD)
    this.batteryMode = 'voltage'
  }

  private readSlice<T extends Record<string, unknown>>(fallback: T): T {
    return this.runtimeState.getCapState<T>(this.capName) ?? fallback
  }
}

/** Clamp a raw SI value to the cap's slice constraints (humidity/lux are bounded). */
function clampForCap(cap: EcowittSensorCap, value: number): number {
  if (!Number.isFinite(value)) return 0
  if (cap === 'humidity-sensor') return Math.max(0, Math.min(100, value))
  if (cap === 'ambient-light-sensor') return Math.max(0, value)
  return value
}
