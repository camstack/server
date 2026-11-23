/**
 * How every notification rule kind STORES its tags (D1054): event rules,
 * summaries, timelapses and calendar-events rules share this one rule.
 *
 * Tags are normalised (trimmed, de-duplicated case-insensitively, capped) and
 * an empty list drops the key, so `[]` from an editor clears them and a rule
 * that never had tags is written back byte-identical. Spread the result over
 * the rule without its `tags`: `{ ...rest, ...storedTags(tags) }`.
 */

import { normalizeTags } from '@camstack/types'

/** The stored-tags slice of a rule: `{}` when there are none. */
export interface StoredTags {
  readonly tags?: string[]
  readonly tagIds?: string[]
}

/**
 * The names and, when they still line up, the ids (D1089). The ids are index-aligned with the
 * names, so a list whose length differs from the normalised names (a name was de-duplicated or
 * dropped) is no longer aligned and is not kept: the rule falls back to its names.
 */
export function storedTags(
  tags: readonly string[] | undefined,
  tagIds?: readonly string[],
): StoredTags {
  if (tags === undefined) return {}
  const normalized = normalizeTags(tags)
  if (normalized.length === 0) return {}
  const aligned = tagIds !== undefined && tagIds.length === normalized.length
  return aligned ? { tags: normalized, tagIds: [...tagIds] } : { tags: normalized }
}

/**
 * Spread over the merged candidate of an update: a patch that names `tags` without `tagIds`
 * edits the names alone, so the stored ids no longer describe them and are dropped.
 */
export function staleIdsDropped(patch: {
  readonly tags?: readonly string[]
  readonly tagIds?: readonly string[]
}): { readonly tagIds?: undefined } {
  return patch.tags !== undefined && patch.tagIds === undefined ? { tagIds: undefined } : {}
}
