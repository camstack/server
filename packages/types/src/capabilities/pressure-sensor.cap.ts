import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Atmospheric pressure reading in hectopascals. Drives Home Assistant
 * `sensor` entries with `device_class: pressure`.
 *
 * Unit normalisation: hPa. The canonical display unit (`hPa`) is a
 * descriptor constant in the UI (ROLE_DESCRIPTOR), not stored in
 * `sourceInfo`.
 */
export const PressureSensorStatusSchema = z.object({
  /** Current pressure in hPa. `null` when the sample was refused (D393). */
  pressure: z
    .number()
    .nullable()
    .meta(readingMeta('pressure', { precision: 0 })),
  /** Ms epoch when the slice was last updated. */
  lastFetchedAt: z.number(),
})

export type PressureSensorStatus = z.infer<typeof PressureSensorStatusSchema>

export const pressureSensorCapability = {
  name: 'pressure-sensor',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: PressureSensorStatusSchema,
    kind: 'push',
  },
  runtimeState: PressureSensorStatusSchema,

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
      pressure: { kind: 'gauge', unit: 'hPa', deadband: 0.1 },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IPressureSensorProvider = InferProvider<typeof pressureSensorCapability>
