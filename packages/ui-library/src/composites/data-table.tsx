/**
 * DataTable — shared responsive table for admin pages.
 *
 * Recipes baked in:
 *   - `overflow-x-auto` wrapper so narrow viewports don't clip the
 *     right edge (the rounded border survives the scroll).
 *   - `min-w-[Npx]` on the inner table so columns don't squash below
 *     readable width before the scroll kicks in.
 *   - `whitespace-nowrap` on headers — column titles never wrap to
 *     two lines (`AUTO-KILL` was the regression that triggered this).
 *   - Themed `bg-surface` + `border-border` so contrast works in both
 *     light and dark themes.
 *
 * Column model: caller supplies `columns: DataColumn<T>[]` and
 * `rows: T[]`. Each column declares `header`, optional `align`,
 * optional `nowrap`, and a `render(row) => ReactNode` that produces
 * the cell content.
 *
 *   <DataTable
 *     columns={[
 *       { key: 'username', header: 'Username', render: (u) => u.username },
 *       { key: 'role',     header: 'Role',     render: (u) => <RoleBadge .../> },
 *       { key: 'actions',  header: '',         align: 'right', render: (u) => <Actions .../> },
 *     ]}
 *     rows={users}
 *     minWidthPx={560}
 *   />
 *
 * If finer header markup is needed, pass `headerRender` instead of
 * `header` (e.g. for a sortable click affordance).
 *
 * ── Narrow viewports ──────────────────────────────────────────────────────
 * The table stays a table. The wrapper is `overflow-x-auto`, so a phone
 * scrolls the columns sideways INSIDE the table — the page body never moves
 * sideways, and the cells stay one line (`whitespace-nowrap`). That is the
 * only rendering — there is no card list and no per-table switch.
 *
 * ── Scrolling the BODY, not the page ──────────────────────────────────────
 * `maxBodyHeight` caps the table and scrolls its rows INSIDE the container
 * with the column header pinned. It is ONE prop, not two, because "this list
 * scrolls internally" and "its header stays visible" are the same decision: a
 * capped table whose header scrolls away is a list of unlabelled cells.
 *
 * Use it wherever the row count is open-ended (rules, targets, delivery
 * history) so the page keeps its own header, filters and actions in view while
 * the operator moves through the rows.
 */
import { Fragment, type JSX, type ReactNode, useMemo, useState } from 'react'
import { DataTablePager } from './data-table-pager'
import {
  type DataTablePaginationLabels,
  DEFAULT_PAGINATION_LABELS,
  paginateRows,
} from './data-table-pagination'
import { type DataTableSelection, selectionColumn } from './data-table-selection'
import { SortHeaderButton } from './sort-header-button'
import {
  ariaSortForColumn,
  nextTableSort,
  sortRowsByColumn,
  type TableSortState,
  type TableSortValue,
} from './table-sort'

export interface DataColumn<T> {
  /** Stable key for React reconciliation + tests. */
  readonly key: string
  /** Plain text header. Mutually exclusive with `headerRender`. */
  readonly header?: string
  /** Custom header markup — overrides `header`. */
  readonly headerRender?: () => ReactNode
  /** Cell horizontal alignment. Default: `left`. */
  readonly align?: 'left' | 'right' | 'center'
  /** Suppress text wrapping on header + cell. Default: `true` — a cell that
   *  wraps is a row that has already lost its table. Pass `false` only for a
   *  column whose value is meant to wrap (a description, a blob). */
  readonly nowrap?: boolean
  /** Cell renderer. Receives the row value. */
  readonly render: (row: T, rowIndex: number) => ReactNode
  /** Optional explicit Tailwind width class (e.g. `'w-24'`). */
  readonly width?: string
  /**
   * Opt this column into column sorting. Return the row's value for THIS
   * column: a number for numeric columns (never a formatted string — "100"
   * sorts before "9"), a string for text, and `null` when the row has no
   * value, which always sorts last in both directions.
   *
   * Called once per row per comparison, so read a field; do not format.
   *
   * Omitting it is the correct answer for a composite cell (a list, an argv
   * blob, an interactive control): see {@link DataColumn.notSortableReason}.
   */
  readonly sortValue?: (row: T) => TableSortValue
  /**
   * Why this column has NO sort. Rendered as the header's `title` so the
   * reason reaches the operator who wonders why one header clicks and the
   * next does not.
   *
   * Only meaningful together with an absent `sortValue`. A column that cannot
   * be ordered in a way that MEANS something must say so rather than offer an
   * ordering that looks authoritative and is not.
   */
  readonly notSortableReason?: string
}

