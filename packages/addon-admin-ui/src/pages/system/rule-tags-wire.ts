/**
 * How every rule editor sends `tags` (D1054) — event rules, summaries,
 * timelapses and calendar-events rules alike.
 *
 * A create names `tags` only when there are some. An edit names them only when
 * they CHANGED, and then as the whole list (`[]` clears them): the upsert
 * merges the patch over the stored rule, so an absent key keeps what is stored,
 * and a non-admin's save that leaves tags alone never trips the admin-only gate.
 */

import { normalizeTags } from '@dominevo/types'

/** The tags slice of a wire payload: `{}` when there is nothing to send. */
export interface TagsWire {
  readonly tags?: readonly string[]
}

/** What a reader of a list answer keeps: a list of strings, else nothing. */
export function parseRuleTags(raw: unknown): readonly string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const tags = raw.filter((t): t is string => typeof t === 'string')
  return tags.length > 0 ? tags : undefined
}

export function tagsForCreate(tags: readonly string[]): TagsWire {
  return tags.length > 0 ? { tags: [...tags] } : {}
}

/** `{ tags }` when the form's tags differ from the stored ones (case-insensitively normalised). */
export function tagsForPatch(
  tags: readonly string[],
  stored: readonly string[] | undefined,
): TagsWire {
  const next = normalizeTags(tags)
  const before = normalizeTags(stored ?? [])
  const same = next.length === before.length && next.every((tag, i) => tag === before[i])
  return same ? {} : { tags: [...tags] }
}
