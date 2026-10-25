/**
 * The controls of one table's filter: a search box and the facet chips.
 *
 * Controlled — the state comes from `useDataTableFilter` and goes back through
 * the two callbacks; this component owns nothing, so it can sit above a
 * `DataTable`, a card's list, or anything else that renders the filtered rows.
 *
 * Every visible string is a prop: this library carries no translations, and
 * the caller's i18n does.
 */
import { Search, X } from 'lucide-react'
import type { JSX } from 'react'
import { MultiSelectDropdown } from './device-list/multi-select'
import {
  isDataTableFilterActive,
  type DataTableFacet,
  type DataTableFilterState,
} from './data-table-filter'

/** One facet group as the bar draws it. */
export interface DataTableFilterBarGroup {
  readonly id: string
  /** Visible caption AND the chip group's accessible name ("Status"). */
  readonly label: string
  readonly facets: readonly DataTableFacet[]
  readonly selected: readonly string[]
  /** Render a chip's caption. Default: the raw value. */
  readonly facetLabel?: (value: string) => string
  /**
   * `chips` (default): one pressable chip per value, inline. `menu`: ONE
   * chip-sized trigger ("Owner · 2") that opens a checklist — for a group
   * with many values or a bar with many groups, so the bar stays one row.
   */
  readonly display?: 'chips' | 'menu'
}

export interface DataTableFilterBarLabels {
  /** Placeholder of the search box. */
  readonly searchPlaceholder: string
  /** Accessible name of the search box — say WHICH table, two of them on one
   *  page are otherwise indistinguishable to a screen reader. */
  readonly searchLabel: string
  /** Accessible name of the chip group. */
  readonly facetsLabel: string
  /** The clear-filters button. */
  readonly clearLabel: string
}

export interface DataTableFilterBarProps {
  readonly state: DataTableFilterState
  readonly facets: readonly DataTableFacet[]
  readonly labels: DataTableFilterBarLabels
  readonly onSearch: (search: string) => void
  readonly onToggleFacet: (value: string) => void
  readonly onClear: () => void
  /** Render a chip's caption. Default: the raw value. */
  readonly facetLabel?: (value: string) => string
  /** Further chip rows (status, owner, kind…), each its own group. */
  readonly groups?: readonly DataTableFilterBarGroup[]
  readonly onToggleGroupFacet?: (groupId: string, value: string) => void
}

const CHIP_ON =
  'rounded-full border border-primary bg-primary/10 px-2 py-0.5 text-[10px] text-foreground'
const CHIP_OFF =
  'rounded-full border border-border px-2 py-0.5 text-[10px] text-foreground-muted hover:bg-surface-hover'

export function DataTableFilterBar({
  state,
  facets,
  labels,
  onSearch,
  onToggleFacet,
  onClear,
  facetLabel,
  groups = [],
  onToggleGroupFacet,
}: DataTableFilterBarProps): JSX.Element {
  const active = isDataTableFilterActive(state)
  // One chip is a filter with one answer: the row set itself. Draw the group
  // only when it can narrow anything.
  const showFacets = facets.length > 1
  return (
    <div className="flex flex-wrap items-center gap-2">
      <label className="relative min-w-[12rem] flex-1">
        <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle" />
        <input
          type="search"
          value={state.search}
          onChange={(e) => onSearch(e.target.value)}
          placeholder={labels.searchPlaceholder}
          aria-label={labels.searchLabel}
          className="w-full rounded border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground"
        />
      </label>
      {showFacets && (
        <div role="group" aria-label={labels.facetsLabel} className="flex flex-wrap gap-1">
          {facets.map((facet) => {
            const pressed = state.facets.includes(facet.value)
            return (
              <button
                key={facet.value}
                type="button"
                onClick={() => onToggleFacet(facet.value)}
                aria-pressed={pressed}
                className={pressed ? CHIP_ON : CHIP_OFF}
              >
                {facetLabel ? facetLabel(facet.value) : facet.value}{' '}
                <span className="text-foreground-subtle tabular-nums">{facet.count}</span>
              </button>
            )
          })}
        </div>
      )}
      {groups
        .filter((group) => group.facets.length > 1)
        .map((group) =>
          group.display === 'menu' ? (
            <MultiSelectDropdown
              key={group.id}
              label={group.label}
              options={group.facets.map((facet) => ({
                id: facet.value,
                label: `${group.facetLabel ? group.facetLabel(facet.value) : facet.value} (${String(facet.count)})`,
              }))}
              selected={group.selected}
              onChange={(next) => {
                const chosen = new Set(next)
                for (const facet of group.facets) {
                  if (chosen.has(facet.value) !== group.selected.includes(facet.value)) {
                    onToggleGroupFacet?.(group.id, facet.value)
                  }
                }
              }}
            />
          ) : (
            <div
              key={group.id}
              role="group"
              aria-label={group.label}
              className="flex flex-wrap items-center gap-1"
            >
              <span
                aria-hidden
                className="text-[10px] uppercase tracking-wide text-foreground-subtle"
              >
                {group.label}
              </span>
              {group.facets.map((facet) => {
                const pressed = group.selected.includes(facet.value)
                return (
                  <button
                    key={facet.value}
                    type="button"
                    onClick={() => onToggleGroupFacet?.(group.id, facet.value)}
                    aria-pressed={pressed}
                    className={pressed ? CHIP_ON : CHIP_OFF}
                  >
                    {group.facetLabel ? group.facetLabel(facet.value) : facet.value}{' '}
                    <span className="text-foreground-subtle tabular-nums">{facet.count}</span>
                  </button>
                )
              })}
            </div>
          ),
        )}
      {active && (
        <button
          type="button"
          onClick={onClear}
          className="flex items-center gap-1 text-[11px] text-foreground-subtle hover:text-foreground"
        >
          <X className="h-3 w-3" />
          {labels.clearLabel}
        </button>
      )}
    </div>
  )
}
