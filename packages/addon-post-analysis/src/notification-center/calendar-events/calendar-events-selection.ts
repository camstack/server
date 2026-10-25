/**
 * Calendar scope expansion — All | Only | Except → the id set a producer
 * actually queries.
 *
 * Same wire shape as detection classes (`calendars` / `calendarsExclude`):
 * include non-empty is Only; else exclude non-empty is Except; else All.
 * Pure: no I/O, no clock.
 */

export interface CalendarScope {
  readonly calendars?: readonly string[]
  readonly calendarsExclude?: readonly string[]
}

/**
 * Expand a rule's calendar scope against the known calendar ids.
 *
 * - All (both lists empty/absent) → every known id
 * - Only → the include list, intersected with known (unknown ids dropped)
 * - Except → known minus the exclude list
 *
 * An empty known set always yields empty — there is nothing to notify about.
 */
export function expandCalendarScope(
  scope: CalendarScope | undefined,
  knownIds: readonly string[],
): readonly string[] {
  const known = [...knownIds]
  if (known.length === 0) return []
  const include = scope?.calendars ?? []
  const exclude = scope?.calendarsExclude ?? []
  if (include.length > 0) {
    const wanted = new Set(include)
    return known.filter((id) => wanted.has(id))
  }
  if (exclude.length > 0) {
    const banned = new Set(exclude)
    return known.filter((id) => !banned.has(id))
  }
  return known
}
