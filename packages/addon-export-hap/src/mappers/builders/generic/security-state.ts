/**
 * The alarm panel's state, as HomeKit models it.
 *
 * Pure, and separate from the builder, because this is where the mapping is
 * either honest or dangerous and it deserves to be read on its own.
 *
 * ```
 *  cap state              CurrentState       TargetState
 *  disarmed               DISARMED           DISARM
 *  armed_home             STAY_ARM           STAY_ARM
 *  armed_away             AWAY_ARM           AWAY_ARM
 *  armed_night            NIGHT_ARM          NIGHT_ARM
 *  armed_vacation         AWAY_ARM           AWAY_ARM     (see below)
 *  armed_custom_bypass    STAY_ARM           STAY_ARM     (see below)
 *  arming                 DISARMED           <memo>       (NOT yet armed)
 *  pending                <memo>             <memo>       (entry delay: still armed)
 *  disarming              <memo>             DISARM
 *  triggered              ALARM_TRIGGERED    <memo>
 * ```
 *
 * ## The five states HomeKit does not have
 *
 * The panel has five arm modes and HomeKit has three. `armed_vacation` is an
 * away arm for a longer absence — AWAY is true about it. `armed_custom_bypass`
 * is armed with something deliberately excluded, which is what STAY means to a
 * controller. Neither is a perfect word; both are TRUE, and inventing a fourth
 * mode is not on offer.
 *
 * ## The transitional states, and the lie worth refusing
 *
 * `arming` reports DISARMED, not the mode being armed to. The system is not set
 * while the exit delay runs, and this is the lock builder's rule applied to a
 * bigger consequence: an operator who sees ARMED walks out on a house that is
 * not. `pending` is the opposite end — an entry delay, somebody has opened a
 * door and the panel is counting down — so it stays ARMED, because reporting
 * DISARMED there hides a break-in in progress.
 *
 * ## Why a memo, and what `null` means
 *
 * `pending`, `disarming` and `triggered` do not carry the mode the panel was
 * armed to; only the last settled state knows it. The caller remembers it and
 * passes it in. With no memo the answer is the least it can say — and a `null`
 * target means DO NOT WRITE that characteristic, never a fallback to DISARM: a
 * triggered panel whose target read DISARM tells iOS somebody disarmed the
 * system while the siren is sounding.
 */
import type { AlarmArmMode, AlarmState } from '@camstack/types'
import { Characteristic } from '@homebridge/hap-nodejs'

/** The last SETTLED state, remembered by the caller for the transitions. */
export type ArmedMemo = Extract<
  AlarmState,
  'armed_home' | 'armed_away' | 'armed_night' | 'armed_vacation' | 'armed_custom_bypass'
> | null

export interface SecuritySystemState {
  readonly current: number
  /** `null` = leave the characteristic alone. */
  readonly target: number | null
}

/** Is this a settled arm state worth remembering? */
export function armedMemoOf(state: AlarmState): ArmedMemo {
  return state === 'armed_home' ||
    state === 'armed_away' ||
    state === 'armed_night' ||
    state === 'armed_vacation' ||
    state === 'armed_custom_bypass'
    ? state
    : null
}

function currentForArmed(state: NonNullable<ArmedMemo>): number {
  switch (state) {
    case 'armed_home':
    case 'armed_custom_bypass':
      return Characteristic.SecuritySystemCurrentState.STAY_ARM
    case 'armed_night':
      return Characteristic.SecuritySystemCurrentState.NIGHT_ARM
    default:
      return Characteristic.SecuritySystemCurrentState.AWAY_ARM
  }
}

function targetForArmed(state: NonNullable<ArmedMemo>): number {
  switch (state) {
    case 'armed_home':
    case 'armed_custom_bypass':
      return Characteristic.SecuritySystemTargetState.STAY_ARM
    case 'armed_night':
      return Characteristic.SecuritySystemTargetState.NIGHT_ARM
    default:
      return Characteristic.SecuritySystemTargetState.AWAY_ARM
  }
}

export function securityStateFor(state: AlarmState, memo: ArmedMemo): SecuritySystemState {
  const settled = armedMemoOf(state)
  if (settled !== null) {
    return { current: currentForArmed(settled), target: targetForArmed(settled) }
  }
  switch (state) {
    case 'disarmed':
      return {
        current: Characteristic.SecuritySystemCurrentState.DISARMED,
        target: Characteristic.SecuritySystemTargetState.DISARM,
      }
    case 'arming':
      // Not armed yet — and the target is the mode being armed to, when known.
      return {
        current: Characteristic.SecuritySystemCurrentState.DISARMED,
        target: memo === null ? null : targetForArmed(memo),
      }
    case 'disarming':
      return {
        current:
          memo === null
            ? Characteristic.SecuritySystemCurrentState.DISARMED
            : currentForArmed(memo),
        target: Characteristic.SecuritySystemTargetState.DISARM,
      }
    case 'pending':
      // Entry delay: still armed, still meant to be. Without a memo, AWAY is
      // the least-false HomeKit word — DISARMED here hid a break-in in
      // progress when the accessory missed the settled `armed_*` slice.
      return {
        current:
          memo === null
            ? Characteristic.SecuritySystemCurrentState.AWAY_ARM
            : currentForArmed(memo),
        target:
          memo === null ? Characteristic.SecuritySystemTargetState.AWAY_ARM : targetForArmed(memo),
      }
    default:
      return {
        current: Characteristic.SecuritySystemCurrentState.ALARM_TRIGGERED,
        target: memo === null ? null : targetForArmed(memo),
      }
  }
}

/**
 * The arm mode behind a HomeKit target, or `null` for DISARM and for anything
 * outside the four values HomeKit defines.
 *
 * `null` is not an error the caller can ignore: DISARM is a different COMMAND,
 * and a value HomeKit never sends is a write this builder refuses to translate.
 */
export function alarmArmModeFor(target: number): AlarmArmMode | null {
  switch (target) {
    case Characteristic.SecuritySystemTargetState.STAY_ARM:
      return 'home'
    case Characteristic.SecuritySystemTargetState.AWAY_ARM:
      return 'away'
    case Characteristic.SecuritySystemTargetState.NIGHT_ARM:
      return 'night'
    default:
      return null
  }
}
