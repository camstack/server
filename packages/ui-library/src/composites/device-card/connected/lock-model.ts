import type { LockControlStatus } from '@camstack/types'
import type { LockActivity, LockDoor } from '../scenes/lock/model'

export interface LockReading {
  readonly activity: LockActivity
  /** The lock itself reports the door open (`door-open`). */
  readonly selfDoorOpen: boolean
}

/** The card's activity from the lock's state; `door-open` is an unlocked lock beside an open door. */
export function lockReadingOf(status: Pick<LockControlStatus, 'state'>): LockReading {
  switch (status.state) {
    case 'locked':
      return { activity: 'locked', selfDoorOpen: false }
    case 'unlocked':
      return { activity: 'unlocked', selfDoorOpen: false }
    case 'locking':
      return { activity: 'locking', selfDoorOpen: false }
    case 'unlocking':
      return { activity: 'unlocking', selfDoorOpen: false }
    case 'jammed':
      return { activity: 'jammed', selfDoorOpen: false }
    case 'door-open':
      return { activity: 'unlocked', selfDoorOpen: true }
  }
}

/** The door is open when the linked contact says so, or the lock does. */
export function lockDoorOpen(door: LockDoor | null, selfDoorOpen: boolean): boolean {
  return selfDoorOpen || door?.reading === 'open'
}
