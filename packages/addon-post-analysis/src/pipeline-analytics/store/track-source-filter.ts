/**
 * The SQL predicate behind `excludeSources` — track provenance as a real query
 * filter (see `ExcludeSourcesDoc` in the cap for why the query needs one).
 *
 * ## The column is nullable, and that decides everything
 *
 * `persistCompleted` writes `source` only when the track carries one, and a
 * pipeline track does not: on the live hub every pipeline row's `source` is
 * NULL and only the synthetic rows (`audio`, `sensor`) carry a value. So there
 * are two exact compilations and the choice between them is purely "is
 * `pipeline` one of the sources being excluded":
 *
 *  - **`pipeline` kept** → NULL-safe `whereNotIn`. `(source IS NULL OR source
 *    NOT IN (…))` keeps every pipeline row without naming a value they do not
 *    carry, and keeps any source added after this shipped — an exclusion list
 *    can only hide what it names.
 *  - **`pipeline` excluded** → positive `whereIn` over what survives. NULL is
 *    then exactly the set being dropped, and a NULL-safe exclusion would keep
 *    precisely the rows it was asked to remove. (Excluding EVERY known source
 *    is the degenerate case: `whereIn` with an empty list, which the compiler
 *    reads as "no filter", so it is answered here instead — see below.)
 *
 * Both are exact. Neither leaves a row's fate to a default, which is the whole
 * point: the class filter this replaces was a SUPERSET that kept every row it
 * could not read, and that is what made "Sensor" and "Audio" select the same
 * 116 rows on the live hub.
 */
import { type TrackSource, TrackSourceSchema } from '@camstack/types'

/** Every source the build knows. Derived from the schema, never restated — a
 *  source added to the enum must not need a second edit here to be filterable. */
const KNOWN_SOURCES: readonly TrackSource[] = TrackSourceSchema.options

/**
 * The filter fragment to spread into a store query, or `null` when the request
 * excludes nothing and no predicate should be added at all.
 *
 * `null` is also the answer when the exclusion names EVERY known source: that
 * is a caller asking for no rows through a filter whose empty forms all mean
 * "no narrowing", and answering it with a silent no-op filter would be the
 * exact lie this module exists to remove. The caller is told instead — see
 * {@link trackSourceFilter}'s `impossible` result.
 */
export type TrackSourceFilterResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'impossible' }
  | {
      readonly kind: 'filter'
      readonly filter:
        | { readonly whereNotIn: Readonly<Record<string, readonly TrackSource[]>> }
        | { readonly whereIn: Readonly<Record<string, readonly TrackSource[]>> }
    }

/**
 * Compile `excludeSources` into a store filter fragment.
 *
 * Pure. Unknown / duplicate entries are normalised away: the input crosses a
 * wire from a client whose enum may be older or newer than this one.
 */
export function trackSourceFilter(
  excludeSources: readonly TrackSource[] | undefined,
): TrackSourceFilterResult {
  const excluded = new Set<TrackSource>(
    (excludeSources ?? []).filter((s): s is TrackSource => KNOWN_SOURCES.includes(s)),
  )
  if (excluded.size === 0) return { kind: 'none' }
  const kept = KNOWN_SOURCES.filter((s) => !excluded.has(s))
  if (kept.length === 0) return { kind: 'impossible' }
  if (!excluded.has('pipeline')) {
    return { kind: 'filter', filter: { whereNotIn: { source: [...excluded] } } }
  }
  return { kind: 'filter', filter: { whereIn: { source: kept } } }
}
