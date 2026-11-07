/**
 * "Follow the device's switch" on the Customize running row. The default is
 * derived by the types (an actuator switch and no supply relation); this model
 * only decides whether the toggle is offered, what it reads, and the
 * composition each position saves. ON stores nothing (the default applies),
 * OFF stores the explicit opt-out; a stored composition is never rewritten
 * until the operator moves the toggle.
 */
import {
  actuatorSwitchDrivesRunning,
  type Composition,
  isRunningOptOut,
  runningOptOutFeature,
} from '@camstack/types'
import { featureOf, withoutFeature } from '../customization-save'

const RUNNING_CAP = 'running-state'
const RUNNING_TARGET = 'running'

export type FollowSwitchRead =
  | { readonly offered: false }
  | {
      readonly offered: true
      readonly following: boolean
      /** Following would discard a rule the operator wrote. */
      readonly discardsRule: boolean
    }

function withoutRunning(composition: Composition): Composition {
  return {
    ...composition,
    features: composition.features.filter((f) => f.cap !== RUNNING_CAP),
  }
}

export function isFollowSwitchRow(cap: string, targetId: string): boolean {
  return cap === RUNNING_CAP && targetId === RUNNING_TARGET
}

export function readFollowSwitch(composition: Composition | null): FollowSwitchRead {
  if (composition === null || !actuatorSwitchDrivesRunning(withoutRunning(composition))) {
    return { offered: false }
  }
  const stored = featureOf(composition, RUNNING_CAP)
  if (stored === null) return { offered: true, following: true, discardsRule: false }
  return {
    offered: true,
    following: false,
    discardsRule: !isRunningOptOut(stored),
  }
}

/** The composition after the toggle moves; null means the block goes (nothing left on an existing device). */
export function saveFollowSwitch(composition: Composition, follow: boolean): Composition | null {
  if (follow) return withoutFeature(composition, RUNNING_CAP)
  return {
    ...withoutRunning(composition),
    features: [...withoutRunning(composition).features, runningOptOutFeature()],
  }
}

/** The running row is listed with nothing stored: following the switch IS the default, and the toggle lives on that row. */
export function followSwitchRowListed(
  cap: string,
  targetId: string,
  composition: Composition | null,
): boolean {
  return isFollowSwitchRow(cap, targetId) && readFollowSwitch(composition).offered
}
