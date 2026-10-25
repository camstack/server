import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Multi-metric air-quality slice. Covers CO₂, total VOCs, particulate
 * matter at PM2.5 / PM10, and a derived AQI index — all optional so
 * a single-metric source populates only what it observes. Mirrors
 * the HA `sensor` device_class set (`co2`, `volatile_organic_compounds`,
 * `pm25`, `pm10`, `aqi`) collapsed into one cap because a typical
 * air-quality node reports several of these together; modelling them
 * as siblings keeps a single timestamp + one slice subscription.
 */
export const AirQualitySensorStatusSchema = z.object({
  /** Carbon dioxide concentration in ppm. */
  co2Ppm: z.number().min(0).optional(),
  /** Total volatile organic compounds in ppb. */
  vocPpb: z.number().min(0).optional(),
  /** Particulate matter ≤ 2.5 μm in µg/m³. */
  pm25: z.number().min(0).optional(),
  /** Particulate matter ≤ 10 μm in µg/m³. */
  pm10: z.number().min(0).optional(),
  /** Composite AQI value (typically 0..500). */
  aqi: z.number().optional(),
  /** Ms epoch when the slice was last updated. */
  lastFetchedAt: z.number(),
  /** Live display unit of the single metric this slice carries (e.g. HA
   *  `attributes.unit_of_measurement` → 'ppm' / 'ppb' / 'µg/m³'). Each
   *  upstream `sensor.*` entity surfaces ONE device_class, so one unit
   *  per slice is unambiguous. */
  unit: z.string().optional(),
  /** Suggested decimal places for numeric display.
   *  Populated live from the upstream source when provided (e.g. HA
   *  `attributes.suggested_display_precision`). Falls back to
   *  auto-formatting when absent. */
  precision: z.number().int().min(0).max(10).optional(),
})

export type AirQualitySensorStatus = z.infer<typeof AirQualitySensorStatusSchema>

export const airQualitySensorCapability = {
  name: 'air-quality-sensor',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: AirQualitySensorStatusSchema,
    kind: 'push',
  },
  runtimeState: AirQualitySensorStatusSchema,

  /**
   * Runtime-state durability: **restored** — as `numeric-sensor`.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): recorded series.
   */
  history: {
    fields: {
      co2Ppm: { kind: 'gauge', unit: 'ppm', deadband: 5 },
      vocPpb: { kind: 'gauge', unit: 'ppb', deadband: 5 },
      pm25: { kind: 'gauge', unit: 'ug/m3', deadband: 1 },
      pm10: { kind: 'gauge', unit: 'ug/m3', deadband: 1 },
      aqi: { kind: 'gauge', unit: 'count', deadband: 1 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IAirQualitySensorProvider = InferProvider<typeof airQualitySensorCapability>
