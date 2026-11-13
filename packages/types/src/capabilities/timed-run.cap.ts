import { z } from 'zod'
import { DeviceRole, DeviceType } from '../device/device-type.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * timed-run - run a device for a chosen time, then stop it (D993).
 *
 * "Heat for 30 minutes", "run the fountain pump for 2 minutes": the device has
 * no timer of its own, so the hub keeps one. `runFor` turns the device on and
 * records a deadline; `cancel` switches the device off and forgets the deadline,
 * and the device being switched off by hand just forgets it; at the deadline
 * the hub issues the off once.
 *
 * The deadline is DURABLE: it is a row in the records store, so a hub restart
 * neither loses a pending off nor leaves the device running past its time. At
 * boot a deadline already past sends the off once (a failed off is logged, never
 * retried in a loop - D49); a future one is re-armed.
 *
 * What a device may be run for, and for how long at most, is per device type
 * and role ({@link timedRunLimitOf}): the maximum is a safety bound, not a preference,
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
  /** The one-tap run, in `unit`, until the operator sets this device's own. */
  readonly quickRunDefault: number
}

/** A plug-in heater (switch + `switch-heater`): up to 3 h, in minutes. */
export const TIMED_RUN_HEATER_LIMIT: TimedRunLimit = {
  actuator: 'switch',
  maxSeconds: 180 * 60,
  unit: 'min',
  quickRunDefault: 30,
}

/** A pet fountain's pump: up to 5 min, in seconds. */
export const TIMED_RUN_PET_FOUNTAIN_LIMIT: TimedRunLimit = {
  actuator: 'pet-fountain',
  maxSeconds: 300,
  unit: 's',
  quickRunDefault: 60,
}

/**
 * The device types `timed-run` may be offered on. A `switch` is narrowed by
 * role ({@link TIMED_RUN_DEVICE_ROLES}): only a plug-in heater runs on a timer.
 */
export const TIMED_RUN_DEVICE_TYPES: readonly DeviceType[] = [
  DeviceType.Switch,
  DeviceType.PetFountain,
]

/** The roles that make a device of these types timed-run-able (D1033). */
export const TIMED_RUN_DEVICE_ROLES: Readonly<Partial<Record<DeviceType, readonly DeviceRole[]>>> =
  {
    [DeviceType.Switch]: [DeviceRole.SwitchHeater],
  }

/**
 * The longest run of a device, by its type AND role (D1033): a `switch` is a
 * heater only with role `switch-heater`, a pet fountain always is what it is.
 * `null` - the device is not offered `timed-run`.
 */
export function timedRunLimitOf(
  deviceType: string,
  role: string | null | undefined,
): TimedRunLimit | null {
  if (deviceType === DeviceType.PetFountain) return TIMED_RUN_PET_FOUNTAIN_LIMIT
  if (deviceType === DeviceType.Switch && role === DeviceRole.SwitchHeater)
    return TIMED_RUN_HEATER_LIMIT
  return null
}

const MS_PER_SECOND = 1000
const MS_PER_MINUTE = 60_000

/**
 * Whole units left on an armed run. Minutes and seconds both ceil, and a run
 * that has not expired yet never reads as zero.
 */
export function timedRunRemaining(activeUntil: number, now: number, unit: TimedRunUnit): number {
  const left = activeUntil - now
  if (left <= 0) return 0
  const per = unit === 'min' ? MS_PER_MINUTE : MS_PER_SECOND
  return Math.max(1, Math.ceil(left / per))
}

/** Seconds in a duration of `duration` `unit`. */
export function timedRunSeconds(duration: number, unit: TimedRunUnit): number {
  return unit === 'min' ? duration * 60 : duration
}

/** The longest run of a limit, in the unit the operator thinks of it in. */
export function timedRunMaxIn(limit: TimedRunLimit): number {
  return limit.unit === 'min' ? Math.floor(limit.maxSeconds / 60) : limit.maxSeconds
}

/** One duration, as the one-tap run asks for it. */
export const TimedRunQuickRunSchema = z.object({
  duration: z.number().positive().finite(),
  unit: TimedRunUnitSchema,
})
export type TimedRunQuickRun = z.infer<typeof TimedRunQuickRunSchema>

