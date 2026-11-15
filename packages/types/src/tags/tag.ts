import { z } from 'zod'
import { IconKeySchema, type IconKey } from '../device/icon-catalog.js'

/**
 * Tags (D1054). A tag is a trimmed string kept in a `tags` array on the record
 * it labels; the only registry is its STYLE (colour token + icon). Tags
 * compare trimmed and case-insensitively, like rooms.
 */

export const TAG_NAME_MAX_LENGTH = 40
export const TAGS_PER_RECORD_MAX = 20

/** One tag name: trimmed, 1..40 characters. */
export const TagNameSchema = z.string().trim().min(1).max(TAG_NAME_MAX_LENGTH)
export type TagName = z.infer<typeof TagNameSchema>

/** The `tags` field every owner record carries. Absent = no tags. */
export const TagsFieldSchema = z.array(TagNameSchema).max(TAGS_PER_RECORD_MAX)

/** Fixed tag palette ids (map to `--color-tag-*` theme tokens, never a hex). */
export const TAG_COLOR_IDS = [
  'tag-a',
  'tag-b',
  'tag-c',
  'tag-d',
  'tag-e',
  'tag-f',
  'tag-g',
  'tag-h',
] as const

export const TagColorIdSchema = z.enum(TAG_COLOR_IDS)
export type TagColorId = z.infer<typeof TagColorIdSchema>

/** The icon a tag without a chosen style shows. */
export const DEFAULT_TAG_ICON: IconKey = 'tag'

export const TagStyleSchema = z.object({
  name: TagNameSchema,
  color: TagColorIdSchema,
  icon: IconKeySchema,
})
export type TagStyle = z.infer<typeof TagStyleSchema>

/** The comparison key of a tag: trimmed and lower-cased. */
export function tagKey(name: string): string {
  return name.trim().toLowerCase()
}

/** Two tag names are the same tag. */
export function sameTag(a: string, b: string): boolean {
  return tagKey(a) === tagKey(b)
}

/** Stable FNV-1a hash of the tag key → one palette slot. */
function hashTagKey(key: string): number {
  let h = 2166136261
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

/** The colour a tag shows until the operator styles it (same name → same colour, case-insensitively). */
export function defaultTagColorId(name: string): TagColorId {
  const id = TAG_COLOR_IDS[hashTagKey(tagKey(name)) % TAG_COLOR_IDS.length]
  if (id !== undefined) return id
  return 'tag-a'
}

/** Trim, drop empty, dedupe case-insensitively keeping the first spelling. */
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of tags) {
    const name = raw.trim()
    if (name.length === 0) continue
    const key = tagKey(name)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(name)
  }
  return out
}

/** `tags` with every spelling of `from` replaced by `to` (deduped), or `null` when it did not carry `from`. */
export function renameInTags(tags: readonly string[], from: string, to: string): string[] | null {
  if (!tags.some((t) => sameTag(t, from))) return null
  return normalizeTags(tags.map((t) => (sameTag(t, from) ? to : t)))
}

/** `tags` without `name`, or `null` when it did not carry it. */
export function removeFromTags(tags: readonly string[], name: string): string[] | null {
  if (!tags.some((t) => sameTag(t, name))) return null
  return tags.filter((t) => !sameTag(t, name))
}
