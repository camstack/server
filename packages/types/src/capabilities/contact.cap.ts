import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Door / window / opening / garage / valve contact sensor. Boolean
 * "is the entry currently open" with the timestamp of the last
 * transition. Drives Home Assistant `binary_sensor` entries whose
 * `device_class` is `door`, `window`, `opening`, `garage`, or
 * `garage_door` — and any future native integration that needs
 * the same semantics.
 *
 * Push-driven: providers update the slice on transition events from
 * the upstream source (HA WebSocket `state_changed`, ZWave
 * `notification` …). Consumers read the slice; no polling.
 */
export const ContactStatusSchema = z.object({
  /** True when the entry is open; false when closed. */
  entryOpen: z.boolean(),
  /** Ms epoch of the last open↔closed transition. 0 if never observed. */
  lastChangedAt: z.number(),
})

export type ContactStatus = z.infer<typeof ContactStatusSchema>

export const contactCapability = {
  name: 'contact',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: ContactStatusSchema,
    kind: 'push',
  },
  runtimeState: ContactStatusSchema,

  /**
   * Runtime-state durability: **restored** — a door left open across a restart must still read open.
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
      entryOpen: { kind: 'boolean' },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type IContactProvider = InferProvider<typeof contactCapability>
