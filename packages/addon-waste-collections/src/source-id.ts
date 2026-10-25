/**
 * Stable calendar source ids derived from the operator label.
 * Pattern: `^[a-z0-9][a-z0-9-]{0,63}$` (max 64 chars).
 */

export const SOURCE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

/** Slugify a display label into a candidate source id (may be empty). */
export function slugifySourceLabel(label: string): string {
  const s = label
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (s.length === 0) return ''
  return s.slice(0, 64)
}

/**
 * Pick an unused id from `label`. Collisions append `-2`, `-3`, …
 * (truncated so the result stays within the 64-char pattern).
 */
export function allocateSourceId(
  label: string,
  existingIds: ReadonlySet<string> | readonly string[],
): string {
  const taken = existingIds instanceof Set ? existingIds : new Set(existingIds)
  const baseRaw = slugifySourceLabel(label)
  const base = baseRaw.length > 0 ? baseRaw : 'source'
  if (!taken.has(base) && SOURCE_ID_PATTERN.test(base)) return base

  for (let n = 2; n < 10_000; n++) {
    const suffix = `-${n}`
    const truncated = base.slice(0, Math.max(1, 64 - suffix.length))
    const candidate = `${truncated.replace(/-+$/g, '')}${suffix}`
    if (SOURCE_ID_PATTERN.test(candidate) && !taken.has(candidate)) return candidate
  }
  throw new Error('could not allocate a unique source id')
}
