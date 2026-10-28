import { z } from 'zod'
import { readingMeta } from '../units/quantity.js'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * PetKit pet-feeder cap. Models the control + telemetry surface of a
 * cloud-connected smart feeder (Fresh Element / Mini / D3 / D4 / D4S
 * Gemini / D4H / D4SH) as a single coherent slice — bowl food level,
 * battery, desiccant life, feeding state + the four persisted settings
 * (child-lock / indicator-light / feed-sound / volume).
 *
 * Sources: native PetKit (`nodepetkit` `FeederDevice`). Reusable by any
 * feeder integration that speaks the same food/desiccant/hopper surface.
 *
 * `kind: 'poll'` — PetKit exposes only a cloud REST API (no push
 * channel), so the provider refreshes the slice on a poll interval and
 * eagerly after every command.
 *
 * Dual-hopper feeders (D4S/D4SH) split the bowl into two independent
 * hoppers. `isDualHopper` gates the two-hopper UI; `food1`/`food2` carry
 * the per-hopper levels (both `null` on single-hopper models, where
 * `foodLevel` is the single reading). The manual-feed portion honours the
 * PetKit hardware range 4–200 g in 1 g steps.
 *
 * Device status is exposed both raw and decoded, mirroring PetKit's HA
 * integration (RobertD502/py-petkit-api). `status` is the connectivity /
 * power enum (`normal` / `offline` / `on_batteries`); `error` is the
 * decoded human-readable fault message (null / `no_error` = healthy);
 * `errorCode` keeps the raw device integer (0 / null = no error) so a
 * provider that only has the numeric code stays lossless. A provider maps
 * the library's fields onto these; any it cannot determine stays `null`.
 */

/** PetKit manual-feed portion bounds (grams). Mirrors the HA `manual_feed`
 *  number entity (min 4, max 200, step 1, device_class weight). */
export const PET_FEEDER_MANUAL_FEED_MIN = 4
export const PET_FEEDER_MANUAL_FEED_MAX = 200

/**
 * Feeder connectivity / power status — mirrors the HA petkit device-status
 * enum: `normal` (online, mains), `offline` (not reaching PetKit cloud),
 * `on_batteries` (running on battery backup). `null` until first reported.
 */
export const PetFeederDeviceStatusSchema = z.enum(['normal', 'offline', 'on_batteries'])

export type PetFeederDeviceStatus = z.infer<typeof PetFeederDeviceStatusSchema>

const gramsPortion = z
  .number()
  .int()
  .min(PET_FEEDER_MANUAL_FEED_MIN)
  .max(PET_FEEDER_MANUAL_FEED_MAX)

export const PetFeederStatusSchema = z.object({
  /** Food in the TANK (hopper), as the feeder's own sensor reports it
   *  (`state.food`). A coarse level code, not grams — `0` is empty. The
   *  amount in the bowl is `bowlFood`. On dual-hopper models this is the
   *  combined reading; per-hopper levels live in `food1`/`food2`. Null when
   *  the device has not reported yet. */
  foodLevel: z.number().nullable().meta(readingMeta('none')),
  /** Food in the BOWL as the feeder reports it (`state.bowl`), in the
   *  feeder's own units. Null when the model reports none. */
  bowlFood: z.number().nullable().meta(readingMeta('none')),
  /** True while the pet is eating (`state.eating`). */
  eating: z.boolean(),
  /** Whether `markFoodReplenished` does anything on this model. When false
   *  the client must not offer it. */
  supportsMarkRefilled: z.boolean(),
  /** Hopper-1 food level (grams) on dual-hopper feeders; null on
   *  single-hopper models. */
  food1: z.number().nullable().meta(readingMeta('none')),
  /** Hopper-2 food level (grams) on dual-hopper feeders; null on
   *  single-hopper models. */
  food2: z.number().nullable().meta(readingMeta('none')),
  /** Derived low-food flag — mirrors the HA `food_level` binary_sensor
   *  (`device_class: problem`, on = low). True when the tank reports empty,
   *  or, on a dual-hopper model, when EITHER hopper is empty. */
  lowFood: z.boolean(),
  /** Battery charge 0..100 (%). On a feeder running on `mains` this is the
   *  BACKUP battery's charge, not the power source. Null when the device has
   *  no battery reading. */
  batteryPower: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** What the feeder is powered from right now: `mains` (plugged in, the
   *  battery is only a backup) or `battery`. Null when the device does not
   *  report it. */
  powerSource: z.enum(['mains', 'battery']).nullable(),
  /**
   * Desiccant life remaining, stored in seconds (duration base, D944).
   * Providers convert from the days the feeder reports. Null when the
   * model has no desiccant sensor.
   */
  desiccantLeftDays: z.number().nullable().meta(readingMeta('duration')),
  /** True while a feed is in progress. */
  feeding: z.boolean(),
  /** Decoded connectivity / power status (HA petkit device-status enum).
   *  Null until the device has reported a status. */
  status: PetFeederDeviceStatusSchema.nullable(),
  /** Decoded human-readable fault message. Null (or the device's `no_error`
   *  sentinel) means healthy; a non-null string is an active fault. Pairs
   *  with `errorCode` for consumers that want the raw integer. */
  error: z.string().nullable(),
  /** Raw device error code (0 / null = no error). */
  errorCode: z.number().nullable().meta(readingMeta('none')),
  /** True for D4S/D4SH dual-hopper hardware — gates the per-hopper UI. */
  isDualHopper: z.boolean(),
  /** Child-lock (manual-lock) setting — buttons on the unit are disabled. */
  childLock: z.boolean(),
  /** Front indicator-light setting. */
  indicatorLight: z.boolean(),
  /** Play a chime when dispensing. */
  feedSound: z.boolean(),
  /** Speaker / prompt volume level (device-scaled integer). */
  volume: z.number().meta(readingMeta('none')),
  /** Portion (grams) of the last manual feed sent from a single-hopper
   *  stepper — the default the next manual feed starts from. Persisted per
   *  device by the provider; null until a manual feed has been sent. */
  lastFeedGrams: gramsPortion.nullable(),
  /** Hopper-1 portion of the last manual feed (dual-hopper); null until sent. */
  lastFeedHopper1: gramsPortion.nullable(),
  /** Hopper-2 portion of the last manual feed (dual-hopper); null until sent. */
  lastFeedHopper2: gramsPortion.nullable(),
  /** Ms epoch when the slice was last refreshed from the cloud. */
  lastFetchedAt: z.number(),
})

