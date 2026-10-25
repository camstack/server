import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Firmware/software update entity. Installed on a `DeviceType.Update` device.
 * Surfaces current vs available version, whether an update is available, the
 * update state, and an install action. Read-mostly and POLL-driven: backends
 * such as the Homematic CCU do not broadcast firmware-descriptor changes, so
 * the client re-queries `getStatus` (which reads the live descriptor) rather
 * than relying on push delivery. `installUpdate` triggers the install
 * (best-effort — providers throw if the backend rejects it).
 */
export const UpdateStatusSchema = z.object({
  currentVersion: z.string().nullable(),
  availableVersion: z.string().nullable(),
  /**
   * DEVICE-CAPABILITY flag: the entity supports firmware updates at all — NOT
   * a per-state "an update is available right now" flag. The canonical
   * "update available" signal is `availableVersion !== currentVersion` (which
   * is what the UI uses); HA's `state === 'on'` mirrors that same condition.
   */
  updatable: z.boolean(),
  state: z.string().nullable(), // e.g. 'UP_TO_DATE' / 'DELIVER_FIRMWARE_IMAGE' (provider-verbatim)
  inProgress: z.boolean(),
})
export type UpdateStatus = z.infer<typeof UpdateStatusSchema>

export const updateCapability = {
  name: 'update',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Update],
  methods: {
    installUpdate: method(z.void(), z.void(), { kind: 'mutation', auth: 'admin' }),
  },
  status: { schema: UpdateStatusSchema, kind: 'poll' },
  runtimeState: UpdateStatusSchema,

  /**
   * Runtime-state durability: **session** — a restored `inProgress: true` describes an update that is no longer running; versions are re-probed at boot.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — text and state.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IUpdateProvider = InferProvider<typeof updateCapability>
