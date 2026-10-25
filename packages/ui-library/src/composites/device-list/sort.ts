/**
 * Device-table column sorting (top-level rows only).
 *
 * Only `name`, `type`, and `manufacturer` are sortable. Sorting reorders the
 * TOP-LEVEL device rows; accessory children stay grouped under their parent
 * (they're looked up per-parent-id from `accessoriesByParent`, not part of this
 * list), so sorting parents never lifts a child to the top level.
 *
 * `sortRows` is pure: it returns a NEW array and never mutates the input. A
 * `null` sort = current order, returned as a fresh shallow copy. The sort is
 * stable (Array.prototype.sort is stable in every supported runtime) so equal
 * keys keep their incoming relative order.
 */
import type { DeviceItemDevice } from '../device-item/helpers'
import { deviceTypeMetaOf } from '../device-meta'
import { nextSortDirection } from '../table-sort'
import { orderAdoptedAfterParent } from './group'
import { compareHardware, hasManufacturer } from './hardware'

/** Columns that expose a clickable sort header. */
export type SortableColumnId = 'name' | 'type' | 'manufacturer'

export type SortDirection = 'asc' | 'desc'

export interface DeviceSort {
  readonly columnId: SortableColumnId
  readonly dir: SortDirection
}

/** Human-facing type label used for the `type` comparator — matches the label
 *  the row renders, so the sort order reads as the user sees it. */
function typeLabel(device: DeviceItemDevice): string {
  return deviceTypeMetaOf(device.type).label.toLowerCase()
}

function nameKey(device: DeviceItemDevice): string {
  return device.name.toLowerCase()
}

/** Ascending comparator for a given sortable column. */
function ascComparator(
  columnId: SortableColumnId,
): (a: DeviceItemDevice, b: DeviceItemDevice) => number {
  if (columnId === 'name') return (a, b) => nameKey(a).localeCompare(nameKey(b))
  if (columnId === 'type') return (a, b) => typeLabel(a).localeCompare(typeLabel(b))
  return compareHardware
}

/**
 * Toggle a column's sort on header click: none → asc → desc → none.
 * Clicking a DIFFERENT column starts it fresh at `asc`.
 *
 * The rule itself lives in `composites/table-sort.ts` and is shared with
 * `DataTable` — this function only re-labels the result with the device
 * list's own `columnId` vocabulary.
 */
export function nextSort(
  current: DeviceSort | null,
  columnId: SortableColumnId,
): DeviceSort | null {
  const sameColumn = current !== null && current.columnId === columnId
  const dir = nextSortDirection(sameColumn, current === null ? null : current.dir)
  return dir === null ? null : { columnId, dir }
}

/**
 * Return a NEW array of the top-level rows in sorted order. `null` ⇒ a fresh
 * copy in the original order. Stable + immutable; the input is never mutated.
 */
export function sortRows(
  rows: readonly DeviceItemDevice[],
  sort: DeviceSort | null,
): readonly DeviceItemDevice[] {
  if (sort === null) return [...rows]
  const compare = ascComparator(sort.columnId)
  const factor = sort.dir === 'asc' ? 1 : -1
  const sorted = [...rows].toSorted((a, b) => {
    // Manufacturer: rows with NO manufacturer always sort LAST, independent of
    // direction (the empty/missing state is "unknown", not a value to reverse).
    // The direction factor applies only to rows that both carry a value.
    if (sort.columnId === 'manufacturer') {
      const aHas = hasManufacturer(a)
      const bHas = hasManufacturer(b)
      if (aHas !== bHas) return aHas ? -1 : 1
    }
    return factor * compare(a, b)
  })
  // A column sort must never scatter a hub's adopted rows away from their
  // parent: the parent takes its sorted position, the family follows it
  // (siblings stay sorted among themselves — they come out of `sorted`).
  return orderAdoptedAfterParent(sorted)
}
