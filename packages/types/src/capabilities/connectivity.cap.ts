import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Upstream-system connectivity sensor — distinct from `device-status`,
 * which is the kernel-managed online/offline flag for the device's
 * own transport. This cap surfaces an external entity's view of
 * whether the device is reachable (typical use: HA's
 * `binary_sensor` with `device_class: connectivity` for a remote
 * gateway or bridge). Push-driven.
 */
export const ConnectivityStatusSchema = z.object({
  /** True when the upstream system considers the entity connected. */
  connected: z.boolean(),
  /** Ms epoch of the last transition. 0 if never observed. */
  lastChangedAt: z.number(),
})

export type ConnectivityStatus = z.infer<typeof ConnectivityStatusSchema>

export const connectivityCapability = {
  name: 'connectivity',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Sensor],
  methods: {},
  status: {
    schema: ConnectivityStatusSchema,
    kind: 'push',
  },
  runtimeState: ConnectivityStatusSchema,

  /**
   * Runtime-state durability: **restored** — same shape and same argument as `device-status`, for links rather than devices.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): `connected` as a boolean series — change-only, no floor. It
   * is the upstream entity's own link (a HA connectivity sensor), not the
   * device's reachability, which stays `device-status.online`.
   */
  history: { fields: { connected: { kind: 'boolean' } } },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type IConnectivityProvider = InferProvider<typeof connectivityCapability>
