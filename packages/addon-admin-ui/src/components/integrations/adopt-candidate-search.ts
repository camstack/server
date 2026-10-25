import type { DiscoveredChildDevice } from '@camstack/types'

/**
 * Build the searchable text for an adoption candidate.
 *
 * Emulates Home Assistant's device-table search, which matches across the
 * device name, model, manufacturer, integration, and area — not just the
 * friendly name. A device named "Robot piano terra" (no "dreame" in the
 * name) is still found by searching "dreame" / "dreametech" / "r2538z" /
 * "dreame_vacuum" because its model / manufacturer / integration metadata
 * is folded into this text.
 *
 * Pure + nullish-safe: undefined metadata fields are skipped (no literal
 * "undefined" leaks in) and the parts are space-joined with no double
 * spaces, so a plain substring match over the result behaves like HA's
 * multi-field search.
 */
export function candidateSearchText(candidate: DiscoveredChildDevice): string {
  const metadata = candidate.metadata
  const parts: readonly (string | undefined)[] = [
    candidate.name,
    candidate.childNativeId,
    metadata.model,
    metadata.manufacturer,
    metadata.integration,
    metadata.externalLocation,
  ]
  return parts
    .filter((part): part is string => typeof part === 'string' && part.length > 0)
    .join(' ')
}
