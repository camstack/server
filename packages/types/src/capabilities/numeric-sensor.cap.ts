import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Generic numeric sensor — last-resort fallback when no typed numeric
 * cap fits (HA `sensor` whose `device_class` we don't have a typed cap
 * for: water flow, distance, weight, frequency, signal strength, …).
 *
 * The `unit` and `precision` fields carry the live display metadata that
 * the upstream source provides with each state push (HA
 * `attributes.unit_of_measurement` / `attributes.suggested_display_precision`).
 * The UI reads them directly from the slice — they are the single source
 * of truth for generic numeric rendering and do NOT live on `sourceInfo`.
 *
 * Prefer the typed alternatives (`temperature-sensor`, `humidity-sensor`,
 * `ambient-light-sensor`, `pressure-sensor`, `power-meter`,
 * `air-quality-sensor`, `battery`) when the metric matches — export
 * adapters render those with the right service / category. Generic
 * numeric values land here.
 */
export const NumericSensorStatusSchema = z.object({
  value: z.number(),
  /** Display unit-of-measurement (e.g. 'dBm', 's', 'rpm', 'steps').
   *  Populated live from the upstream source on each state push.
   *  Absent for unitless sensors. */
  unit: z.string().optional(),
  /** Suggested decimal places for numeric display.
   *  Populated live from the upstream source when provided.
   *  Falls back to auto-formatting when absent. */
  precision: z.number().int().min(0).max(10).optional(),
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
   * History (D850): recorded series. The unit is per device, read from the sibling `unit` field.
   */
  history: {
    fields: {
      value: { kind: 'gauge', unitFrom: 'unit', minIntervalMs: 30000 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type INumericSensorProvider = InferProvider<typeof numericSensorCapability>
