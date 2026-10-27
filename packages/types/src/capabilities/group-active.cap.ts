import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * Whether a helper actuator group counts as active (D944): at least one
 * included member is, or every included member is. What "active" means is the
 * type's: a cover is open, a lock is locked, a media player is playing, a
 * climate device is not off. A group of lights, switches and fans reports
 * `switch.on` instead; this cap is for the types whose own state is not a
 * yes/no. Unknown members are left out (`group-status` counts them) and an
 * empty included set takes the device offline, never `active: false`.
 */
export const GroupActiveSchema: z.ZodObject<{
  active: z.ZodBoolean
  lastChangedAt: z.ZodNumber
}> = z.object({
  active: z.boolean().meta({ label: 'Active' }),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})
export type GroupActive = z.infer<typeof GroupActiveSchema>

export const groupActiveCapability = {
  name: 'group-active',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [
    DeviceType.Cover,
    DeviceType.Valve,
    DeviceType.Lock,
    DeviceType.MediaPlayer,
    DeviceType.Climate,
    DeviceType.Thermostat,
  ],
  methods: {},
  status: {
    schema: GroupActiveSchema,
    kind: 'push',
  },
  runtimeState: GroupActiveSchema,
  /**
   * Runtime-state durability: **session** — recomputed from the members on the
   * next source event; a restored value would outlive the members it named.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  history: 'none',
} as const satisfies CapabilityDefinition

export type IGroupActiveProvider = InferProvider<typeof groupActiveCapability>
