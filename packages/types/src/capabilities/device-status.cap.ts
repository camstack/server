import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'

/**
 * Generic device-level status snapshot. Auto-registered by `BaseDevice`
 * for every device, regardless of provider — the kernel needs a uniform
 * cap-keyed slice for the basic device flags every consumer expects to
 * read across processes (the `online` flag in particular). Driver-specific
 * caps (`battery`, `doorbell`, …) carry their domain-specific state on
 * their own slices.
 *
 * Pattern is identical to `battery`: schema-bearing `runtimeState`,
 * empty `methods`, single change event. Reads land at
 * `runtimeState.getCapState('device-status')`; writes at
 * `runtimeState.setCapState('device-status', …)`. Cross-process
 * consumers reach the same data via the `device-state` cap router
 * (`getCapSlice({deviceId, capName: 'device-status'})`).
 */
export const DeviceStatusSchema = z.object({
  /**
   * Device-level liveness. Drivers flip via `markOnline(boolean)` on
   * `BaseDevice`. Provider semantics vary — RTSP aggregates broker
   * stream-health, Reolink reads firmware push events, ONVIF tracks
   * ping responses. This cap intentionally does NOT prescribe which
   * signal drives the flag.
   */
  online: z.boolean(),
  /** Ms epoch of the last `online` transition. Lets consumers tell
   *  apart "just came online" from "still online". */
  lastChangedAt: z.number(),
})

export type DeviceStatus = z.infer<typeof DeviceStatusSchema>

export const deviceStatusCapability = {
  name: 'device-status',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  methods: {},
  events: {
    /** Emitted when `online` transitions. Mirrors the semantics of
     *  `battery.onStatusChanged`. */
    onStatusChanged: {
      data: z.object({
        deviceId: z.number(),
        status: DeviceStatusSchema,
      }),
    },
  },
  status: {
    schema: DeviceStatusSchema,
    kind: 'push',
  },
  runtimeState: DeviceStatusSchema,

  /**
   * Runtime-state durability: **restored** — the previous observation is what makes the first reading after a restart a COMPARISON instead of a phantom transition (D130). 32 real flips across 16 devices in 25 min — the busiest slice in the cold half.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850): recorded series. The ONE availability series.
   */
  history: {
    fields: {
      online: { kind: 'boolean' },
    },
  },
  /** Clock fields: written, but excluded from the compare that decides
   *  whether persisting is worth a SQLite commit. */
  volatileStateFields: ['lastChangedAt'],
} as const satisfies CapabilityDefinition

export type IDeviceStatusProvider = InferProvider<typeof deviceStatusCapability>
