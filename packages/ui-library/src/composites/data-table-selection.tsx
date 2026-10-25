/**
 * Row selection for {@link DataTable}, as a synthetic leading column.
 *
 * A column, not a second rendering path: the table and the card layout both
 * already know how to draw columns, so selection works in both without a
 * branch of its own (in cards, the unlabelled column lands in the card's
 * footer strip with the other controls).
 *
 * Rules a bulk action relies on — pinned in `data-table-paging-selection.test`:
 *  - the header box acts on the selectable rows of the page ON SCREEN only;
 *  - a row `isSelectable` rejects has no box and is never added;
 *  - keys of rows that are not on screen survive a page-level toggle.
 */
import { useEffect, useRef, type ReactNode } from 'react'
import { Checkbox } from '../primitives/checkbox'
import type { DataColumn } from './data-table'

export interface DataTableSelection<T> {
  /** Selected row keys (`rowKey(row)`, stringified). Owned by the caller. */
  readonly selected: ReadonlySet<string>
  readonly onChange: (next: ReadonlySet<string>) => void
  /** False = no checkbox for this row (e.g. the caller's own session). */
  readonly isSelectable?: (row: T) => boolean
  /** Accessible name of a row's checkbox — name the row, not "select". */
  readonly rowLabel: (row: T) => string
  /** Accessible name of the header checkbox. */
  readonly pageLabel: string
}

export const SELECTION_COLUMN_KEY = '__select'

const CHECKBOX = 'cursor-pointer align-middle'

function PageCheckbox({
  checked,
  indeterminate,
  disabled,
  label,
  onToggle,
}: {
  readonly checked: boolean
  readonly indeterminate: boolean
  readonly disabled: boolean
  readonly label: string
  readonly onToggle: () => void
}): ReactNode {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (ref.current !== null) ref.current.indeterminate = indeterminate
  }, [indeterminate])
  return (
    <Checkbox
      ref={ref}
      aria-label={label}
      checked={checked}
      disabled={disabled}
      onChange={onToggle}
      className={CHECKBOX}
    />
  )
}

/** The selection column for the rows currently on screen. */
export function selectionColumn<T>(
  selection: DataTableSelection<T>,
  pageRows: readonly T[],
  keyOf: (row: T) => string,
): DataColumn<T> {
  const selectable = selection.isSelectable ?? (() => true)
  const pageKeys = pageRows.filter(selectable).map(keyOf)
  const onPage = pageKeys.filter((k) => selection.selected.has(k)).length
  const allOnPage = pageKeys.length > 0 && onPage === pageKeys.length

  const togglePage = (): void => {
    const next = new Set(selection.selected)
    for (const key of pageKeys) {
      if (allOnPage) next.delete(key)
      else next.add(key)
    }
    selection.onChange(next)
  }
  const toggleRow = (key: string): void => {
    const next = new Set(selection.selected)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    selection.onChange(next)
  }

  return {
    key: SELECTION_COLUMN_KEY,
    width: 'w-8',
    headerRender: () => (
      <PageCheckbox
        checked={allOnPage}
        indeterminate={onPage > 0 && !allOnPage}
        disabled={pageKeys.length === 0}
        label={selection.pageLabel}
        onToggle={togglePage}
      />
    ),
    render: (row) => {
      if (!selectable(row)) return null
      const key = keyOf(row)
      return (
        <Checkbox
          aria-label={selection.rowLabel(row)}
          checked={selection.selected.has(key)}
          onChange={() => toggleRow(key)}
          onClick={(e) => e.stopPropagation()}
          className={CHECKBOX}
        />
      )
    },
  }
}
