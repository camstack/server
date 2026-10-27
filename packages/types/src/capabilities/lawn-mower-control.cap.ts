import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Robotic lawn-mower cap. Models HA `lawn_mower.*` entities — anything
 * with a mowing lifecycle plus a dock action.
 *
 * Activity follows HA's canonical lawn-mower lifecycle: `idle` /
 * `mowing` / `paused` / `docked` / `error`. `batteryLevel` (0..100) is
 * nullable — some mowers don't report a battery percentage.
 *
 * `startMowing` begins a mowing run, `pause` halts it in place, and
 * `dock` sends the mower back to its charging station.
 */

export const LawnMowerActivitySchema = z.enum(['idle', 'mowing', 'paused', 'docked', 'error'])
export type LawnMowerActivity = z.infer<typeof LawnMowerActivitySchema>

/** Severity of the current device/error code — info (status), warning, error. */
export const DeviceCodeSeveritySchema = z.enum(['info', 'warning', 'error'])
export type DeviceCodeSeverity = z.infer<typeof DeviceCodeSeveritySchema>

export const LawnMowerControlStatusSchema = z.object({
  /** Lifecycle activity of the mower. */
  activity: LawnMowerActivitySchema,
  /** 0..100 battery percentage. Null when the device has no battery
   *  reading. */
  batteryLevel: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** 0..100 mowing-completion percentage of the current task, or null when no
   *  task is active / progress is unavailable. */
  progress: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Current device/event code (dynamic — mostly status, sometimes an error),
   *  or null when unknown. */
  currentCode: z.number().nullable().meta(readingMeta('none')),
  /** Human label for {@link currentCode}, or null when undecodable. */
  currentCodeLabel: z.string().nullable(),
  /** Severity of {@link currentCode}. `error` (and often `warning`) warrants UI
   *  attention; `info` is normal status. */
  severity: DeviceCodeSeveritySchema,
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type LawnMowerControlStatus = z.infer<typeof LawnMowerControlStatusSchema>

export const lawnMowerControlCapability = {
  name: 'lawn-mower-control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.LawnMower],
  methods: {
    startMowing: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    pause: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    dock: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
  },
  status: {
    schema: LawnMowerControlStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI controls watch the
   * slice for live activity + battery changes.
   */
  runtimeState: LawnMowerControlStatusSchema,

  /**
   * Runtime-state durability: **session** — as `vacuum-control`.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series.
   */
  history: {
    fields: {
      batteryLevel: { kind: 'gauge', unit: '%', deadband: 2 },
    },
  },
} as const satisfies CapabilityDefinition

export type ILawnMowerControlProvider = InferProvider<typeof lawnMowerControlCapability>
