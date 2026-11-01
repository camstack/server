import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/**
 * timed-run - run a device for a chosen time, then stop it (D993).
 *
 * "Heat for 30 minutes", "run the fountain pump for 2 minutes": the device has
 * no timer of its own, so the hub keeps one. `runFor` turns the device on and
 * records a deadline; `cancel` (or the device being switched off by hand)
 * forgets it; at the deadline the hub issues the off once.
 *
 * The deadline is DURABLE: it is a row in the records store, so a hub restart
 * neither loses a pending off nor leaves the device running past its time. At
 * boot a deadline already past sends the off once (a failed off is logged, never
 * retried in a loop - D49); a future one is re-armed.
 *
 * What a device may be run for, and for how long at most, is per device type
 * ({@link TIMED_RUN_LIMITS}): the maximum is a safety bound, not a preference,
 * so a request above it is REFUSED with a typed reason, never clamped.
 */

export const TimedRunUnitSchema = z.enum(['s', 'min'])
export type TimedRunUnit = z.infer<typeof TimedRunUnitSchema>

/** What a timed run switches: the `switch` cap's `setState` or the fountain's `setPump`. */
export const TimedRunActuatorSchema = z.enum(['switch', 'pet-fountain'])
export type TimedRunActuator = z.infer<typeof TimedRunActuatorSchema>

export interface TimedRunLimit {
  readonly actuator: TimedRunActuator
  /** The longest a single run may last, in seconds. */
  readonly maxSeconds: number
  /** The unit an operator thinks of this device's run in. */
  readonly unit: TimedRunUnit
}

/** The longest run, per device type. Only these types are offered `timed-run`. */
export const TIMED_RUN_LIMITS: Readonly<Partial<Record<DeviceType, TimedRunLimit>>> = {
  [DeviceType.Heater]: { actuator: 'switch', maxSeconds: 180 * 60, unit: 'min' },
  [DeviceType.PetFountain]: { actuator: 'pet-fountain', maxSeconds: 300, unit: 's' },
}

export const TIMED_RUN_DEVICE_TYPES: readonly DeviceType[] = [
  DeviceType.Heater,
  DeviceType.PetFountain,
]

export function timedRunLimitOf(deviceType: DeviceType): TimedRunLimit | null {
  return TIMED_RUN_LIMITS[deviceType] ?? null
}

/** Seconds in a duration of `duration` `unit`. */
export function timedRunSeconds(duration: number, unit: TimedRunUnit): number {
  return unit === 'min' ? duration * 60 : duration
}

/** Why a request was not carried out. Typed, so a caller can say it in words. */
export const TimedRunRefusalSchema = z.enum([
  /** The device type has no timed run. */
  'unsupported-device',
  /** Longer than the type's maximum (`maxSeconds` names it). */
  'over-max',
  /** The device did not take the on command; nothing is armed. */
  'command-failed',
])
export type TimedRunRefusal = z.infer<typeof TimedRunRefusalSchema>

export const TimedRunResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), activeUntil: z.number() }),
  z.object({
    ok: z.literal(false),
    reason: TimedRunRefusalSchema,
    /** The type's maximum in seconds; `null` when the device has none. */
    maxSeconds: z.number().nullable(),
  }),
])
export type TimedRunResult = z.infer<typeof TimedRunResultSchema>

export const TimedRunStatusSchema = z.object({
  /** Epoch ms the pending off is due; `null` while nothing is armed. */
  activeUntil: z.number().nullable(),
  /** Who asked for the run (a user id or an addon id); `null` when nothing is armed or it did not say. */
  requestedBy: z.string().nullable(),
  lastFetchedAt: z.number(),
})
export type TimedRunStatus = z.infer<typeof TimedRunStatusSchema>

export const timedRunCapability = {
  name: 'timed-run',
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  deviceTypes: TIMED_RUN_DEVICE_TYPES,
  methods: {
    /**
     * Turn the device on and arm its off. A run already armed is replaced (the
     * new deadline wins). Refuses with a typed reason above the type's maximum.
     */
    runFor: method(
      z.object({
        deviceId: z.number().int(),
        duration: z.number().positive().finite(),
        unit: TimedRunUnitSchema,
      }),
      TimedRunResultSchema,
      // ACTUATION, like `switch.setState`: the caller's device grant governs it.
      { kind: 'mutation', auth: 'protected' },
    ),
    /** Forget the pending off. The device is left as it is. */
    cancel: method(z.object({ deviceId: z.number().int() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
  },
  status: { schema: TimedRunStatusSchema, kind: 'push' },
  runtimeState: TimedRunStatusSchema,
  /**
   * Runtime-state durability: **session** - the deadline itself is a row in the
   * records store; the slice is a mirror of it, rewritten at boot.
   */
  durability: 'session',
  history: 'none',
} as const satisfies CapabilityDefinition

export type ITimedRunProvider = InferProvider<typeof timedRunCapability>
