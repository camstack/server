/**
 * Whether a location may be deleted from its row. The hub refuses a delete that would leave the
 * type with no location, or with none still accepting writes, or of a `single` kind; the page
 * shows no Delete for those, so the operator never meets the refusal as an error.
 */
import type { StorageLocation, StorageLocationDeclaration } from '@camstack/types'
import { modeAcceptsWrites, resolveLocationMode } from './location-mode'

type LocationFacts = Pick<StorageLocation, 'id' | 'enabled' | 'config'>

export function locationDeletable(
  location: LocationFacts,
  siblings: readonly LocationFacts[],
  cardinality: StorageLocationDeclaration['cardinality'],
): boolean {
  if (cardinality === 'single') return false
  if (siblings.length <= 1) return false
  if (modeAcceptsWrites(resolveLocationMode(location))) {
    const writable = siblings.filter((s) => modeAcceptsWrites(resolveLocationMode(s)))
    if (writable.length <= 1) return false
  }
  return true
}
