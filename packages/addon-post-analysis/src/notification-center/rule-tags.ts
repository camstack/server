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
}

export function storedTags(tags: readonly string[] | undefined): StoredTags {
  if (tags === undefined) return {}
  const normalized = normalizeTags(tags)
  return normalized.length === 0 ? {} : { tags: normalized }
}
