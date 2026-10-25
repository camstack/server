import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Weather provider cap. Models HA `weather.*` entities — a read-only
 * snapshot of the CURRENT conditions a weather integration reports.
 *
 * Read-only: there are no setters. The slice is populated from upstream
 * pushes (the HA weather entity's state + attributes) and rendered by
 * the UI as a sky scene + readouts.
 *
 * `condition` is the verbatim HA state string (`sunny` / `cloudy` /
 * `rainy` / `snowy` / `partlycloudy` / `pouring` / `lightning` /
 * `lightning-rainy` / `fog` / `windy` / `windy-variant` / `hail` /
 * `clear-night` / `exceptional` / …). The UI maps it to a glyph + tint;
 * unknown strings fall back to a neutral cloud.
 *
 * Every numeric reading is nullable — a given weather integration only
 * populates the metrics it actually provides.
 *
 * Forecast deferred — current conditions only for v1.
 */
export const WeatherStatusSchema = z.object({
  /** Verbatim HA condition state (`sunny`, `cloudy`, `rainy`, …). Null
   *  when no condition has been reported yet. */
  condition: z.string().nullable(),
  /** Current temperature in the reported unit. Null when not provided. */
  temperature: z.number().nullable(),
  /** Temperature unit string (e.g. `°C` / `°F`). Null when not provided. */
  temperatureUnit: z.string().nullable(),
  /** Relative humidity (0..100). Null when not provided. */
  humidity: z.number().min(0).max(100).nullable(),
  /** Barometric pressure in the reported unit. Null when not provided. */
  pressure: z.number().nullable(),
  /** Pressure unit string (e.g. `hPa` / `inHg`). Null when not provided. */
  pressureUnit: z.string().nullable(),
  /** Wind speed in the reported unit. Null when not provided. */
  windSpeed: z.number().nullable(),
  /** Wind-speed unit string (e.g. `km/h` / `mph`). Null when not provided. */
  windSpeedUnit: z.string().nullable(),
  /** Wind bearing in degrees (0..360, meteorological). Null when not provided. */
  windBearing: z.number().nullable(),
  /** Ms epoch when the slice was last updated. */
  lastFetchedAt: z.number(),
})

export type WeatherStatus = z.infer<typeof WeatherStatusSchema>

export const weatherCapability = {
  name: 'weather',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Weather],
  // Read-only — no service methods. Codegen still auto-injects `getStatus`
  // because `status` is set.
  methods: {},
  status: {
    schema: WeatherStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. The UI reads the
   * current conditions directly from the slice on each weather push.
   */
  runtimeState: WeatherStatusSchema,

  /**
   * Runtime-state durability: **session** — a forecast is stale the moment the hub is down; the provider re-fetches on connect.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series. Units follow the sibling `*Unit` fields.
   */
  history: {
    fields: {
      temperature: { kind: 'gauge', unitFrom: 'temperatureUnit', deadband: 0.2 },
      humidity: { kind: 'gauge', unit: '%', deadband: 1 },
      pressure: { kind: 'gauge', unitFrom: 'pressureUnit', deadband: 0.5 },
      windSpeed: { kind: 'gauge', unitFrom: 'windSpeedUnit', deadband: 0.5 },
    },
  },
} as const satisfies CapabilityDefinition

export type IWeatherProvider = InferProvider<typeof weatherCapability>
