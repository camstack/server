import {
  airQualitySensorCapability,
  type AirQualitySensorStatus,
  BaseDevice,
  binaryCapability,
  type BinaryStatus,
  type DeviceContext,
  type DeviceFeature,
  errMsg,
  humiditySensorCapability,
  type HumiditySensorStatus,
  type InferNativeProvider,
  numericSensorCapability,
  type NumericSensorStatus,
} from '@dominevo/types'
import { vesyncSensorSchema, type VeSyncSensorKind } from '../config.js'
import type {
  VeSyncDeviceSnapshot,
  VeSyncHumidifierSnapshot,
  VeSyncPurifierSnapshot,
} from '../vesync-client-contract.js'
import { vesyncAccounts } from '../vesync-account-resolver.js'

const AQ_CAP = airQualitySensorCapability.name
const NUMERIC_CAP = numericSensorCapability.name
const HUMIDITY_CAP = humiditySensorCapability.name
const BINARY_CAP = binaryCapability.name

const AQ_COLD_START: AirQualitySensorStatus = { lastFetchedAt: 0 }
const FILTER_COLD_START: NumericSensorStatus = { value: 0, lastFetchedAt: 0 }
const HUMIDITY_COLD_START: HumiditySensorStatus = { humidity: null, lastFetchedAt: 0 }

/**
 * One VeSync read-only metric as a Dominevo
 * {@link import('@dominevo/types').DeviceType.Sensor} accessory child.
 *
 * Of a purifier (Fan):
 *   - `air-quality`  → the `air-quality-sensor` cap (PM2.5 in µg/m³).
 *   - `filter-life`  → the `numeric-sensor` cap carrying the remaining filter
 *     life as a percent (unit `%`).
 * Of a humidifier:
 *   - `humidity`     → the `humidity-sensor` cap (measured relative humidity).
 *   - `water-low`    → the `binary` cap, on while the water tank is empty.
 *
 * `purifierNativeId` is the parent's VeSync cid, whatever its kind. The slice is fed
 * from the live device snapshot on each poll tick and after each command's refresh
 * (seeded cold on activate, except water-low: it stays unset until a real read).
 * No methods — every cap here is a read-only push slice.
 */