export type PetFeederStatus = z.infer<typeof PetFeederStatusSchema>

export const petFeederCapability = {
  name: 'pet-feeder',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.PetFeeder],
  methods: {
    /**
     * Dispense food now. Single-hopper feeders take `grams`; dual-hopper
     * feeders (D4S/D4SH) accept `hopper1`/`hopper2` to target one or both
     * hoppers. All portions honour the 4–200 g hardware range. At least
     * one of the three must be present — the provider rejects an empty
     * request.
     */
    feed: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        grams: gramsPortion.optional(),
        hopper1: gramsPortion.optional(),
        hopper2: gramsPortion.optional(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    /** Cancel an in-progress manual feed. */
    cancelFeed: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    /** Reset the desiccant "days remaining" counter after replacing it. */
    resetDesiccant: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    /** Tell the PetKit cloud a hopper was refilled so it stops its low-food
     *  reminders (D4H/D4S/D4SH only — see `supportsMarkRefilled`). It does not
     *  change any sensor reading. */
    markFoodReplenished: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    /** Call the pet with the recorded prompt (D3). */
    callPet: method(z.object({ deviceId: z.number().int().nonnegative() }), z.void(), {
      kind: 'mutation',
      auth: 'protected',
    }),
    /** Play a stored sound by id (D3 / D4H / D4SH). */
    playSound: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        soundId: z.number().int().nonnegative(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    /** Toggle the child-lock (manual-lock) setting. */
    setChildLock: method(
      z.object({ deviceId: z.number().int().nonnegative(), on: z.boolean() }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    /** Toggle the front indicator light. */
    setIndicatorLight: method(
      z.object({ deviceId: z.number().int().nonnegative(), on: z.boolean() }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    /** Toggle the dispense chime. */
    setFeedSound: method(
      z.object({ deviceId: z.number().int().nonnegative(), on: z.boolean() }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
    /** Set the speaker / prompt volume level. */
    setVolume: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        level: z.number().int().nonnegative(),
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  status: {
    schema: PetFeederStatusSchema,
    kind: 'poll',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI feeder cards read
   * the full slice via `device.state.petFeeder.value` and refresh on
   * every poll without re-querying the provider.
   */
  runtimeState: PetFeederStatusSchema,

  /**
   * Runtime-state durability: **session** — live appliance state re-published on connect.
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
      foodLevel: { kind: 'gauge' },
      bowlFood: { kind: 'gauge' },
      food1: { kind: 'gauge' },
      food2: { kind: 'gauge' },
      batteryPower: { kind: 'gauge', unit: '%', deadband: 2 },
      desiccantLeftDays: { kind: 'gauge', unit: 's' },
    },
  },
} as const satisfies CapabilityDefinition

export type IPetFeederProvider = InferProvider<typeof petFeederCapability>