export interface DataTableProps<T> {
  readonly columns: readonly DataColumn<T>[]
  readonly rows: readonly T[]
  /** Stable key per row. Default: rowIndex (works for stable lists). */
  readonly rowKey?: (row: T, rowIndex: number) => string | number
  /** Click handler attached to each row. Adds hover + cursor-pointer. */
  readonly onRowClick?: (row: T, rowIndex: number) => void
  /** Min width in px for the inner table. Default: 480. */
  readonly minWidthPx?: number
  /** Empty-state message. Default: hides the table when rows=[]. */
  readonly emptyMessage?: string
  /** Additional className for the outer container. */
  readonly className?: string
  /** Wrapper border style — set false to drop the rounded border (e.g. when the
   *  table sits inside another bordered card). Default: `true`. */
  readonly bordered?: boolean
  /** Per-row className resolver (e.g. status-coloured backgrounds). */
  readonly rowClassName?: (row: T, rowIndex: number) => string | undefined
  /**
   * Tailwind `max-h-*` class capping the table. The rows then scroll INSIDE
   * this container and the column header is pinned to its top; the page around
   * it does not move. Absent (default) = the table is as tall as its rows and
   * the page scrolls. Use {@link TABLE_SCROLL_MAX_H} unless a surface has a
   * reason of its own. Ignored when {@link fill} is true.
   */
  readonly maxBodyHeight?: string
  /**
   * Grow into the parent flex column (`h-full min-h-0`) and scroll rows inside.
   * Use on managed-list section bodies under a `PageShell` / `SectionedPage`
   * with `fill` (parent must own the viewport height).
   */
  readonly fill?: boolean
  /**
   * Column sort the table opens with, e.g. `{ columnKey: 'cpu', dir: 'desc' }`.
   * Must name a column that declares `sortValue`; a key that names no sortable
   * column simply leaves the table in its incoming order.
   *
   * The state is owned INSIDE the table from here on — a header click moves it
   * none → asc → desc → none. Pass this only to choose the opening order, not
   * to drive the table from outside — that is {@link DataTableProps.sort}.
   */
  readonly defaultSort?: TableSortState
  /**
   * CONTROLLED sort. Present (even `null`) = the owner holds the state: the
   * table renders exactly this order and reports header clicks through
   * `onSortChange` without moving on its own. Use it when the order must
   * survive a remount or live in the URL. Absent = uncontrolled
   * (`defaultSort`).
   */
  readonly sort?: TableSortState | null
  /** Every header click, with the next state (none → asc → desc → none). */
  readonly onSortChange?: (next: TableSortState | null) => void
  /**
   * Client-side pagination: show this many rows per page with a pager under
   * the table. Sorting happens first, so page 1 holds the first rows of the
   * current order. Absent = every row, no pager. The pager is drawn only when
   * the rows do not fit on one page.
   */
  readonly pageSize?: number
  /** CONTROLLED 0-based page (with `onPageChange`). Absent = the table owns it. */
  readonly page?: number
  readonly onPageChange?: (page: number) => void
  /** The pager's strings. Default: English. */
  readonly paginationLabels?: DataTablePaginationLabels
  /**
   * Row selection — a leading checkbox column (see `data-table-selection`).
   * Needs `rowKey`: keys are what the caller's bulk action acts on.
   */
  readonly selection?: DataTableSelection<T>
  /**
   * Inline row detail: rendered in its own full-width row DIRECTLY UNDER the
   * row for which `isExpanded` is true, so it stays attached to that row under
   * sorting and paging. The caller owns the open state and the toggle control
   * (a column cell). Never render the detail after the table — it would sit
   * below every row.
   */
  readonly renderExpanded?: (row: T, rowIndex: number) => ReactNode
  readonly isExpanded?: (row: T) => boolean
}

