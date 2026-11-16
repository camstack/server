import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Timed siren: trigger the siren for a duration and know until when it sounds.
 *
 * The plain on/off `switch` of a siren stays as it is (HomeKit / Alexa see a
 * switch); this cap adds the part a switch cannot say — HOW LONG, and the
 * moment the siren is expected to fall silent (`activeUntil`, epoch ms), so a
 * UI can show the activation with a countdown.
 *
 * The allowed durations are never hardcoded: `getOptions` answers what the
 * CAMERA reports (a discrete list or `{min,max,step}`), the default, and the
 * unit truth — a camera that counts plays rather than seconds says so, with the
 * seconds-per-play factor used to convert, and whether that factor was read
 * from the camera or is an estimate.
 */

/** What the camera counts natively. */
export const SirenDurationUnit = {
  Seconds: 'seconds',
  Plays: 'plays',
} as const
export type SirenDurationUnitValue = (typeof SirenDurationUnit)[keyof typeof SirenDurationUnit]

/** Where the numbers of an options answer come from. */
export const SirenOptionsSource = {
  /** Read from the camera by this fetch. */
  Camera: 'camera',
  /** The camera did not answer or does not advertise it; a documented fallback. */
  Fallback: 'fallback',
} as const
export type SirenOptionsSourceValue = (typeof SirenOptionsSource)[keyof typeof SirenOptionsSource]

export const SirenDurationRangeSchema = z.object({
  min: z.number().positive(),
  max: z.number().positive(),
  step: z.number().positive(),
})
export type SirenDurationRange = z.infer<typeof SirenDurationRangeSchema>

export const SirenOptionsSchema = z.object({
  /** Discrete durations in seconds the operator may pick; `null` when the camera gives a range. */
  allowedSeconds: z.array(z.number().positive()).nullable(),
  /** Continuous range in seconds; `null` when the camera gives a discrete list. */
  rangeSeconds: SirenDurationRangeSchema.nullable(),
  /** The camera's default duration, seconds. */
  defaultSeconds: z.number().positive(),
  /** What the camera counts natively. */
  unit: z.enum([SirenDurationUnit.Seconds, SirenDurationUnit.Plays]),
  /** Seconds one play lasts, when `unit` is `plays`; `null` for a seconds camera. */
  secondsPerPlay: z.number().positive().nullable(),
  /** `camera` when the values were read from it, `fallback` when the camera could not say. */
  source: z.enum([SirenOptionsSource.Camera, SirenOptionsSource.Fallback]),
  /** Ms epoch of the read that produced this answer. */
  fetchedAt: z.number(),
})
export type SirenOptions = z.infer<typeof SirenOptionsSchema>

export const SirenStatusSchema = z.object({
  /** True while the siren is sounding by a timed trigger or switched on. */
  active: z.boolean(),
  /** Ms epoch the siren is expected to fall silent; `null` when not active or open-ended. */
  activeUntil: z.number().nullable(),
  /** Duration of the current / last activation, seconds; `null` when none yet. */
  durationSeconds: z.number().nullable(),
  /** Ms epoch of the last trigger (0 = never). */
  lastTriggeredAt: z.number(),
})
export type SirenStatus = z.infer<typeof SirenStatusSchema>

export const SirenRuntimeStateSchema = SirenStatusSchema.extend({
  /** Ms epoch of the last successful camera read of the options (0 = never). */
  lastFetchedAt: z.number(),
})
export type SirenRuntimeState = z.infer<typeof SirenRuntimeStateSchema>

export const sirenCapability = {
  name: 'siren',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Siren],
  methods: {
    /** The durations the camera allows, read from the camera. */
    getOptions: method(z.object({ deviceId: z.number().int().nonnegative() }), SirenOptionsSchema, {
      kind: 'query',
      auth: 'protected',
    }),
    /**
     * Sound the siren. Without `durationSeconds` the camera default applies.
     * Answers the state at the moment of the trigger (`activeUntil` included).
     */
    trigger: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        durationSeconds: z.number().positive().optional(),
      }),
      SirenStatusSchema,
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'siren.trigger',
            label: t('Sound the siren', 'Fai suonare la sirena'),
            phrase: t('Sound {device}', 'Fai suonare {device}'),
            icon: 'siren',
            args: {},
          },
        ],
      },
    ),
    /** Silence the siren now. */
    stop: method(z.object({ deviceId: z.number().int().nonnegative() }), SirenStatusSchema, {
      kind: 'mutation',
      auth: 'protected',
      actions: [
        {
          id: 'siren.stop',
          label: t('Silence the siren', 'Zittisci la sirena'),
          phrase: t('Silence {device}', 'Zittisci {device}'),
          icon: 'siren',
          effect: { field: 'active', value: false },
          args: {},
        },
      ],
    }),
  },
  events: {
    onSirenChanged: {
      data: z.object({
        deviceId: z.number(),
        active: z.boolean(),
        activeUntil: z.number().nullable(),
      }),
      notOperatorFacing: 'the `active` state trigger phrases both edges of this change',
    },
  },
  status: {
    schema: SirenStatusSchema,
    kind: 'command-driven',
  },
  runtimeState: SirenRuntimeStateSchema,

  /**
   * Runtime-state durability: **session** — a siren activation is a moment, not a fact to restore after a restart.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — an activation is already recorded by the switch / alarm events.
   */
  history: 'none',
  vocabulary: {
    noun: t('Siren', 'Sirena'),
    order: 1170,
    state: [
      {
        kind: 'boolean',
        field: 'active',
        label: t('Siren sounding', 'Sirena in funzione'),
        whenTrue: t('When {device} starts sounding', 'Quando {device} inizia a suonare'),
        whenFalse: t('When {device} falls silent', 'Quando {device} smette di suonare'),
        icon: 'siren',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type ISirenProvider = InferProvider<typeof sirenCapability>
