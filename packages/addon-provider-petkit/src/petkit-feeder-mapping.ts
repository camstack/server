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
  /** True for D4S/D4SH dual-hopper hardware (derived from the device type). */
  readonly isDualHopper: boolean
  /** True while a manual feed is in progress. */
  readonly feeding: boolean
  /** Combined bowl food reading (`state.food`). */
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

/** Clamp a battery reading into the cap's 0..100 range; pass through null. */
function clampBattery(batteryPower: number | null): number | null {
  if (batteryPower === null) return null
  return Math.max(0, Math.min(100, batteryPower))
}

/**
 * Resolve the single `foodLevel` bowl reading. On dual-hopper models the cap
 * exposes the combined bowl (per-hopper levels live in `food1`/`food2`); when
 * the combined `food` field is absent it is derived from the two hoppers.
 */
function resolveFoodLevel(reading: FeederReading): number | null {
  if (!reading.isDualHopper) return reading.food
  if (reading.food !== null) return reading.food
  if (reading.food1 !== null && reading.food2 !== null) return reading.food1 + reading.food2
  return null
}

/**
 * Map a {@link FeederReading} to the full `pet-feeder` cap status slice.
 * Pure: same reading + timestamp in → same slice out.
 */
export function mapFeederToStatus(reading: FeederReading, now: number): PetFeederStatus {
  const foodLevel = resolveFoodLevel(reading)
  return {
    foodLevel,
    food1: reading.isDualHopper ? reading.food1 : null,
    food2: reading.isDualHopper ? reading.food2 : null,
    lowFood: foodLevel !== null && foodLevel <= 0,
    batteryPower: clampBattery(reading.batteryPower),
    desiccantLeftDays: reading.desiccantLeftDays,
    feeding: reading.feeding,
    status: decodeFeederStatus(reading),
    error: decodeFeederError(reading.errorCode, reading.errorMsg),
    errorCode: reading.errorCode,
    isDualHopper: reading.isDualHopper,
    childLock: reading.childLock ?? false,
    indicatorLight: reading.indicatorLight ?? false,
    feedSound: reading.feedSound ?? false,
    volume: reading.volume ?? 0,
    lastFetchedAt: now,
  }
}

/**
 * Cold-start slice for a feeder that has not been polled yet — every reading
 * null / falsey, `status` null (withheld until first report). `isDualHopper`
 * is known from the persisted device type so the two-hopper UI gates
 * correctly before the first poll.
 */
export function coldStartFeederStatus(isDualHopper: boolean): PetFeederStatus {
  return {
    foodLevel: null,
    food1: null,
    food2: null,
    lowFood: false,
    batteryPower: null,
    desiccantLeftDays: null,
    feeding: false,
    status: null,
    error: null,
    errorCode: null,
    isDualHopper,
    childLock: false,
    indicatorLight: false,
    feedSound: false,
    volume: 0,
    lastFetchedAt: 0,
  }
}
