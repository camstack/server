/**
 * Column sorting for {@link DataTable} — the ONE sort model in this library.
 *
 * The device list had the only column sort in the app
 * (`composites/device-list/sort.ts`), typed to `DeviceItemDevice` and to three
 * hard-coded column ids. Every other table in the admin UI was unsorted. This
 * module is that same behaviour, generic: `DataTable` owns the state, a column
 * opts in by declaring `sortValue`, and `device-list` keeps its domain
 * comparators while delegating the toggle here. There is no second sort.
 *
 * The three rules are inherited verbatim from the device list, because they
 * were argued there and they are the reason a sorted table stays readable:
 *
 *  1. **`null` sorts LAST in both directions.** A missing value is "unknown",
 *     not a value to reverse. Flipping the direction must never promote the
 *     rows that have nothing to say to the top.
 *  2. **Stable.** `Array.prototype.toSorted` is stable in every runtime we
 *     ship to, so rows with an equal key keep the order they arrived in —
 *     which is usually a meaningful order already (topology order, insertion
 *     order).
 *  3. **Immutable.** The input array is never touched; a `null` sort returns a
 *     fresh copy in the incoming order.
 *
 * A column with no `sortValue` renders a plain static header and can never be
 * clicked. That is deliberate and it is the point of `notSortableReason`: a
 * composite cell (a list of capabilities, an argv blob, an interactive
 * control) has no single value to order by, and inventing one — "by count",
 * "alphabetically by full path" — produces an ordering that looks
 * authoritative and means nothing.
 */

/** Sort direction. There is no third state on the column; "unsorted" is the
 *  absence of a {@link TableSortState}. */
export type TableSortDirection = 'asc' | 'desc'

/** The table's single active sort. `null` at the table level = incoming order. */
export interface TableSortState {
  /** `DataColumn.key` of the sorted column. */
  readonly columnKey: string
  readonly dir: TableSortDirection
}

/**
 * What a sortable column contributes for one row.
 *
 * `null` means "this row has no value for this column" and always sorts last
 * (rule 1). It is NOT the same as `0` or `''`, which are values and sort
 * normally.
 */
export type TableSortValue = string | number | null

/**
 * The toggle rule, and the only copy of it.
 *
 * none → asc → desc → none, and a click on a DIFFERENT column starts that
 * column fresh at `asc`. `sameColumn` says whether the clicked column is the
 * one currently sorted; `currentDir` is its direction (`null` when nothing is
 * sorted). Returns the next direction, or `null` for "unsorted".
 *
 * Split out from {@link nextTableSort} so the device list — whose sort state
 * keys columns by `columnId`, not `columnKey` — can reuse the rule without a
 * cast and without a second copy of it.
 */
export function nextSortDirection(
  sameColumn: boolean,
  currentDir: TableSortDirection | null,
): TableSortDirection | null {
  if (!sameColumn || currentDir === null) return 'asc'
  return currentDir === 'asc' ? 'desc' : null
}

/**
 * Toggle a column's sort on header click: none → asc → desc → none.
 * Clicking a DIFFERENT column starts it fresh at `asc`.
 */
export function nextTableSort(
  current: TableSortState | null,
  columnKey: string,
): TableSortState | null {
  const sameColumn = current !== null && current.columnKey === columnKey
  const dir = nextSortDirection(sameColumn, current === null ? null : current.dir)
  return dir === null ? null : { columnKey, dir }
}

/**
 * Ascending comparison of two cell values.
 *
 * Numbers compare numerically and strings compare with `localeCompare` — a
 * numeric column must never be ordered as text ("100" before "9"), and a text
 * column must respect the locale's collation. A mixed column (one row a
 * number, another a string) falls back to string comparison of both, which is
 * the only total order available; it is not a shape any caller should build on
 * purpose.
 *
 * `null` is NOT handled here — {@link sortRowsByColumn} pulls it out first,
 * because its placement is direction-independent and a comparator that is
 * multiplied by the direction factor cannot express that.
 */
function compareValues(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  return String(a).localeCompare(String(b))
}

/**
 * Return a NEW array of `rows` ordered by `sort`.
 *
 * `valueOf` is the column's `sortValue` — it is called once per row per
 * comparison, so it must be cheap (read a field, do not format a string).
 * `sort === null` ⇒ a fresh shallow copy in the incoming order.
 */
export function sortRowsByColumn<T>(
  rows: readonly T[],
  sort: TableSortState | null,
  valueOf: (row: T) => TableSortValue,
): readonly T[] {
  if (sort === null) return [...rows]
  const factor = sort.dir === 'asc' ? 1 : -1
  return rows.toSorted((a, b) => {
    const av = valueOf(a)
    const bv = valueOf(b)
    // Rule 1 — the missing value goes last whichever way the column points,
    // so it is decided BEFORE the direction factor is applied.
    if (av === null || bv === null) {
      if (av === bv) return 0
      return av === null ? 1 : -1
    }
    return factor * compareValues(av, bv)
  })
}

/** The `aria-sort` value WAI-ARIA scopes to a `<th>` (never to an inner control). */
export type AriaSortValue = 'ascending' | 'descending' | 'none'

/** Derive the `<th>` `aria-sort` for `columnKey` from the table's sort state. */
export function ariaSortForColumn(sort: TableSortState | null, columnKey: string): AriaSortValue {
  if (sort === null || sort.columnKey !== columnKey) return 'none'
  return sort.dir === 'asc' ? 'ascending' : 'descending'
}
