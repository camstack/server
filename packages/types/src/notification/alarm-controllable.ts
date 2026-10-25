/**
 * Controllable openings on the alarm: defaults for the two switches, and the
 * actuation each cap gets when "secure on arm" fires.
 *
 * Controllable = cover / lock-control / switch. Contacts stay passive: they
 * block by default and have no secure switch.
 */
import { isAlarmControllableCap, type NcAlarmControllableCap } from './alarm-membership.js'

export interface AlarmDeviceBlocksInput {
  readonly controllable: boolean
  readonly deviceId: number
  /** Contact opt-out list (existing). */
  readonly nonBlocking: readonly number[]
  /** Controllable opt-IN list (default empty = do not block). */
  readonly blocking: readonly number[]
}

/** Whether this device refuses the arm when open. */
export function alarmDeviceBlocksArming(input: AlarmDeviceBlocksInput): boolean {
  if (input.controllable) return input.blocking.includes(input.deviceId)
  return !input.nonBlocking.includes(input.deviceId)
}

export interface AlarmDeviceSecureOnArmInput {
  readonly controllable: boolean
  readonly deviceId: number
  /** Controllable opt-OUT list (default empty = secure ON). */
  readonly secureOnArmOff: readonly number[]
}

/** Whether this controllable should be closed/locked/turned off on arm. */
export function alarmDeviceSecureOnArm(input: AlarmDeviceSecureOnArmInput): boolean {
  if (!input.controllable) return false
  return !input.secureOnArmOff.includes(input.deviceId)
}

export interface NcAlarmSecureActuation {
  readonly cap: NcAlarmControllableCap
  readonly method: string
  readonly args: Readonly<Record<string, unknown>>
}

/** The one secure command for a controllable opening cap, or null for contacts. */
export function secureActuationFor(cap: string): NcAlarmSecureActuation | null {
  if (!isAlarmControllableCap(cap)) return null
  switch (cap) {
    case 'cover':
      return { cap, method: 'close', args: {} }
    case 'lock-control':
      return { cap, method: 'lock', args: {} }
    case 'switch':
      return { cap, method: 'setState', args: { on: false } }
  }
}
