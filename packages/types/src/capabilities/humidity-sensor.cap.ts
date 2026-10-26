import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Single-metric humidity reading. Drives Home Assistant `sensor`
 * entries with `device_class: humidity`.
 *
 * Unit normalisation: percent. The canonical display unit (`%`) is a
 * descriptor constant in the UI (ROLE_DESCRIPTOR), not stored in
 * `sourceInfo`.
 */
export const HumiditySensorStatusSchema = z.object({
  /** Current relative humidity, 0..100. `null` when the sample was refused (D393). */
  percent: z
    .number()
    .min(0)
    .max(100)
    .nullable()
    .meta(readingMeta('humidity', { precision: 0, label: 'Humidity' })),
  /** Ms epoch when the slice was last updated. */
  lastFetchedAt: z.number(),
})

export type HumiditySensorStatus = z.infer<typeof HumiditySensorStatusSchema>

export const humiditySensorCapability = {
  name: 'humidity-sensor',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor, DeviceType.Thermostat],
  methods: {},
  status: {
    schema: HumiditySensorStatusSchema,
    kind: 'push',
  },
  runtimeState: HumiditySensorStatusSchema,

  /**
   * Runtime-state durability: **restored** — as `numeric-sensor` (67 of 75 writes were the clock alone).
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
      percent: { kind: 'gauge', unit: '%', deadband: 0.5 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IHumiditySensorProvider = InferProvider<typeof humiditySensorCapability>
