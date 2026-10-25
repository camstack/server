import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Smoke alarm sensor — boolean "is smoke currently detected" with
 * timestamp of the last transition. Drives Home Assistant
 * `binary_sensor` entries with `device_class: smoke`.
 *
 * Push-driven: a smoke event is critical, so the slice updates
 * immediately on the upstream signal. Auto-clearing back to false is
 * provider-controlled (some alarms latch until manually reset).
 */
export const SmokeStatusSchema = z.object({
  detected: z.boolean(),
  /** Ms epoch of the last transition. 0 if never observed. */
  lastChangedAt: z.number(),
})

export type SmokeStatus = z.infer<typeof SmokeStatusSchema>

export const smokeCapability = {
  name: 'smoke',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: SmokeStatusSchema,
    kind: 'push',
  },
  runtimeState: SmokeStatusSchema,

  /**
   * Runtime-state durability: **restored** — a safety sensor must not read "clear" merely because the hub restarted.
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

export type ISmokeProvider = InferProvider<typeof smokeCapability>
