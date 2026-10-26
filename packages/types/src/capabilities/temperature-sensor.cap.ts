import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Single-metric temperature reading. Drives Home Assistant `sensor`
 * entries with `device_class: temperature` and any future native
 * thermometer.
 *
 * The number is Celsius (D944). Providers convert on ingest. A failed
 * conversion is `null`, never a guess. Display unit is a read-time preference.
 *
 * Status `lastFetchedAt` lets staleness-aware consumers detect a
 * frozen feed (provider hung) distinct from a "temperature hasn't
 * changed" steady state.
 */
export const TemperatureSensorStatusSchema = z.object({
  /** Current temperature in Celsius. `null` when the sample was refused (D393). */
  celsius: z
    .number()
    .nullable()
    .meta(readingMeta('temperature', { precision: 1, label: 'Temperature' })),
  /** Ms epoch when the slice was last updated (push or poll). */
  lastFetchedAt: z.number(),
})

export type TemperatureSensorStatus = z.infer<typeof TemperatureSensorStatusSchema>

export const temperatureSensorCapability = {
  name: 'temperature-sensor',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor, DeviceType.Thermostat],
  methods: {},
  status: {
    schema: TemperatureSensorStatusSchema,
    kind: 'push',
  },
  runtimeState: TemperatureSensorStatusSchema,

  /**
   * Runtime-state durability: **restored** — as `numeric-sensor` (69 of 125 writes were the clock alone).
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
      celsius: { kind: 'gauge', unit: '°C', deadband: 0.1 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type ITemperatureSensorProvider = InferProvider<typeof temperatureSensorCapability>
