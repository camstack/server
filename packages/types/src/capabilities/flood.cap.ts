import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Water leak / moisture sensor. Boolean "is liquid currently
 * detected" with the timestamp of the last transition. Drives Home
 * Assistant `binary_sensor` entries with `device_class: moisture`,
 * and any future native flood sensor.
 *
 * Push-driven from the upstream source.
 */
export const FloodStatusSchema = z.object({
  /** True when leak is currently detected. */
  flooded: z.boolean(),
  /** Ms epoch of the last flooded↔dry transition. 0 if never observed. */
  lastChangedAt: z.number(),
})

export type FloodStatus = z.infer<typeof FloodStatusSchema>

export const floodCapability = {
  name: 'flood',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: FloodStatusSchema,
    kind: 'push',
  },
  runtimeState: FloodStatusSchema,

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
      flooded: { kind: 'boolean' },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type IFloodProvider = InferProvider<typeof floodCapability>
