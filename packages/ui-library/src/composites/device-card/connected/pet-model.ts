import type { PetFeederStatus, PetFountainStatus } from '@camstack/types'
import type { PetFeederActivity, PetFeederHopper, PetFountainActivity } from '../scenes/pet/model'

/** A vendor's "no fault" sentinel string; null and empty mean the same. */
const NO_ERROR = 'no_error'

/** The fault a device reports, or null when it is healthy. */
export function petFaultOf(error: string | null): string | null {
  return error === null || error === '' || error === NO_ERROR ? null : error
}

export function petFeederActivityOf(
  status: Pick<PetFeederStatus, 'error' | 'feeding' | 'eating' | 'lowFood'>,
): PetFeederActivity {
  if (petFaultOf(status.error) !== null) return 'fault'
  if (status.feeding) return 'feeding'
  if (status.eating) return 'eating'
  if (status.lowFood) return 'low'
  return 'ready'
}

export function petFountainActivityOf(
  status: Pick<PetFountainStatus, 'error' | 'empty' | 'pumpRunning'>,
): PetFountainActivity {
  if (petFaultOf(status.error) !== null) return 'fault'
  if (status.empty === true) return 'empty'
  if (status.pumpRunning === null) return 'unknown'
  return status.pumpRunning ? 'running' : 'stopped'
}

/** The feed command's input: a single hopper takes grams, a dual one names the hopper. */
export interface PetFeedInput {
  readonly grams?: number
  readonly hopper1?: number
  readonly hopper2?: number
}

export function petFeedInput(grams: number, hopper: PetFeederHopper): PetFeedInput {
  if (hopper === 'hopper1') return { hopper1: grams }
  if (hopper === 'hopper2') return { hopper2: grams }
  return { grams }
}