/**
 * The one-tap run of a device: the duration the operator stored for it, else the
 * type's default, never above the type's maximum. A stored value that is not a
 * usable number is the default (a hand-edited row never breaks the button).
 */
export function timedRunQuickRun(limit: TimedRunLimit, stored: number | null): TimedRunQuickRun {
  const max = timedRunMaxIn(limit)
  const usable = stored !== null && Number.isFinite(stored) && stored > 0 ? stored : null
  return {
    duration: Math.min(usable ?? limit.quickRunDefault, max),
    unit: limit.unit,
  }
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
  /**
   * The one-tap run of THIS device: what a "Run" button on any surface starts. `null` when
   * the device is gone or its type has no timed run; a status from before this field
   * existed has none, and a surface falls back to the type's default.
   */
  quickRun: TimedRunQuickRunSchema.nullable(),
  lastFetchedAt: z.number(),
})
export type TimedRunStatus = z.infer<typeof TimedRunStatusSchema>

/** What the settings form needs: the unit, the bounds and the type's default. */
export const TimedRunOptionsSchema = z.object({
  unit: TimedRunUnitSchema,
  /** The longest run, in `unit`. */
  maxDuration: z.number(),
  defaultDuration: z.number(),
})
export type TimedRunOptions = z.infer<typeof TimedRunOptionsSchema>

/** The one-tap run duration, in the type's unit; `null` returns to the type's default. */
export const TimedRunSettingsPatchSchema = z.object({
  quickRunDuration: z.number().positive().finite().nullable().optional(),
})
export type TimedRunSettingsPatch = z.infer<typeof TimedRunSettingsPatchSchema>

export const timedRunCapability = {
  name: 'timed-run',
  scope: 'device',
  mode: 'singleton',
  kind: 'wrapper',
  defaultActive: true,
  deviceTypes: TIMED_RUN_DEVICE_TYPES,
  deviceRoles: TIMED_RUN_DEVICE_ROLES,
  deviceConfig: {
    ui: { kind: 'derived-form', builderId: 'timed-run', tab: 'general' },
  },
  methods: {
    getOptions: method(z.object({ deviceId: z.number().int() }), TimedRunOptionsSchema),
    /**
     * The one-tap run of this device. A duration above the type's maximum is
     * REFUSED (thrown), like `runFor`: the maximum is a safety bound.
     */
    setSettings: method(
      z.object({
        deviceId: z.number().int(),
        settings: TimedRunSettingsPatchSchema,
      }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
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
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'timedRun.runForMinutes',
            label: t('Run for minutes', 'Accendi per alcuni minuti'),
            phrase: t(
              'Run {device} for {duration} minutes, then switch it off',
              'Tieni acceso {device} per {duration} minuti, poi spegnilo',
            ),
            icon: 'timer',
            args: { unit: 'min' },
            openArgs: [
              {
                key: 'duration',
                label: t('Minutes', 'Minuti'),
                offer: { kind: 'number', min: 1, step: 1, unit: 'min' },
              },
            ],
          },
          {
            id: 'timedRun.runForSeconds',
            label: t('Run for seconds', 'Accendi per alcuni secondi'),
            phrase: t(
              'Run {device} for {duration} seconds, then switch it off',
              'Tieni acceso {device} per {duration} secondi, poi spegnilo',
            ),
            icon: 'timer',
            args: { unit: 's' },
            openArgs: [
              {
                key: 'duration',
                label: t('Seconds', 'Secondi'),
                offer: { kind: 'number', min: 1, step: 1, unit: 's' },
              },
            ],
          },
        ],
      },
    ),
    /** Stop the run: switch the device off (once) and forget the pending off. Nothing armed: nothing is sent. */
    cancel: method(z.object({ deviceId: z.number().int() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'timedRun.cancel',
          label: t('Cancel the timer', 'Annulla il timer'),
          phrase: t(
            'Cancel the pending switch-off of {device}',
            'Annulla lo spegnimento programmato di {device}',
          ),
          icon: 'timer-off',
        },
      ],
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
  vocabulary: { noun: t('Timed run', 'Esecuzione a tempo'), order: 2150 },
} as const satisfies CapabilityDefinition

export type ITimedRunProvider = InferProvider<typeof timedRunCapability>
