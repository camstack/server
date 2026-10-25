import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Combustible-gas (LPG / methane / hydrogen) alarm sensor. Drives
 * Home Assistant `binary_sensor` entries with `device_class: gas`.
 * Push-driven.
 */
export const GasStatusSchema = z.object({
  detected: z.boolean(),
  /** Ms epoch of the last transition. 0 if never observed. */
  lastChangedAt: z.number(),
})

export type GasStatus = z.infer<typeof GasStatusSchema>

export const gasCapability = {
  name: 'gas',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: GasStatusSchema,
    kind: 'push',
  },
  runtimeState: GasStatusSchema,

  /**
   * Runtime-state durability: **restored** — as `smoke`.
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
      detected: { kind: 'boolean' },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type IGasProvider = InferProvider<typeof gasCapability>
