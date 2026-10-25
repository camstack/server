/**
 * What HomeKit may ASK of a panel, and what the panel is actually told.
 *
 * The sibling `security-state.ts` answers the reporting half — what the panel's
 * state looks like to HomeKit. This module answers the writing half, and it
 * exists because the two directions are not inverses of each other:
 *
 *  - HomeKit has three arm modes and the panel has five, so one HomeKit target
 *    stands for TWO panel modes (`STAY_ARM` ← home *and* custom_bypass,
 *    `AWAY_ARM` ← away *and* vacation). Translating a write with
 *    `alarmArmModeFor` alone always picks the primary — correct for almost
 *    every panel, and wrong for the one that offers only the secondary. A
 *    custom-bypass-only panel publishes a STAY tile and would be sent `home`,
 *    which it refuses.
 *  - `availableModes` says which arm modes the panel takes. HomeKit can be told
 *    that up front (`Characteristic.setProps({ validValues })`), which is
 *    better than accepting a target and failing the command: iOS then renders
 *    only the tiles that work, instead of one that errors when tapped.
 *
 * ## Empty `availableModes` is UNKNOWN, not "none"
 *
 * A provider that never populated the list and one that genuinely accepts no
 * arm mode produce the same empty array, and the two readings have opposite
 * consequences. Locking HomeKit down to DISARM on a guess takes the controls
 * off a working panel; leaving them alone costs, at worst, one refused command
 * that the panel itself names. So an empty list constrains nothing
 * (`targetValidValuesFor` → `null`) and translates optimistically, and the
 * builder logs the fact against the device id.
 */
import type { AlarmArmMode } from '@camstack/types'
import { Characteristic } from '@homebridge/hap-nodejs'

import { alarmArmModeFor } from './security-state.js'

/**
 * The panel modes behind each HomeKit target, PRIMARY first.
 *
 * The primary is the mode `alarmArmModeFor` names; the secondary is the other
 * mode `security-state.ts` reports through the same HomeKit value, so the two
 * modules agree in both directions by construction.
 */
const MODES_BY_TARGET: ReadonlyMap<number, readonly AlarmArmMode[]> = new Map([
  [Characteristic.SecuritySystemTargetState.STAY_ARM, ['home', 'custom_bypass'] as const],
  [Characteristic.SecuritySystemTargetState.AWAY_ARM, ['away', 'vacation'] as const],
  [Characteristic.SecuritySystemTargetState.NIGHT_ARM, ['night'] as const],
])

/** Arm targets in the order HomeKit numbers them; DISARM is appended last. */
const ARM_TARGETS: readonly number[] = [
  Characteristic.SecuritySystemTargetState.STAY_ARM,
  Characteristic.SecuritySystemTargetState.AWAY_ARM,
  Characteristic.SecuritySystemTargetState.NIGHT_ARM,
]

/**
 * The `validValues` for `SecuritySystemTargetState`, or `null` to leave
 * HomeKit's own four values in place.
 *
 * DISARM is always present: disarming is not one of the panel's arm modes and
 * a panel that cannot be disarmed is not a thing this cap can express.
 */
export function targetValidValuesFor(
  availableModes: readonly AlarmArmMode[],
): readonly number[] | null {
  if (availableModes.length === 0) return null
  const values = ARM_TARGETS.filter((target) =>
    (MODES_BY_TARGET.get(target) ?? []).some((mode) => availableModes.includes(mode)),
  )
  return [...values, Characteristic.SecuritySystemTargetState.DISARM]
}

/**
 * The arm mode to send for a HomeKit target, or `null` when there is none.
 *
 * `null` is not a shrug the caller may swallow: DISARM is a different command,
 * and an arm target the panel accepts no mode for is a write this module
 * refuses to translate rather than guess at.
 */
export function armModeForTarget(
  target: number,
  availableModes: readonly AlarmArmMode[],
): AlarmArmMode | null {
  const primary = alarmArmModeFor(target)
  if (primary === null) return null
  if (availableModes.length === 0) return primary
  const candidates = MODES_BY_TARGET.get(target) ?? [primary]
  return candidates.find((mode) => availableModes.includes(mode)) ?? null
}
