import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Generic numeric sensor — last-resort fallback when no typed numeric
 * cap fits (HA `sensor` whose `device_class` we don't have a typed cap
 * for: water flow, distance, weight, frequency, signal strength, …).
 *
 * The quantity is not on this slice. It is chosen when the device is
 * adopted and stored once on `SourceInfo.quantity` (D944). `value` is in
 * that quantity's base unit. `null` is a refused sample (D393).
 *
 * Prefer the typed alternatives (`temperature-sensor`, `humidity-sensor`,
 * `ambient-light-sensor`, `pressure-sensor`, `power-meter`,
 * `air-quality-sensor`, `battery`) when the metric matches — export
 * adapters render those with the right service / category. Generic
 * numeric values land here.
 */
export const NumericSensorStatusSchema = z.object({
  /** Reading in the device quantity's base unit. `null` when refused (D393). */
  value: z.number().nullable().meta(readingMeta('device')),
  /** Ms epoch when the slice was last updated. */
  lastFetchedAt: z.number(),
})

export type NumericSensorStatus = z.infer<typeof NumericSensorStatusSchema>

export const numericSensorCapability = {
  name: 'numeric-sensor',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: NumericSensorStatusSchema,
    kind: 'push',
  },
  runtimeState: NumericSensorStatusSchema,

  /**
   * Runtime-state durability: **restored** — polled value, low churn once the clock is excluded (251 of 669 writes were the clock alone); restoring it removes the cold window before the first poll.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): recorded series. The unit is the device quantity's base,
   * resolved when the series is read — the cap has no single unit.
   */
  history: {
    fields: {
      value: { kind: 'gauge', minIntervalMs: 30000 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type INumericSensorProvider = InferProvider<typeof numericSensorCapability>
