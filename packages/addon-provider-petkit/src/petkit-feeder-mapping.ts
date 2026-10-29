import type { PetFeederStatus } from '@camstack/types'

/**
 * Pure mapping from a PetKit `FeederDevice` reading to the CamStack
 * `pet-feeder` cap slice. Kept side-effect-free (no cloud client, no
 * `FeederDevice` import) so the decode — especially the status / error
 * decode and the dual-hopper split — is fully unit-testable with a plain
 * fake reading.
 *
 * The device class extracts a {@link FeederReading} from the live library
 * handle (getters + raw wire fields) and hands it here; this module owns
 * the vendor→cap vocabulary translation.
 */

/** The portions of the last manual feed the operator sent (persisted per
 *  device by the device class); `null` = never sent. */
export interface LastFeedPortions {
  readonly grams: number | null
  readonly hopper1: number | null
  readonly hopper2: number | null
}

export const NO_LAST_FEED: LastFeedPortions = { grams: null, hopper1: null, hopper2: null }

/** The device-config keys that remember a manual feed. */
export type FeedMemoryPatch = {
  readonly lastFeedGrams?: number
  readonly lastFeedHopper1?: number
  readonly lastFeedHopper2?: number
}

/** What to remember after a manual feed: only the portions that were fed, so a
 *  one-hopper feed on a dual-hopper model keeps the other hopper's memory. */
export function feedMemoryPatch(feed: {
  readonly grams?: number
  readonly hopper1?: number
  readonly hopper2?: number
}): FeedMemoryPatch {
  return {
    ...(feed.grams !== undefined ? { lastFeedGrams: feed.grams } : {}),
    ...(feed.hopper1 !== undefined ? { lastFeedHopper1: feed.hopper1 } : {}),
    ...(feed.hopper2 !== undefined ? { lastFeedHopper2: feed.hopper2 } : {}),
  }
}

/** Decoded connectivity / power status — the non-null half of the cap enum. */
export type PetFeederDeviceStatus = NonNullable<PetFeederStatus['status']>

/** PetKit power-interface indicator: mains vs. battery backup. Mirrors the
 *  HA petkit device-status derivation (RobertD502/py-petkit-api). */
export const PETKIT_POWER_MODE_MAINS = 1
export const PETKIT_POWER_MODE_BATTERY = 2

/**
 * Structural, library-free snapshot of the fields the cap slice needs from a
 * PetKit `FeederDevice`. The device class builds this from the live handle;
 * tests build it directly. Every field is nullable — the feeder reports a
 * subset depending on model and whether it has been polled yet.
 */
export interface FeederReading {
  /** Cloud reachability — false ⇒ the feeder is not reaching the PetKit cloud. */
  readonly online: boolean
  /** PetKit device type string (`d4sh`, `feeder`, …) — gates model-only commands. */
  readonly deviceType: string
  /** True for D4S/D4SH dual-hopper hardware (derived from the device type). */
  readonly isDualHopper: boolean
  /** True while a manual feed is in progress. */
  readonly feeding: boolean
  /** True while the pet is eating (`state.eating`). */
  readonly eating: boolean
  /** Food in the bowl, in GRAMS, from a source known to be grams (the D3 scale); null otherwise. */
  readonly bowl: number | null
  /** Tank (hopper) level code (`state.food`) — NOT the bowl; 0 = empty. */
  readonly food: number | null
  /** Hopper-1 food reading (`state.food1`) — dual-hopper only. */
  readonly food1: number | null
  /** Hopper-2 food reading (`state.food2`) — dual-hopper only. */
  readonly food2: number | null
  /** Battery charge 0..100 (%); null on mains-only models. */
  readonly batteryPower: number | null
  /** Desiccant life remaining (days); null when the model has no sensor. */
  readonly desiccantLeftDays: number | null
  /** Raw device error integer (`state.errorCode`); 0 / null = healthy. */
  readonly errorCode: number | null
  /** Human error message the cloud already decoded (`state.errorMsg`). */
  readonly errorMsg: string | null
  /** Power-interface indicator (`state.pim`): 1 = mains, 2 = battery backup. */
  readonly powerMode: number | null
  /** Child-lock (`settings.manualLock`) setting. */
  readonly childLock: boolean | null
  /** Indicator-light (`settings.lightMode`) setting. */
  readonly indicatorLight: boolean | null
  /** Dispense-chime (`settings.feedSound`) setting. */
  readonly feedSound: boolean | null
  /** Speaker / prompt volume (`settings.volume`). */
  readonly volume: number | null
}

/** Power-interface indicator to the cap's power source; unknown codes are null. */
export function decodePowerSource(powerMode: number | null): PetFeederStatus['powerSource'] {
  if (powerMode === PETKIT_POWER_MODE_MAINS) return 'mains'
  if (powerMode === PETKIT_POWER_MODE_BATTERY) return 'battery'
  return null
}

/**
 * Decode the feeder connectivity / power status to the cap enum:
 * `offline` when the cloud is unreachable, `on_batteries` when running on
 * the battery backup (power-interface = 2), else `normal`.
 */
export function decodeFeederStatus(reading: FeederReading): PetFeederDeviceStatus {
  if (!reading.online) return 'offline'
  if (reading.powerMode === PETKIT_POWER_MODE_BATTERY) return 'on_batteries'
  return 'normal'
}

