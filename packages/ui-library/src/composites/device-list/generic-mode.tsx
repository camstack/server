import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Search, type LucideIcon } from 'lucide-react'
import { useSearchFieldHotkey } from '../../hotkeys/use-search-field-hotkey'
import { useUiText } from '../../contexts/ui-text'
import { type MultiSelectOption } from './multi-select'
import { ResponsiveTypeFilter } from './type-filter'
import { useDebouncedString } from '../../hooks/use-debounced-string'
import { fuzzyMatch } from './fuzzy-match'
import { Pagination } from './pagination'
import { PageSizeSelect } from './page-size-select'
import { effectivePageSize, usePersistedPageSize } from '../../hooks/use-persisted-page-size'

/**
 * Generic-mode props — a paginated, searchable, render-prop list that reuses
 * the same chrome (search box + <Pagination>) as the device list but over an
 * arbitrary item type. Used by the HA adoption modal for discovered-device
 * candidates; selection + per-row controls live in the caller's `renderItem`.
 */
/** One column of the generic-mode TABLE rendering. */
export interface DeviceListColumn<T> {
  readonly key: string
  readonly header: ReactNode
  readonly cell: (item: T) => ReactNode
  /** Extra classes on the `<th>` (width, responsive hiding, alignment). */
  readonly headerClassName?: string
  /** Extra classes on the `<td>`. */
  readonly cellClassName?: string
}

export interface GenericPageSizeSelector {
  readonly options: readonly number[]
  readonly defaultSize: number
  readonly storageKey: string | null
}

const FIXED_PAGE_SIZE = 100

export interface DeviceListGenericProps<T> {
  readonly mode: 'generic'
  readonly items: readonly T[]
  readonly getKey: (item: T) => string
  readonly getSearchText: (item: T) => string
  /**
   * Row body. Provide EITHER `columns` (renders a table matching the device
   * list's table styling) OR `renderItem` (a free-form row list). `columns`
   * wins when both are set.
   */
  readonly renderItem?: (item: T) => ReactNode
  /** Table columns — when set, the list renders as a bordered table. */
  readonly columns?: readonly DeviceListColumn<T>[]
  /** Full-width expansion row rendered under an item when `isExpanded` is true. */
  readonly renderExpanded?: (item: T) => ReactNode
  readonly isExpanded?: (item: T) => boolean
  /** Per-row class (table `<tr>` or list wrapper) — e.g. selected/adopted state. */
  readonly rowClassName?: (item: T) => string
  /** Click handler for a whole table row — when set, the `<tr>` becomes a
   *  clickable button (cursor + keyboard) that navigates/opens the item.
   *  Per-cell interactive controls must `stopPropagation` to avoid double-firing. */
  readonly onRowClick?: (item: T) => void
  /**
   * Optional type-filter projection. When provided, the list renders a compact
   * MULTI-SELECT dropdown over the DISTINCT values present in `items` and keeps
   * items matching ANY selected value (empty selection = no filter). Return
   * `null` for items that carry no type. Omit to hide the filter entirely.
   */
  readonly getFilterType?: (item: T) => string | null
  /**
   * Enrich a raw filter value into a display `{ label, icon }` for the
   * multi-select (e.g. via the device-type meta map). Defaults to the raw
   * value as label, no icon. Ignored when `filterOptions` is supplied.
   */
  readonly mapFilterOption?: (value: string) => {
    readonly label: string
    readonly icon?: LucideIcon
  }
  /**
   * Ready-made, COMPLETE option set for the type filter. When supplied, it
   * overrides the present-values-only set the list would otherwise derive from
   * `items` — so e.g. the adoption modal shows every `DeviceType` (via
   * `allDeviceTypeFilterOptions`), not just the types of the current
   * candidates. `getFilterType` still selects each item's value for matching.
   */
  readonly filterOptions?: readonly MultiSelectOption[]
  /** Label for the type multi-select trigger. Default 'Type'. */
  readonly filterLabel?: string
  /**
   * Initial type-filter selection. Empty (default) = no filter. Used once at
   * mount — later changes to this prop are ignored (local state owns it).
   */
  readonly initialTypeFilters?: readonly string[]
  readonly isLoading?: boolean
  readonly searchPlaceholder?: string
  readonly emptyLabel?: string
  /** Fixed rows per page when there is no `pageSizeSelector`. Default 100. */
  readonly pageSize?: number
  /**
   * Let the viewer pick the page size: a "Per page" control under the table,
   * remembered per viewer under `storageKey` (null = not remembered). Options
   * may include `PAGE_SIZE_ALL`. When set, `pageSize` is ignored.
   */
  readonly pageSizeSelector?: GenericPageSizeSelector
  /**
   * Optional control rendered next to the search box (e.g. a Refresh button).
   * A function receives the rows the search and type filter currently leave
   * (every page), for controls that act on "what is shown".
   */
  readonly toolbar?: ReactNode | ((ctx: { readonly filtered: readonly T[] }) => ReactNode)
}

