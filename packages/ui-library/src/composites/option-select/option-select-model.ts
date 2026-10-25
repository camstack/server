/**
 * Pure filter/partition helpers for OptionSelect.
 *
 * Search is a case-insensitive substring match folded over each option's
 * `value`, `label`, and `description`. Multi-token queries require every
 * token to match (AND).
 */

export type OptionSelectOption = {
  value: string
  label: string
  description?: string
  iconUrl?: string
  iconId?: string
  disabled?: boolean
  badge?: string
}

/** Number of options at/above which search is enabled by default (unless creatable). */
export const OPTION_SELECT_SEARCH_MIN_OPTIONS = 8

/** Fold an option into a single lower-cased haystack (value + label + description). */
export function optionSearchText(opt: OptionSelectOption): string {
  const parts: readonly (string | undefined)[] = [opt.value, opt.label, opt.description]
  return parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
    .toLowerCase()
}

/**
 * Filter options by a free-text query. An empty / whitespace-only query
 * returns every option (identity, preserving order).
 */
export function filterOptions(
  options: readonly OptionSelectOption[],
  query: string,
): readonly OptionSelectOption[] {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return options
  return options.filter((opt) => {
    const hay = optionSearchText(opt)
    return tokens.every((t) => hay.includes(t))
  })
}

/**
 * Split options into the currently-selected set (in selection order) and the
 * rest. Selected values with no matching option are surfaced as synthetic
 * options whose label falls back to the raw value.
 */
export function partitionSelected(
  options: readonly OptionSelectOption[],
  selected: readonly string[],
): {
  readonly selectedOptions: readonly OptionSelectOption[]
  readonly unselected: readonly OptionSelectOption[]
} {
  const byValue = new Map(options.map((o) => [o.value, o]))
  const selectedSet = new Set(selected)
  const selectedOptions = selected.map(
    (v): OptionSelectOption => byValue.get(v) ?? { value: v, label: v },
  )
  const unselected = options.filter((o) => !selectedSet.has(o.value))
  return { selectedOptions, unselected }
}

export function resolveSearchable(
  optionCount: number,
  creatable: boolean,
  searchable: boolean | undefined,
): boolean {
  if (searchable !== undefined) return searchable
  return optionCount >= OPTION_SELECT_SEARCH_MIN_OPTIONS || creatable
}

/** Trimmed non-empty draft from the search box, or null when absent. */
export function draftFromQuery(query: string): string | null {
  const trimmed = query.trim()
  return trimmed.length > 0 ? trimmed : null
}

/**
 * True when an existing catalog option already represents this draft (value or
 * label, case-insensitive). Used to hide the “Use «query»” row when redundant.
 */
export function catalogHasDraft(options: readonly OptionSelectOption[], draft: string): boolean {
  const lower = draft.toLowerCase()
  return options.some((o) => o.value.toLowerCase() === lower || o.label.toLowerCase() === lower)
}

/**
 * Show the footer “Add new…” action only when creatable AND the caller
 * provided `onCreateRequest` (e.g. open a dedicated create dialog).
 *
 * Without that hook the footer was a no-op (it only focused the search box),
 * which read as “Add new is broken”. Free-form create already works via the
 * “Use «query»” row once the operator types — no footer needed.
 */
export function shouldShowAddNewFooter(creatable: boolean, hasCreateRequest: boolean): boolean {
  return creatable && hasCreateRequest
}

/**
 * Show the “Use «query»” commit row: creatable, a non-empty draft, and no
 * catalog option that already matches the draft.
 */
export function shouldShowUseQueryRow(
  creatable: boolean,
  query: string,
  options: readonly OptionSelectOption[],
): boolean {
  if (!creatable) return false
  const draft = draftFromQuery(query)
  if (draft === null) return false
  return !catalogHasDraft(options, draft)
}