export class VeSyncSensorDevice extends BaseDevice<typeof vesyncSensorSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly kind: VeSyncSensorKind
  private readonly purifierNativeId: string
  private readonly integrationId: string

  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = vesyncSensorSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, vesyncSensorSchema, { type: ctx.deviceMeta.type })
    this.kind = cfg.kind
    this.purifierNativeId = cfg.purifierNativeId
    this.integrationId = cfg.integrationId
    this.online =
      vesyncAccounts.getDevice(this.integrationId, this.purifierNativeId)?.online ?? false
    void this.updateSourceInfo({
      id: `${this.integrationId}:${this.purifierNativeId}:${this.kind}`,
      system: 'vesync',
      ...(this.kind === 'filter-life' ? { quantity: 'percentage' as const } : {}),
    })
  }

  override async onActivate(): Promise<void> {
    await super.onActivate()
    this.registerSensorCap()
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
    await super.removeDevice()
  }

  private attachSnapshotListener(): void {
    const onSnapshot = (): void => {
      try {
        this.recomputeSlice()
      } catch (err) {
        this.ctx.logger.warn('vesync sensor: snapshot handler error', {
          tags: { deviceId: this.id },
          meta: { kind: this.kind, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = vesyncAccounts.onSnapshot(this.integrationId, onSnapshot)
  }

  /** Recompute + write this sensor's cap slice from the live snapshot. */
  private recomputeSlice(): void {
    const device = vesyncAccounts.getDevice(this.integrationId, this.purifierNativeId)
    if (device === null) return
    if (this.online !== device.online) this.markOnline(device.online)
    this.writeSlice(device, Date.now())
  }

  private writeSlice(device: VeSyncDeviceSnapshot, now: number): void {
    if (device.kind === 'purifier') {
      if (this.kind === 'air-quality') {
        this.runtimeState.setCapState(AQ_CAP, airQualitySlice(device, now))
      } else if (this.kind === 'filter-life') {
        this.runtimeState.setCapState(NUMERIC_CAP, filterLifeSlice(device, now))
      }
      return
    }
    if (this.kind === 'humidity') {
      this.runtimeState.setCapState(HUMIDITY_CAP, humiditySlice(device, now))
    } else if (this.kind === 'water-low') {
      this.writeWaterLow(device, now)
    }
  }

  /** The tank flag; a snapshot that does not report it leaves the slice alone. */
  private writeWaterLow(device: VeSyncHumidifierSnapshot, now: number): void {
    const previous = this.runtimeState.getCapState<BinaryStatus>(BINARY_CAP)
    const next = waterLowNext(previous, device.waterLacks, now)
    if (next !== null) this.runtimeState.setCapState(BINARY_CAP, next)
  }

  private registerSensorCap(): void {
    if (this.kind === 'humidity') {
      const provider: InferNativeProvider<typeof humiditySensorCapability> = {
        getStatus: async () =>
          this.runtimeState.getCapState<HumiditySensorStatus>(HUMIDITY_CAP) ?? HUMIDITY_COLD_START,
      }
      this.ctx.registerNativeCap(humiditySensorCapability, provider)
      this.runtimeState.setCapState(HUMIDITY_CAP, HUMIDITY_COLD_START)
      return
    }
    if (this.kind === 'water-low') {
      // No cold-start seed: `binary` has no "unknown", and a seeded `false` reads "tank OK".
      const provider: InferNativeProvider<typeof binaryCapability> = {
        getStatus: async () =>
          waterLowStatus(this.runtimeState.getCapState<BinaryStatus>(BINARY_CAP)),
      }
      this.ctx.registerNativeCap(binaryCapability, provider)
      return
    }
    if (this.kind === 'air-quality') {
      const provider: InferNativeProvider<typeof airQualitySensorCapability> = {
        getStatus: async () =>
          this.runtimeState.getCapState<AirQualitySensorStatus>(AQ_CAP) ?? AQ_COLD_START,
      }
      this.ctx.registerNativeCap(airQualitySensorCapability, provider)
      this.runtimeState.setCapState(AQ_CAP, AQ_COLD_START)
      return
    }
    const provider: InferNativeProvider<typeof numericSensorCapability> = {
      getStatus: async () =>
        this.runtimeState.getCapState<NumericSensorStatus>(NUMERIC_CAP) ?? FILTER_COLD_START,
    }
    this.ctx.registerNativeCap(numericSensorCapability, provider)
    this.runtimeState.setCapState(NUMERIC_CAP, FILTER_COLD_START)
  }
}

/**
 * The water-low slice to write for a reported tank, or `null` to leave it: nothing reported
 * (`null`, the tank was not read) or no change since the last real read.
 */
export function waterLowNext(
  previous: BinaryStatus | undefined,
  waterLacks: boolean | null,
  now: number,
): BinaryStatus | null {
  if (waterLacks === null) return null
  if (previous !== undefined && previous.on === waterLacks) return null
  return { on: waterLacks, lastChangedAt: now }
}

/** The water-low status; refused until a real read reported the tank (D315: unknown ≠ OK). */
export function waterLowStatus(current: BinaryStatus | undefined): BinaryStatus {
  if (current === undefined) {
    throw new Error('vesync: water tank not read yet — no status until the device reports it')
  }
  return current
}

/** Map a purifier snapshot's air-quality PM2.5 onto the air-quality-sensor slice. */
function airQualitySlice(purifier: VeSyncPurifierSnapshot, now: number): AirQualitySensorStatus {
  return {
    ...(purifier.airQuality !== undefined ? { pm25: purifier.airQuality } : {}),
    lastFetchedAt: now,
  }
}

/** Map a purifier snapshot's filter life onto the numeric-sensor slice (unit `%`). */
function filterLifeSlice(purifier: VeSyncPurifierSnapshot, now: number): NumericSensorStatus {
  return {
    value: purifier.filterLifePercent ?? 0,
    lastFetchedAt: now,
  }
}

/** Map a humidifier snapshot's measured humidity onto the humidity-sensor slice. */
function humiditySlice(humidifier: VeSyncHumidifierSnapshot, now: number): HumiditySensorStatus {
  return { humidity: humidifier.currentHumidity, lastFetchedAt: now }
}
