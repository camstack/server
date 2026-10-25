import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Vibration / shake / impact sensor. Drives Home Assistant
 * `binary_sensor` entries with `device_class: vibration`. Push-driven.
 */
export const VibrationStatusSchema = z.object({
  detected: z.boolean(),
  /** Ms epoch of the last transition. 0 if never observed. */
  lastChangedAt: z.number(),
})

export type VibrationStatus = z.infer<typeof VibrationStatusSchema>

export const vibrationCapability = {
  name: 'vibration',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: VibrationStatusSchema,
    kind: 'push',
  },
  runtimeState: VibrationStatusSchema,

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

export type IVibrationProvider = InferProvider<typeof vibrationCapability>
