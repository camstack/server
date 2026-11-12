/** Pure mapping from `vacuum-control` / `lawn-mower-control` to the robot scene. */
import type { LawnMowerControlStatus, VacuumControlStatus } from '@camstack/types'
import type { RobotActivity } from '../illustrations/RobotIllustration'

const FULL = 100

/** Docked: charging until the battery is full (or while its level is unknown it sleeps). */
const docked = (battery: number | null): RobotActivity =>
  battery !== null && battery < FULL ? 'charge' : 'sleep'

export function vacuumActivityOf(status: VacuumControlStatus): RobotActivity {
  switch (status.state) {
    case 'cleaning':
      return 'clean'
    case 'paused':
      return 'pause'
    case 'returning':
      return 'ret'
    case 'docked':
    case 'drying':
      return docked(status.batteryLevel)
    case 'error':
      return 'err'
    case 'idle':
      return 'idle'
  }
}

export function mowerActivityOf(status: LawnMowerControlStatus): RobotActivity {
  switch (status.activity) {
    case 'mowing':
      return 'clean'
    case 'paused':
      return 'pause'
    case 'docked':
      return docked(status.batteryLevel)
    case 'error':
      return 'err'
    case 'idle':
      return 'idle'
  }
}
