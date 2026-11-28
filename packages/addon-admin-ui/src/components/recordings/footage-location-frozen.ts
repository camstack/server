/**
 * Same predicate the ledger walk uses before it will list an hour: a location
 * still open to writers is a lower bound, not the truth. Follows the typed
 * `mode` through the policy module (D385) — a location is frozen when it is
 * not a write target.
 */
import { mayWriteToLocation } from '@dominevo/types'
import type { StorageLocation } from '@dominevo/types'

export function footageLocationFrozen(location: StorageLocation): boolean {
  return !mayWriteToLocation(location)
}
