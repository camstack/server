/**
 * The device table's sortable column header.
 *
 * The rendering — label + chevron indicator + hover placeholder — lives in
 * `composites/sort-header-button.tsx` and is shared with `DataTable`. This
 * file is the device-list adapter: it maps `DeviceSort` (which keys columns by
 * `columnId`) onto the shared control's `active`/`dir` pair. It exists so the
 * device list keeps its own column vocabulary without a second copy of the
 * button.
 *
 * The owning `<th>` carries `aria-sort` (WAI-ARIA scopes it to `<th>`/`<td>`);
 * non-sortable columns keep plain static text and never mount this.
 */
import type { ReactNode } from 'react'
import { SortHeaderButton } from '../sort-header-button'
import type { DeviceSort, SortableColumnId } from './sort'

interface SortableHeaderButtonProps {
  readonly columnId: SortableColumnId
  readonly label: string
  readonly sort: DeviceSort | null
  readonly onSort: (columnId: SortableColumnId) => void
}

export function SortableHeaderButton({
  columnId,
  label,
  sort,
  onSort,
}: SortableHeaderButtonProps): ReactNode {
  const active = sort !== null && sort.columnId === columnId
  return (
    <SortHeaderButton
      label={<span className="uppercase tracking-wider">{label}</span>}
      active={active}
      dir={active ? sort.dir : 'asc'}
      onSort={() => onSort(columnId)}
    />
  )
}
