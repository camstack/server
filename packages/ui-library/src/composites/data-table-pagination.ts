/**
 * Client-side pagination for {@link DataTable} — pure, no React.
 *
 * The table sorts first and pages second, so page 1 always holds the first
 * rows of the CURRENT order. A page past the end (the rows shrank under it:
 * a filter narrowed, a revoke removed rows) clamps to the last page instead
 * of rendering an empty table with a pager that says "page 4 of 2".
 */

export interface DataTablePage<T> {
  readonly pageRows: readonly T[]
  /** 0-based page actually shown (after clamping). */
  readonly page: number
  /** At least 1 — an empty table is one empty page. */
  readonly pageCount: number
  /** 1-based index of the first row shown; 0 when there are none. */
  readonly from: number
  /** 1-based index of the last row shown; 0 when there are none. */
  readonly to: number
  readonly total: number
}

export function paginateRows<T>(
  rows: readonly T[],
  page: number,
  pageSize: number,
): DataTablePage<T> {
  const size = Math.max(1, Math.floor(pageSize))
  const total = rows.length
  const pageCount = Math.max(1, Math.ceil(total / size))
  const clamped = Math.min(Math.max(0, Math.floor(page)), pageCount - 1)
  const start = clamped * size
  const pageRows = rows.slice(start, start + size)
  return {
    pageRows,
    page: clamped,
    pageCount,
    from: pageRows.length === 0 ? 0 : start + 1,
    to: start + pageRows.length,
    total,
  }
}

/** Every visible string of the pager — this library carries no translations. */
export interface DataTablePaginationLabels {
  /** Accessible name of the pager's `<nav>` — say WHICH table. */
  readonly navLabel: string
  readonly previous: string
  readonly next: string
  /** "1–25 of 167". Arguments are 1-based; `from`/`to` are 0 for no rows. */
  readonly range: (from: number, to: number, total: number) => string
}

// i18n-ignore-start: English defaults of the host-supplied labels contract (see the interface above)
export const DEFAULT_PAGINATION_LABELS: DataTablePaginationLabels = {
  navLabel: 'Table pages',
  previous: 'Previous page',
  next: 'Next page',
  range: (from, to, total) => `${from}–${to} of ${total}`,
}
// i18n-ignore-end
