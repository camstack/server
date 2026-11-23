/**
 * How long a switch-like device may be kept on, by its type AND role: the ONE
 * table (D1033 timed run, D1092 "on for").
 *
 * The maximum is a safety bound, not a preference. A request above it is
 * refused where it is made (timed run, a saved "on for") and clamped where it
 * is armed, so nothing a stored value says can hold a device on longer.
 */
import { DeviceRole, DeviceType } from './device-type.js'

export interface SwitchRunLimit {
  /** The longest a device is kept on in one go, in seconds. */
  readonly maxSeconds: number
  /** The one-tap run, in seconds. */
  readonly quickRunSeconds: number
}

const MINUTE = 60

/** A plug-in heater (switch + `switch-heater`): up to 3 h. */
export const SWITCH_RUN_HEATER_LIMIT: SwitchRunLimit = {
  maxSeconds: 180 * MINUTE,
  quickRunSeconds: 30 * MINUTE,
}

/** A pet fountain's pump: up to 5 min. */
export const SWITCH_RUN_PET_FOUNTAIN_LIMIT: SwitchRunLimit = {
  maxSeconds: 300,
  quickRunSeconds: 60,
}

/** A siren: up to 10 min, a one-tap run of 1 min. */
export const SWITCH_RUN_SIREN_LIMIT: SwitchRunLimit = {
  maxSeconds: 10 * MINUTE,
  quickRunSeconds: MINUTE,
}

/** Every other switch: up to 24 h, a one-tap run of 15 min. */
export const SWITCH_RUN_DEFAULT_LIMIT: SwitchRunLimit = {
  maxSeconds: 24 * 60 * MINUTE,
  quickRunSeconds: 15 * MINUTE,
}

/** The limit of a device by type and role; the default when nothing narrower applies. */
export function switchRunLimitOf(
  deviceType: string,
  role: string | null | undefined,
): SwitchRunLimit {
  if (deviceType === DeviceType.PetFountain) return SWITCH_RUN_PET_FOUNTAIN_LIMIT
  if (role === DeviceRole.SwitchHeater) return SWITCH_RUN_HEATER_LIMIT
  if (role === DeviceRole.Siren) return SWITCH_RUN_SIREN_LIMIT
  return SWITCH_RUN_DEFAULT_LIMIT
}
