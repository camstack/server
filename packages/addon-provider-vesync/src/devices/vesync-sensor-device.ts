import {
  airQualitySensorCapability,
  type AirQualitySensorStatus,
  BaseDevice,
  type DeviceContext,
  type DeviceFeature,
  errMsg,
  type InferNativeProvider,
  numericSensorCapability,
  type NumericSensorStatus,
} from '@camstack/types'
import { vesyncSensorSchema, type VeSyncSensorKind } from '../config.js'
import type { VeSyncPurifierSnapshot } from '../vesync-client-contract.js'
import { vesyncAccounts } from '../vesync-account-resolver.js'

const AQ_CAP = airQualitySensorCapability.name
const NUMERIC_CAP = numericSensorCapability.name

const AQ_COLD_START: AirQualitySensorStatus = { lastFetchedAt: 0 }
const FILTER_COLD_START: NumericSensorStatus = { value: 0, unit: '%', lastFetchedAt: 0 }

/**
 * One VeSync purifier read-only metric (`air-quality` or `filter-life`) as a
 * CamStack {@link import('@camstack/types').DeviceType.Sensor} accessory child of
 * the purifier Fan device.
 *
 *   - `air-quality`  → the `air-quality-sensor` cap (PM2.5 in µg/m³).
 *   - `filter-life`  → the `numeric-sensor` cap carrying the remaining filter
 *     life as a percent (unit `%`).
 *
 * The slice is fed from the live purifier snapshot on each poll tick (and seeded
 * cold on activate). No methods — both caps are read-only push slices.
 */
export class VeSyncSensorDevice extends BaseDevice<typeof vesyncSensorSchema> {
  readonly features: readonly DeviceFeature[] = []

  private readonly kind: VeSyncSensorKind
  private readonly purifierNativeId: string
  private readonly accountId: string

  private snapshotUnsub: (() => void) | null = null

  constructor(ctx: DeviceContext) {
    const cfg = vesyncSensorSchema.parse(ctx.persistedConfig ?? {})
    super(ctx, vesyncSensorSchema, { type: ctx.deviceMeta.type })
    this.kind = cfg.kind
    this.purifierNativeId = cfg.purifierNativeId
    this.accountId = cfg.accountId
    this.online = vesyncAccounts.getPurifier(this.accountId, this.purifierNativeId)?.online ?? false
    void this.updateSourceInfo({
      id: `${this.accountId}:${this.purifierNativeId}:${this.kind}`,
      system: 'vesync',
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
          meta: { kind: this.kind, error: errMsg(err) },
        })
      }
    }
    this.snapshotUnsub = vesyncAccounts.onSnapshot(this.accountId, onSnapshot)
  }

  /** Recompute + write this sensor's cap slice from the live snapshot. */
  private recomputeSlice(): void {
    const purifier = vesyncAccounts.getPurifier(this.accountId, this.purifierNativeId)
    if (purifier === null) return
    if (this.online !== purifier.online) this.markOnline(purifier.online)
    const now = Date.now()
    if (this.kind === 'air-quality') {
      this.runtimeState.setCapState(AQ_CAP, airQualitySlice(purifier, now))
    } else {
      this.runtimeState.setCapState(NUMERIC_CAP, filterLifeSlice(purifier, now))
    }
  }

  private registerSensorCap(): void {
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

/** Map a purifier snapshot's air-quality PM2.5 onto the air-quality-sensor slice. */
function airQualitySlice(purifier: VeSyncPurifierSnapshot, now: number): AirQualitySensorStatus {
  return {
    ...(purifier.airQuality !== undefined ? { pm25: purifier.airQuality, unit: 'µg/m³' } : {}),
    lastFetchedAt: now,
  }
}

/** Map a purifier snapshot's filter life onto the numeric-sensor slice (unit `%`). */
function filterLifeSlice(purifier: VeSyncPurifierSnapshot, now: number): NumericSensorStatus {
  return {
    value: purifier.filterLifePercent ?? 0,
    unit: '%',
    lastFetchedAt: now,
  }
}
