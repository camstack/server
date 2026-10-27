import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'

/**
 * Robot-vacuum cap. Models HA `vacuum.*` entities — anything with a
 * cleaning lifecycle plus a return-to-base / locate surface and an
 * optional fan-speed selector.
 *
 * State follows HA's canonical vacuum lifecycle: `idle` / `cleaning` /
 * `paused` / `returning` / `docked` / `error`. `batteryLevel`
 * (0..100) is nullable — some vacuums don't report a battery
 * percentage. `fanSpeed` is the current speed token (provider-verbatim,
 * e.g. `'standard'` / `'turbo'`) and `availableFanSpeeds` lists the
 * tokens the hardware accepts so the UI renders only supported choices.
 *
 * The `setFanSpeed` method takes the bare `speed` token — the provider
 * validates it against the vacuum's own list. `locate` triggers the
 * find-me chirp; `returnToBase` sends it home.
 *
 * Tanks (clean water, dirty water, detergent, dust bin) are NOT here: they
 * are `supply` / `waste` items of the device's `consumables` cap, like every
 * other device's consumables (D915).
 */

export const VacuumStateSchema = z.enum([
  'idle',
  'cleaning',
  'paused',
  'returning',
  'docked',
  'drying',
  'error',
])
export type VacuumState = z.infer<typeof VacuumStateSchema>

export const VacuumControlStatusSchema = z.object({
  /** Lifecycle state of the vacuum. */
  state: VacuumStateSchema,
  /** 0..100 battery percentage. Null when the device has no battery
   *  reading. */
  batteryLevel: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Current fan-speed token (provider-verbatim). Null when unknown or
   *  the vacuum has no speed control. */
  fanSpeed: z.string().nullable(),
  /** Speed tokens the hardware accepts — drives the UI selector. */
  availableFanSpeeds: z.array(z.string()),
  /** 0..100 cleaning-completion percentage of the current task, or null. */
  progress: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Current error code (0 / null = no error). */
  errorCode: z.number().nullable().meta(readingMeta('none')),
  /** Human label for {@link errorCode}, or null when none / undecodable. */
  errorLabel: z.string().nullable(),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type VacuumControlStatus = z.infer<typeof VacuumControlStatusSchema>

export const vacuumControlCapability = {
  name: 'vacuum-control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Vacuum],
  methods: {
    start: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    pause: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    stop: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    returnToBase: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    locate: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    setFanSpeed: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        speed: z.string().min(1),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  status: {
    schema: VacuumControlStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI controls watch the
   * slice for live state + battery + fan-speed changes.
   */
  runtimeState: VacuumControlStatusSchema,

  /**
   * Runtime-state durability: **session** — as `media-player` — a restored `state: cleaning` is a robot that is not cleaning.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series. The tanks moved to `consumables` (D915), whose
   * items are keyed by runtime ids and record no history.
   */
  history: {
    fields: {
      batteryLevel: { kind: 'gauge', unit: '%', deadband: 2 },
    },
  },
} as const satisfies CapabilityDefinition

export type IVacuumControlProvider = InferProvider<typeof vacuumControlCapability>