/**
 * Generic render-prop list: search + pagination chrome shared with the device
 * list, over an arbitrary item type. Local (non-URL) state — intended for
 * modal/ephemeral surfaces. Selection + per-row controls are the caller's, via
 * `renderItem`.
 */
export function GenericModeList<T>(props: DeviceListGenericProps<T>): ReactNode {
  const t = useUiText()
  const {
    items,
    getKey,
    getSearchText,
    renderItem,
    getFilterType,
    mapFilterOption,
    filterOptions,
    filterLabel = 'Type',
    initialTypeFilters = [],
    columns,
    renderExpanded,
    isExpanded,
    rowClassName,
    onRowClick,
    isLoading = false,
    searchPlaceholder = 'Search',
    emptyLabel = 'No items found.',
    pageSize: fixedPageSize = FIXED_PAGE_SIZE,
    pageSizeSelector,
    toolbar,
  } = props

  // Always called (hooks may not be conditional); without a selector it is an
  // unremembered single-option state that `fixedPageSize` stands in for.
  const [chosenPageSize, setChosenPageSize] = usePersistedPageSize(
    pageSizeSelector ?? { storageKey: null, options: [fixedPageSize], defaultSize: fixedPageSize },
  )

  const [searchInput, setSearchInput] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  useSearchFieldHotkey(searchRef)
  const debouncedSearch = useDebouncedString(searchInput, 300)
  const [typeFilters, setTypeFilters] = useState<readonly string[]>(() => [...initialTypeFilters])
  const [page, setPage] = useState(1)
  // Reset to page 1 whenever the (debounced) query or type filter changes.
  useEffect(() => {
    setPage(1)
  }, [debouncedSearch, typeFilters])

  // Type-filter options. When the caller supplies a COMPLETE `filterOptions`
  // set (e.g. the exhaustive device-type list), use it verbatim so no type is
  // ever missing. Otherwise fall back to the distinct values present in the
  // item set, enriched with label + icon via `mapFilterOption`.
  const typeOptions = useMemo<readonly MultiSelectOption[]>(() => {
    if (!getFilterType) return []
    if (filterOptions) return filterOptions
    const set = new Set<string>()
    for (const it of items) {
      const t = getFilterType(it)
      if (t !== null && t !== '') set.add(t)
    }
    return [...set].toSorted().map((value) => {
      const meta = mapFilterOption?.(value)
      return {
        id: value,
        label: meta?.label ?? value,
        ...(meta?.icon ? { icon: meta.icon } : {}),
      }
    })
  }, [items, getFilterType, mapFilterOption, filterOptions])

  const typeFilterSet = useMemo(() => new Set(typeFilters), [typeFilters])
  const filtered = useMemo(() => {
    const q = debouncedSearch
    return items.filter((it) => {
      if (typeFilterSet.size > 0 && getFilterType) {
        const t = getFilterType(it)
        if (t === null || !typeFilterSet.has(t)) return false
      }
      if (q.trim() !== '' && !fuzzyMatch(q, getSearchText(it))) return false
      return true
    })
  }, [items, debouncedSearch, getSearchText, typeFilterSet, getFilterType])

  const totalItems = filtered.length
  const pageSize = pageSizeSelector ? effectivePageSize(chosenPageSize, totalItems) : fixedPageSize
  const totalPages = Math.max(1, Math.ceil(totalItems / pageSize))
  const safePage = Math.min(page, totalPages)
  const startIdx = (safePage - 1) * pageSize
  const pageRows = filtered.slice(startIdx, startIdx + pageSize)
  useEffect(() => {
    if (safePage !== page) setPage(safePage)
  }, [safePage, page])

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div className="flex items-center justify-between gap-3 flex-wrap shrink-0">
        {getFilterType && typeOptions.length > 0 ? (
          <ResponsiveTypeFilter
            label={filterLabel}
            options={typeOptions}
            selected={typeFilters}
            onChange={setTypeFilters}
          />
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-foreground-subtle pointer-events-none" />
            <input
              ref={searchRef}
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="h-7 pl-7 pr-2.5 rounded-md border border-border bg-surface text-[11px] text-foreground placeholder:text-foreground-subtle/60 focus:outline-none focus:ring-1 focus:ring-primary/40 w-56"
            />
          </div>
          {typeof toolbar === 'function' ? toolbar({ filtered }) : toolbar}
        </div>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {isLoading && totalItems === 0 ? (
          <div className="flex items-center justify-center py-12 text-xs text-foreground-subtle">
            {t('uiLibrary.genericModeList.loading', 'Loading…')}
          </div>
        ) : totalItems === 0 ? (
          <div className="flex items-center justify-center py-12 text-xs text-foreground-subtle">
            {emptyLabel}
          </div>
        ) : columns ? (
          // Table rendering — same bordered/header styling as the device list's
          // TableLayout, so adoption candidates / export rows match the Devices
          // page visually. Columns + optional per-row expansion are configurable.
          <div className="rounded-lg border border-border bg-surface overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr className="border-b border-border">
                  {columns.map((col) => (
                    <th
                      key={col.key}
                      className={`text-left px-2 py-2 text-[9.5px] font-medium uppercase tracking-wider text-foreground-subtle ${col.headerClassName ?? ''}`}
                    >
                      {col.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {pageRows.map((it) => (
                  <Fragment key={getKey(it)}>
                    <tr
                      className={`border-b border-border/60 ${onRowClick ? 'cursor-pointer hover:bg-surface-hover transition-colors' : ''} ${rowClassName?.(it) ?? ''}`}
                      {...(onRowClick
                        ? {
                            onClick: () => onRowClick(it),
                            role: 'button' as const,
                            tabIndex: 0,
                            onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
                              if (e.key === 'Enter' || e.key === ' ') {
                                e.preventDefault()
                                onRowClick(it)
                              }
                            },
                          }
                        : {})}
                    >
                      {columns.map((col) => (
                        <td
                          key={col.key}
                          className={`px-2 py-2 align-middle ${col.cellClassName ?? ''}`}
                        >
                          {col.cell(it)}
                        </td>
                      ))}
                    </tr>
                    {renderExpanded && isExpanded?.(it) && (
                      <tr className="border-b border-border/60 bg-surface/40">
                        <td colSpan={columns.length} className="px-2 pb-2 pt-0">
                          {renderExpanded(it)}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="space-y-1.5">
            {pageRows.map((it) => (
              <Fragment key={getKey(it)}>{renderItem?.(it)}</Fragment>
            ))}
          </div>
        )}
      </div>

      <div className="shrink-0">
        {pageSizeSelector && totalItems > 0 ? (
          // Same footer as the device table: the size control, the count when
          // everything fits on one page (the pager carries it otherwise), and
          // the pager. The control stays visible on a single page so a smaller
          // size can still be chosen.
          <div className="flex items-center justify-between gap-4 flex-wrap pt-2 text-[11px] text-foreground-subtle">
            <div className="inline-flex items-center gap-2">
              {totalItems <= pageSize && (
                <span>
                  {t('uiLibrary.genericModeList.total', '{{count}} total', { count: totalItems })}
                </span>
              )}
              <PageSizeSelect
                ariaLabel={t('uiLibrary.genericModeList.rowsPerPage', 'Rows per page')}
                value={chosenPageSize}
                options={pageSizeSelector.options}
                onChange={setChosenPageSize}
              />
            </div>
            <Pagination
              currentPage={safePage}
              totalItems={totalItems}
              pageSize={pageSize}
              onPageChange={setPage}
            />
          </div>
        ) : (
          <Pagination
            currentPage={safePage}
            totalItems={totalItems}
            pageSize={pageSize}
            onPageChange={setPage}
          />
        )}
      </div>
    </div>
  )
}
