import {
  weatherCapability,
  type DeviceContext,
  type InferNativeProvider,
  type ReadingQuantity,
  type WeatherStatus,
} from '@camstack/types'
import { HaBaseChildDevice } from '../ha-base-child-device.js'
import { takeReading } from '../ha-reading.js'
import type { HaEntityState } from '../ha-types.js'

const COLD_START: WeatherStatus = {
  condition: null,
  temperature: null,
  humidity: null,
  pressure: null,
  windSpeed: null,
  windBearing: null,
  lastFetchedAt: 0,
}

/**
 * HA-backed weather device — `weather.*`. Read-only: no service
 * methods, the provider only exposes `getStatus`.
 *
 * The HA `weather.*` state value IS the current condition string
 * (`sunny` / `cloudy` / `rainy` / `partlycloudy` / …) which we store
 * verbatim. The numeric current-condition readings live in the entity
 * attributes:
 *   - `temperature` / `temperature_unit`
 *   - `humidity`
 *   - `pressure`
 *   - `wind_speed`
 *   - `wind_bearing`
 *
 * Forecast deferred — current conditions only for v1.
 */
export class HaWeatherDevice extends HaBaseChildDevice {
  constructor(ctx: DeviceContext) {
    super(ctx)
    this.registerWeatherCap()
    this.runtimeState.setCapState('weather', COLD_START)
  }

  protected override handleStatePush(state: HaEntityState): void {
    if (state.state === 'unavailable' || state.state === 'unknown') return
    const lastFetchedAt = Date.parse(state.last_updated) || Date.now()
    const attrs = state.attributes
    const slice: WeatherStatus = {
      condition: state.state,
      temperature: this.readBase(attrs, 'temperature', 'temperature_unit', 'temperature'),
      // Clamp to the schema's [0,100] contract: an external provider may
      // report a slightly out-of-range value (e.g. 100.5) which would make
      // setCapState throw and silently drop the WHOLE push (temp/condition/…).
      humidity: clampOrNull(readNumberAttr(attrs, 'humidity'), 0, 100),
      pressure: this.readBase(attrs, 'pressure', 'pressure_unit', 'pressure'),
      windSpeed: this.readBase(attrs, 'wind_speed', 'wind_speed_unit', 'speed'),
      windBearing: readNumberAttr(attrs, 'wind_bearing'),
      lastFetchedAt,
    }
    this.runtimeState.setCapState('weather', slice)
  }

  private registerWeatherCap(): void {
    const provider: InferNativeProvider<typeof weatherCapability> = {
      getStatus: async () => {
        return this.runtimeState.getCapState<WeatherStatus>('weather') ?? COLD_START
      },
    }
    this.ctx.registerNativeCap(weatherCapability, provider)
  }

  /** One weather attribute, converted into the quantity's base unit. */
  private readBase(
    attrs: Record<string, unknown>,
    valueKey: string,
    unitKey: string,
    quantity: ReadingQuantity,
  ): number | null {
    const raw = readNumberAttr(attrs, valueKey)
    if (raw === null) return null
    const unit = readStringAttr(attrs, unitKey)
    return takeReading(this.deviceLogger, this.id, raw, unit ?? undefined, quantity)
  }
}

function readNumberAttr(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key]
  return typeof v === 'number' ? v : null
}

function readStringAttr(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key]
  return typeof v === 'string' ? v : null
}

/** Clamp a nullable number into [min,max]; passes null through unchanged. */
function clampOrNull(v: number | null, min: number, max: number): number | null {
  return v === null ? null : Math.min(max, Math.max(min, v))
}