/**
 * Decode the raw device error integer to a human-readable fault message, or
 * `null` when healthy (code 0 / null). Prefers the cloud-decoded `errorMsg`;
 * falls back to a stable `feeder_error_<code>` token so an unknown code is
 * never silently dropped (the raw integer is also kept in the cap's
 * `errorCode`).
 */
export function decodeFeederError(
  errorCode: number | null,
  errorMsg: string | null,
): string | null {
  if (errorCode === null || errorCode === 0) return null
  const trimmed = errorMsg?.trim()
  if (trimmed !== undefined && trimmed.length > 0) return trimmed
  return `feeder_error_${errorCode}`
}

/** Models the library documents the "added" (mark refilled) endpoint for. */
const REPLENISH_MODELS: ReadonlySet<string> = new Set(['d4h', 'd4s', 'd4sh'])

/** Whether `markFoodReplenished` does anything on this PetKit model. */
export function supportsFoodReplenished(deviceType: string): boolean {
  return REPLENISH_MODELS.has(deviceType.trim().toLowerCase())
}

/** A tank/hopper level of zero or less is the sensor saying "empty". */
function isEmptyReading(value: number | null): boolean {
  return value !== null && value <= 0
}

/**
 * Low food = the tank sensor says empty; on a dual-hopper model, EITHER hopper
 * empty counts (the combined sum hides one empty side).
 */
function resolveLowFood(reading: FeederReading, tank: number | null): boolean {
  if (isEmptyReading(tank)) return true
  return reading.isDualHopper && (isEmptyReading(reading.food1) || isEmptyReading(reading.food2))
}

/** Clamp a battery reading into the cap's 0..100 range; pass through null. */
function clampBattery(batteryPower: number | null): number | null {
  if (batteryPower === null) return null
  return Math.max(0, Math.min(100, batteryPower))
}

/**
 * Resolve the single `foodLevel` tank reading. On dual-hopper models the cap
 * exposes the combined tank (per-hopper levels live in `food1`/`food2`); when
 * the combined `food` field is absent it is derived from the two hoppers.
 */
function resolveFoodLevel(reading: FeederReading): number | null {
  if (!reading.isDualHopper) return reading.food
  if (reading.food !== null) return reading.food
  if (reading.food1 !== null && reading.food2 !== null) return reading.food1 + reading.food2
  return null
}

const SECONDS_PER_DAY = 86_400

/** Feeder reports desiccant in days. The slice stores seconds (D944). */
function desiccantSeconds(days: number | null): number | null {
  if (days === null || !Number.isFinite(days)) return null
  return days * SECONDS_PER_DAY
}

/** The slice stores a mass in kilograms (D944); the provider reads grams. */
function gramsToKilograms(grams: number | null): number | null {
  return grams === null ? null : grams / 1000
}

/**
 * Map a {@link FeederReading} to the full `pet-feeder` cap status slice.
 * Pure: same reading + timestamp in → same slice out.
 */
export function mapFeederToStatus(
  reading: FeederReading,
  now: number,
  lastFeed: LastFeedPortions = NO_LAST_FEED,
): PetFeederStatus {
  const foodLevel = resolveFoodLevel(reading)
  return {
    foodLevel,
    bowlFood: gramsToKilograms(reading.bowl),
    eating: reading.eating,
    supportsMarkRefilled: supportsFoodReplenished(reading.deviceType),
    food1: reading.isDualHopper ? reading.food1 : null,
    food2: reading.isDualHopper ? reading.food2 : null,
    lowFood: resolveLowFood(reading, foodLevel),
    batteryPower: clampBattery(reading.batteryPower),
    desiccantLeftDays: desiccantSeconds(reading.desiccantLeftDays),
    feeding: reading.feeding,
    powerSource: decodePowerSource(reading.powerMode),
    status: decodeFeederStatus(reading),
    error: decodeFeederError(reading.errorCode, reading.errorMsg),
    errorCode: reading.errorCode,
    isDualHopper: reading.isDualHopper,
    childLock: reading.childLock ?? false,
    indicatorLight: reading.indicatorLight ?? false,
    feedSound: reading.feedSound ?? false,
    volume: reading.volume ?? 0,
    lastFeedGrams: lastFeed.grams,
    lastFeedHopper1: lastFeed.hopper1,
    lastFeedHopper2: lastFeed.hopper2,
    lastFetchedAt: now,
  }
}

/**
 * Cold-start slice for a feeder that has not been polled yet — every reading
 * null / falsey, `status` null (withheld until first report). `isDualHopper`
 * is known from the persisted device type so the two-hopper UI gates
 * correctly before the first poll.
 */
export function coldStartFeederStatus(
  isDualHopper: boolean,
  lastFeed: LastFeedPortions = NO_LAST_FEED,
): PetFeederStatus {
  return {
    foodLevel: null,
    bowlFood: null,
    eating: false,
    supportsMarkRefilled: false,
    food1: null,
    food2: null,
    lowFood: false,
    batteryPower: null,
    desiccantLeftDays: null,
    feeding: false,
    powerSource: null,
    status: null,
    error: null,
    errorCode: null,
    isDualHopper,
    childLock: false,
    indicatorLight: false,
    feedSound: false,
    volume: 0,
    lastFeedGrams: lastFeed.grams,
    lastFeedHopper1: lastFeed.hopper1,
    lastFeedHopper2: lastFeed.hopper2,
    lastFetchedAt: 0,
  }
}