/**
 * The default cap for an internally-scrolling table.
 *
 * `60vh` leaves the page header, its filters and its actions on screen at
 * every viewport while still showing ~10 rows — and it is a fraction, so it
 * does not need a breakpoint of its own.
 */
export const TABLE_SCROLL_MAX_H = 'max-h-[60vh]' as const

const ALIGN_CLASS: Record<NonNullable<DataColumn<unknown>['align']>, string> = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  minWidthPx = 480,
  emptyMessage,
  className,
  bordered = true,
  rowClassName,
  maxBodyHeight,
  fill = false,
  defaultSort,
  sort: sortProp,
  onSortChange,
  pageSize,
  page: pageProp,
  onPageChange,
  paginationLabels = DEFAULT_PAGINATION_LABELS,
  selection,
  renderExpanded,
  isExpanded,
}: DataTableProps<T>): JSX.Element | null {
  const [innerSort, setInnerSort] = useState<TableSortState | null>(defaultSort ?? null)
  const [innerPage, setInnerPage] = useState(0)
  const sort = sortProp !== undefined ? sortProp : innerSort
  const changeSort = (next: TableSortState | null): void => {
    if (sortProp === undefined) setInnerSort(next)
    onSortChange?.(next)
  }
  const changePage = (next: number): void => {
    if (pageProp === undefined) setInnerPage(next)
    onPageChange?.(next)
  }
  const scrolls = fill || maxBodyHeight !== undefined
  const heightClass = fill ? 'h-full min-h-0' : (maxBodyHeight ?? '')

  // Resolve the sorted column BEFORE sorting: a sort state naming a column
  // that does not exist, or that carries no `sortValue`, must leave the rows
  // exactly as they came in rather than silently order them by something else.
  const sortedColumn = useMemo(
    () =>
      sort === null
        ? undefined
        : columns.find((col) => col.key === sort.columnKey && col.sortValue !== undefined),
    [columns, sort],
  )
  const sortValue = sortedColumn?.sortValue
  const displayRows = useMemo(
    () => (sortValue === undefined ? rows : sortRowsByColumn(rows, sort, sortValue)),
    [rows, sort, sortValue],
  )
  // The sort the HEADER reflects: `null` whenever the state names nothing
  // sortable, so no chevron ever points at a column the rows are not ordered by.
  const activeSort = sortedColumn === undefined ? null : sort

  const paged =
    pageSize === undefined ? null : paginateRows(displayRows, pageProp ?? innerPage, pageSize)
  const pageRows = paged === null ? displayRows : paged.pageRows
  const pager =
    paged !== null && paged.pageCount > 1 ? (
      <DataTablePager page={paged} labels={paginationLabels} onPageChange={changePage} />
    ) : null

  const keyOf = (row: T): string =>
    String(rowKey ? rowKey(row, rows.indexOf(row)) : rows.indexOf(row))
  const shownColumns: readonly DataColumn<T>[] =
    selection === undefined ? columns : [selectionColumn(selection, pageRows, keyOf), ...columns]

  if (rows.length === 0 && emptyMessage) {
    return (
      <div
        className={`rounded-lg ${bordered ? 'border border-border' : ''} bg-surface px-3 py-4 text-xs text-foreground-subtle text-center ${className ?? ''}`}
      >
        {emptyMessage}
      </div>
    )
  }
  if (rows.length === 0) return null

  const wrapperCls = [
    'rounded-lg',
    bordered ? 'border border-border' : '',
    'bg-surface overflow-x-auto',
    scrolls ? `${heightClass} overflow-y-auto` : '',
    fill ? 'min-h-0 flex-1' : '',
    !fill && pager === null ? (className ?? '') : '',
  ]
    .filter(Boolean)
    .join(' ')

  const table = (
    <div className={wrapperCls}>
      <table
        // `border-separate border-spacing-0` ONLY while the header is pinned.
        // Tailwind's preflight makes every table `border-collapse: collapse`,
        // and a collapsed table hands its cell borders to the table itself —
        // so a `sticky` header keeps its background but loses the rule under
        // it the moment the first row slides beneath. Separated borders with
        // zero spacing render identically (each cell still draws its own
        // bottom rule, and they abut) and belong to the cell, so the pinned
        // header keeps its underline. Left alone when nothing is pinned:
        // collapse is what every other table in the app already renders as.
        className={`w-full text-xs ${scrolls ? 'border-separate border-spacing-0' : ''}`}
        style={{ minWidth: `${minWidthPx}px` }}
      >
        <thead className="bg-surface">
          <tr>
            {shownColumns.map((col) => {
              const align = col.align ?? 'left'
              const nowrap = col.nowrap ?? true
              const sortable = col.sortValue !== undefined
              const isSorted = activeSort !== null && activeSort.columnKey === col.key
              return (
                <th
                  key={col.key}
                  // `aria-sort` belongs to the `<th>`, never to the inner
                  // button — WAI-ARIA scopes it to the cell.
                  aria-sort={sortable ? ariaSortForColumn(activeSort, col.key) : undefined}
                  title={sortable ? undefined : col.notSortableReason}
                  className={[
                    'px-3 py-2 text-foreground-subtle font-medium bg-surface border-b border-border',
                    // Pinned to the SCROLLER, which is the wrapper above — the
                    // one element that actually scrolls. `sticky` on the `th`
                    // rather than on the `thead` because that is what works
                    // under both border models and in every engine we ship to.
                    scrolls ? 'sticky top-0 z-10' : '',
                    ALIGN_CLASS[align],
                    nowrap ? 'whitespace-nowrap' : '',
                    col.width ?? '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {sortable ? (
                    <SortHeaderButton
                      label={col.headerRender ? col.headerRender() : col.header}
                      active={isSorted}
                      dir={isSorted && activeSort !== null ? activeSort.dir : 'asc'}
                      onSort={() => changeSort(nextTableSort(sort, col.key))}
                    />
                  ) : col.headerRender ? (
                    col.headerRender()
                  ) : (
                    col.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody>
          {pageRows.map((row, rowIndex) => {
            const key = rowKey ? rowKey(row, rowIndex) : rowIndex
            const extra = rowClassName?.(row, rowIndex) ?? ''
            const interactive = onRowClick !== undefined
            const detail =
              renderExpanded !== undefined && isExpanded?.(row) === true
                ? renderExpanded(row, rowIndex)
                : null
            return (
              <Fragment key={key}>
                <tr
                  onClick={interactive ? () => onRowClick(row, rowIndex) : undefined}
                  className={[
                    interactive ? 'cursor-pointer hover:bg-primary/5' : 'hover:bg-primary/5',
                    extra,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                >
                  {shownColumns.map((col) => {
                    const align = col.align ?? 'left'
                    const nowrap = col.nowrap ?? true
                    return (
                      <td
                        key={col.key}
                        data-cell={col.key}
                        className={[
                          'px-3 py-2 text-foreground border-b border-border',
                          ALIGN_CLASS[align],
                          nowrap ? 'whitespace-nowrap' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        {col.render(row, rowIndex)}
                      </td>
                    )
                  })}
                </tr>
                {detail !== null && (
                  <tr data-expanded-row="" className="bg-surface">
                    <td colSpan={shownColumns.length} className="border-b border-border px-3 py-2">
                      {detail}
                    </td>
                  </tr>
                )}
              </Fragment>
            )
          })}
        </tbody>
      </table>
    </div>
  )
  if (pager === null) {
    if (fill) {
      return <div className={`flex min-h-0 flex-1 flex-col ${className ?? ''}`}>{table}</div>
    }
    return table
  }
  return (
    <div className={fill ? `flex min-h-0 flex-1 flex-col ${className ?? ''}` : className}>
      {table}
      {pager}
    </div>
  )
}
