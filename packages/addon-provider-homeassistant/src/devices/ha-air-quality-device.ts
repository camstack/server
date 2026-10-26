import {
  airQualitySensorCapability,
  type DeviceContext,
  type InferNativeProvider,
  type AirQualitySensorStatus,
  type DeviceRole,
  type ReadingQuantity,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import { takeReading } from '../ha-reading.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: AirQualitySensorStatus = { lastFetchedAt: 0 }

/**
 * HA-backed air-quality sensor child. Multi-field cap. As with
 * HaPowerMeterDevice, the HA `sensor.*` model exposes one metric per
 * entity; this class maps the entity's `device_class` to one slot
 * on the multi-field slice.
 *
 * device_class → slice field:
 *   - `co2`                          → co2Ppm
 *   - `volatile_organic_compounds`   → vocPpb
 *   - `pm25` (HA: `pm2_5`)           → pm25
 *   - `pm10`                         → pm10
 *   - `aqi`                          → aqi
 *   - anything else                  → ignored
 */
export class HaAirQualityDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    const persisted = (ctx.persistedConfig ?? {}) as { role?: DeviceRole }
    super(ctx, persisted.role !== undefined ? { role: persisted.role } : {})
    this.registerCap()
    this.runtimeState.setCapState('air-quality-sensor', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const value = Number(state.state)
    if (!Number.isFinite(value)) return
    const lastFetchedAt = Date.parse(state.last_updated) || Date.now()
    const deviceClassRaw = state.attributes['device_class']
    const deviceClass = typeof deviceClassRaw === 'string' ? deviceClassRaw : null
    const quantity = airQuantity(deviceClass)
    if (quantity === undefined) return
    const unitRaw = state.attributes['unit_of_measurement']
    const stored = takeReading(
      this.deviceLogger,
      this.id,
      value,
      typeof unitRaw === 'string' ? unitRaw : undefined,
      quantity,
    )
    if (stored === null) return
    const prev =
      this.runtimeState.getCapState<AirQualitySensorStatus>('air-quality-sensor') ?? COLD_START
    const update = applyDeviceClass(prev, deviceClass, stored, lastFetchedAt)
    if (update !== null) this.runtimeState.setCapState('air-quality-sensor', update)
  }

  private registerCap(): void {
    const provider: InferNativeProvider<typeof airQualitySensorCapability> = {
      getStatus: async () => {
        return (
          this.runtimeState.getCapState<AirQualitySensorStatus>('air-quality-sensor') ?? COLD_START
        )
      },
    }
    this.ctx.registerNativeCap(airQualitySensorCapability, provider)
  }
}

function airQuantity(deviceClass: string | null): ReadingQuantity | undefined {
  switch (deviceClass) {
    case 'co2':
      return 'concentration-volume'
    case 'volatile_organic_compounds':
      return 'concentration-ppb'
    case 'pm25':
    case 'pm2_5':
    case 'pm10':
      return 'concentration-mass'
    case 'aqi':
      return 'index'
    default:
      return undefined
  }
}

function applyDeviceClass(
  prev: AirQualitySensorStatus,
  deviceClass: string | null,
  value: number,
  lastFetchedAt: number,
): AirQualitySensorStatus | null {
  switch (deviceClass) {
    case 'co2':
      return { ...prev, co2Ppm: value, lastFetchedAt }
    case 'volatile_organic_compounds':
      return { ...prev, vocPpb: value, lastFetchedAt }
    case 'pm25':
    case 'pm2_5':
      return { ...prev, pm25: value, lastFetchedAt }
    case 'pm10':
      return { ...prev, pm10: value, lastFetchedAt }
    case 'aqi':
      return { ...prev, aqi: value, lastFetchedAt }
    default:
      return null
  }
}
