import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Tamper / case-open detection sensor. Drives Home Assistant
 * `binary_sensor` entries with `device_class: tamper`. Push-driven.
 */
export const TamperStatusSchema = z.object({
  /** True when the device's tamper switch / case-open contact is
   *  currently triggered. */
  tampered: z.boolean(),
  /** Ms epoch of the last transition. 0 if never observed. */
  lastChangedAt: z.number(),
})

export type TamperStatus = z.infer<typeof TamperStatusSchema>

export const tamperCapability = {
  name: 'tamper',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: TamperStatusSchema,
    kind: 'push',
  },
  runtimeState: TamperStatusSchema,

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
      tampered: { kind: 'boolean' },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type ITamperProvider = InferProvider<typeof tamperCapability>
