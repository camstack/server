/**
 * The rows of the Customize table that are not catalog targets: a composition
 * field group the catalog has no row for (an "off-catalog" cap), and the
 * device's linked devices. They list in the same table, with the same columns
 * and actions, instead of below it.
 */
import {
  type CompositionFieldsCard,
  decodeCompositionToCards,
  type CompositionFieldRead,
  type CompositionCardFieldEntry,
} from '@camstack/types'
import type { Composition } from '@camstack/types'
import { configCardCaps } from '../config/ConfigCustomizeList'
import { eventCardTargets } from '../event/event-targets'
import { keyedArrayCardTargets } from '../keyed/KeyedArrayCard'
import { scalarCardTargets } from '../scalar/scalar-targets'

/** The caps the catalog rows already cover on this device type: no off-catalog row for them. */
export function catalogCoveredCaps(deviceType: string): ReadonlySet<string> {
  const covered = new Set<string>()
  for (const { cap } of scalarCardTargets()) covered.add(cap)
  for (const { cap } of keyedArrayCardTargets()) covered.add(cap)
  for (const { cap } of eventCardTargets()) covered.add(cap)
  for (const cap of configCardCaps(deviceType)) covered.add(cap)
  return covered
}

/** The stored field groups the catalog rows do not cover, in stored order. */
export function offCatalogCards(
  composition: Composition | null,
  covered: ReadonlySet<string>,
): readonly CompositionFieldsCard[] {
  if (composition === null) return []
  const cards: CompositionFieldsCard[] = []
  for (const slot of decodeCompositionToCards(composition).model.cards) {
    if (slot.card.cardKind === 'fields' && !covered.has(slot.card.cap)) cards.push(slot.card)
  }
  return cards
}

/** Every device read by one field entry (a link, a formula's bindings, a unit conversion). */
export function entryReads(entry: CompositionCardFieldEntry): readonly CompositionFieldRead[] {
  switch (entry.kind) {
    case 'from':
      return entry.sources
    case 'convert-unit':
      return [entry.source]
    case 'formula':
      return Object.values(entry.bindings).flatMap((binding) =>
        binding.kind === 'from' ? [binding] : [],
      )
    case 'companion':
      return []
  }
}
