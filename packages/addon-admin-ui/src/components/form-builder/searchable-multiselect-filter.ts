import type { ConfigOption } from '@camstack/types'

/**
 * Pure filter/partition helpers for the searchable multi-select field.
 *
 * The searchable multi-select replaces the flat wall of chips for
 * large option sets (e.g. a list that enumerates every cluster device). Search is a case-insensitive
 * substring match folded over each option's `value`, `label`, and
 * `description` — so a device is found by its name, its numeric id
 * (the option value), OR its location (folded into the label as
 * `Name (Location)` by the server contribution).
 *
 * Everything here is pure so it can be unit-tested without rendering.
 */

/** Number of options at/above which a multiselect switches to the searchable UI. */
export const SEARCHABLE_MULTISELECT_MIN_OPTIONS = 8

/** Fold an option into a single lower-cased haystack (value + label + description). */
export function optionSearchText(opt: ConfigOption): string {
  const parts: readonly (string | undefined)[] = [opt.value, opt.label, opt.description]
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
    .toLowerCase()
}

/**
 * Filter options by a free-text query. An empty / whitespace-only query
 * returns every option (identity, preserving order). A multi-token query
 * requires EVERY token to match (AND) so "hall cam" narrows past either
 * word alone.
 */
export function filterOptions(
  options: readonly ConfigOption[],
  query: string,
): readonly ConfigOption[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return options
  return options.filter((opt) => {
    const hay = optionSearchText(opt)
    return tokens.every((t) => hay.includes(t))
  })
}

/**
 * Split options into the currently-selected set (in the SELECTION order,
 * so chips stay stable while the user searches) and the rest. Selected
 * values with no matching option are surfaced as synthetic options whose
 * label falls back to the raw value — a stale id still shows as a
 * removable chip rather than silently vanishing.
 */
export function partitionSelected(
  options: readonly ConfigOption[],
  selected: readonly string[],
): {
  readonly selectedOptions: readonly ConfigOption[]
  readonly unselected: readonly ConfigOption[]
} {
  const byValue = new Map(options.map((o) => [o.value, o]))
  const selectedSet = new Set(selected)
  const selectedOptions = selected.map(
    (v): ConfigOption => byValue.get(v) ?? { value: v, label: v },
  )
  const unselected = options.filter((o) => !selectedSet.has(o.value))
  return { selectedOptions, unselected }
}

/**
 * Does this field warrant the searchable UI? True for a `multiselect`
 * whose option count reaches the threshold — small sets keep the compact
 * flat-chip toggle rendered by the shared ui-library field.
 */
export function shouldUseSearchableMultiSelect(optionCount: number): boolean {
  return optionCount >= SEARCHABLE_MULTISELECT_MIN_OPTIONS
}
