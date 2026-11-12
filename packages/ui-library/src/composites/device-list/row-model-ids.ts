import { DeviceType } from '@camstack/types'
import type { DeviceItemDevice } from '../device-item/helpers'

/** The device types whose row value is drawn from the row model. */
const ROW_MODEL_TYPES: ReadonlySet<string> = new Set([DeviceType.Sensor, DeviceType.Control])

/**
 * The devices of one page whose rows read a row model: the page's Sensor and Control
 * rows, and those among their accessories (a container row draws its primary child,
 * an expanded parent its children). One query answers them all.
 */
export function rowModelDeviceIds(
  pageRows: readonly DeviceItemDevice[],
  accessoriesByParent: ReadonlyMap<number, readonly DeviceItemDevice[]>,
): readonly number[] {
  return pageRows
    .flatMap((row) => [row, ...(accessoriesByParent.get(row.id) ?? [])])
    .filter((d) => ROW_MODEL_TYPES.has(d.type))
    .map((d) => d.id)
}
