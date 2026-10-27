import {
  BaseDevice,
  batteryCapability,
  type BatteryStatus,
  type DeviceContext,
  type DeviceFeature,
  errMsg,
  type InferNativeProvider,
  meterCapability,
  type MeterStatus,
  numericSensorCapability,
  type NumericSensorStatus,
  powerMeterCapability,
  type PowerMeterStatus,
} from '@camstack/types'
import { z } from 'zod'
import { ENPAL_SYSTEM } from '../config.js'
import { computeSlices, findSpec, type EnpalSpec, type SpecSlices } from '../enpal-catalog.js'
import { LifetimeCounterGuard } from '../enpal-counter-guard.js'
import { enpalConnections } from '../enpal-resolver.js'

const POWER_CAP = powerMeterCapability.name
const BATTERY_CAP = batteryCapability.name
const METER_CAP = meterCapability.name
const NUMERIC_CAP = numericSensorCapability.name

const POWER_COLD: PowerMeterStatus = { lastFetchedAt: 0 }
const BATTERY_COLD: BatteryStatus = {
  percentage: null,
  charging: 'unknown',
  sleeping: false,
  lastUpdated: 0,
}
const VALUE_COLD: NumericSensorStatus = { value: null, lastFetchedAt: 0 }

/**
 * Persisted config of an Enpal Sensor. `specId` selects the entry of the catalog;
 * `integrationId` selects the integration whose box feeds it.
 */
export const enpalSensorSchema = z.object({
  specId: z.string().min(1).describe('Device catalog entry id'),
  integrationId: z.string().min(1).describe('Owning integration'),
  system: z.literal(ENPAL_SYSTEM).optional(),
})

/**
 * One Enpal data point group (production, state of charge, grid import, ...) as a
 * {@link DeviceType.Sensor} child of an equipment Container. The catalog entry in `specId`
 * says which caps it registers and which box keys feed them; the slices are recomputed from
 * the integration's snapshot on every poll tick.
 *
 * An unreachable box marks the device offline and leaves the slices alone: a failed read is
 * a gap, never a zero (D393). A lifetime counter passes through {@link LifetimeCounterGuard}
 * so one stale low reading cannot become a history reset.
 */
export class EnpalSensorDevice extends BaseDevice<typeof enpalSensorSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly spec: EnpalSpec
  private readonly integrationId: string
  private readonly energyGuard = new LifetimeCounterGuard()
  private readonly meterGuard = new LifetimeCounterGuard()
  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = enpalSensorSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, enpalSensorSchema, { type: ctx.deviceMeta.type })
    const spec = findSpec(cfg.specId)
    if (spec === undefined) throw new Error(`Enpal: unknown device kind "${cfg.specId}"`)
    this.spec = spec
    this.integrationId = cfg.integrationId
    this.online = enpalConnections.getSnapshot(this.integrationId) !== null
    void this.updateSourceInfo({
      id: `${this.integrationId}:${spec.id}`,
      system: ENPAL_SYSTEM,
      ...(spec.kind === 'meter' || spec.kind === 'numeric' ? { quantity: spec.quantity } : {}),
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerCaps()
    this.snapshotUnsub = enpalConnections.onSnapshot(this.integrationId, () => {
      try {
        this.recompute()
      } catch (err) {
        this.ctx.logger.warn('enpal sensor: snapshot handler failed', {
          tags: { deviceId: this.id },
          meta: { spec: this.spec.id, error: errMsg(err) },
        })
      }
    })
    this.recompute()
  }

  override async removeDevice(): Promise<void> {
    this.snapshotUnsub?.()
    this.snapshotUnsub = null
    await super.removeDevice()
  }

  private recompute(): void {
    const snapshot = enpalConnections.getSnapshot(this.integrationId)
    if (snapshot === null) {
      if (this.online) this.markOnline(false)
      return
    }
    if (!this.online) this.markOnline(true)
    const invert =
      enpalConnections.getManager(this.integrationId)?.connection.invertBatteryPower ?? false
    const slices = computeSlices(
      this.spec,
      snapshot,
      { invertBatteryPower: invert },
      snapshot.fetchedAt,
    )
    this.publish(slices)
    for (const line of slices.refusals) {
      this.ctx.logger.warn(`enpal sensor: reading not used, ${line}`, {
        tags: { deviceId: this.id },
        meta: { spec: this.spec.id },
      })
    }
  }

  private publish(slices: SpecSlices): void {
    if (slices.powerMeter !== undefined) {
      const kwh = slices.powerMeter.kwhTotal
      this.runtimeState.setCapState(
        POWER_CAP,
        kwh === undefined
          ? slices.powerMeter
          : { ...slices.powerMeter, kwhTotal: this.energyGuard.accept(kwh) },
      )
    }
    if (slices.battery !== undefined) this.runtimeState.setCapState(BATTERY_CAP, slices.battery)
    if (slices.meter !== undefined) {
      const raw = slices.meter.value
      this.runtimeState.setCapState(METER_CAP, {
        ...slices.meter,
        value: raw === null ? null : this.meterGuard.accept(raw),
      })
    }
    if (slices.numeric !== undefined) this.runtimeState.setCapState(NUMERIC_CAP, slices.numeric)
  }

  private registerCaps(): void {
    switch (this.spec.kind) {
      case 'power-meter':
        this.registerPowerMeter()
        return
      case 'battery':
        this.registerBattery()
        this.registerPowerMeter()
        return
      case 'meter': {
        const provider: InferNativeProvider<typeof meterCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<MeterStatus>(METER_CAP) ?? VALUE_COLD,
        }
        this.ctx.registerNativeCap(meterCapability, provider)
        this.runtimeState.setCapState(METER_CAP, VALUE_COLD)
        return
      }
      case 'numeric': {
        const provider: InferNativeProvider<typeof numericSensorCapability> = {
          getStatus: async () =>
            this.runtimeState.getCapState<NumericSensorStatus>(NUMERIC_CAP) ?? VALUE_COLD,
        }
        this.ctx.registerNativeCap(numericSensorCapability, provider)
        this.runtimeState.setCapState(NUMERIC_CAP, VALUE_COLD)
        return
      }
    }
  }

  private registerPowerMeter(): void {
    const provider: InferNativeProvider<typeof powerMeterCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<PowerMeterStatus>(POWER_CAP) ?? POWER_COLD,
    }
    this.ctx.registerNativeCap(powerMeterCapability, provider)
    this.runtimeState.setCapState(POWER_CAP, POWER_COLD)
  }

  private registerBattery(): void {
    const provider: InferNativeProvider<typeof batteryCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<BatteryStatus>(BATTERY_CAP) ?? BATTERY_COLD,
      // The box battery has no wake path.
      wakeForStream: async () => ({ awoke: false, durationMs: 0 }),
    }
    this.ctx.registerNativeCap(batteryCapability, provider)
    this.runtimeState.setCapState(BATTERY_CAP, BATTERY_COLD)
  }
}
