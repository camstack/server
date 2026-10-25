/**
 * Same predicate the ledger walk uses before it will list an hour:
 * a location still open to writers is a lower bound, not the truth.
 *
 * `enabled` absent means active (StorageLocationSchema). `readOnly` lives on
 * `config`, the flag a drain already sets.
 */
import type { StorageLocation } from '@camstack/types'

export function footageLocationFrozen(location: StorageLocation): boolean {
  const enabled = location.enabled ?? true
  const readOnly = location.config['readOnly'] === true
  return !enabled || readOnly
}
