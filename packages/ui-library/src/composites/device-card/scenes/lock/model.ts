import type { LockDoorSensor } from '../../../../hooks/use-lock-door-sensor'
import type { CardCommon, CardCommonActions } from '../../shell/model'

/** What the lock is doing. */
export type LockActivity = 'locked' | 'unlocked' | 'locking' | 'unlocking' | 'jammed'

/** The door the lock is linked to (a Customize link) and what it reads. */
export type LockDoor = LockDoorSensor

export interface LockCardModel {
  readonly common: CardCommon
  readonly activity: LockActivity
  readonly since: string | null
  /** The linked door sensor; null when none is linked. */
  readonly door: LockDoor | null
  /** The door is open: from the linked sensor, or the lock's own `door-open` state. */
  readonly doorOpen: boolean
  readonly canLock: boolean
  readonly canUnlock: boolean
  /** The lock can release the latch (`DeviceFeature.LockOpen`). */
  readonly canOpen: boolean
}

export interface LockCardActions extends CardCommonActions {
  readonly onLock: () => void
  readonly onUnlock: () => void
  readonly onOpen: () => void
}
