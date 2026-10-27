import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

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
  co2: z.number().min(0).optional().meta(readingMeta('concentration-volume')),
  /** Total volatile organic compounds in ppb. */
  voc: z.number().min(0).optional().meta(readingMeta('concentration-ppb')),
  /** Particulate matter ≤ 2.5 μm in µg/m³. */
  pm25: z.number().min(0).optional().meta(readingMeta('concentration-mass')),
  /** Particulate matter ≤ 10 μm in µg/m³. */
  pm10: z.number().min(0).optional().meta(readingMeta('concentration-mass')),
  /** Composite AQI value (typically 0..500). */
  aqi: z.number().optional().meta(readingMeta('index')),
  /** Ms epoch when the slice was last updated. */
  lastFetchedAt: z.number(),
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
      co2: { kind: 'gauge', unit: 'ppm', deadband: 5 },
      voc: { kind: 'gauge', unit: 'ppb', deadband: 5 },
      pm25: { kind: 'gauge', unit: 'µg/m³', deadband: 1 },
      pm10: { kind: 'gauge', unit: 'µg/m³', deadband: 1 },
      aqi: { kind: 'gauge', unit: 'count', deadband: 1 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IAirQualitySensorProvider = InferProvider<typeof airQualitySensorCapability>
