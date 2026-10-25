/**
 * Device rows for an event override dialog: incompatible devices stay visible
 * but locked, like scalar field rows marked "Not compatible".
 */
import type { PickerItem } from '@camstack/ui-library'
import type { PickerDevice } from '../source-picker-model'
import { eventDeviceCapEligible } from './event-fit'

export function eventPickerLockedIds(
  fleet: readonly PickerDevice[],
  hostId: number,
  capIndex: ReadonlyMap<number, readonly string[]>,
  declarationCaps: readonly string[],
): readonly number[] {
  return fleet
    .filter((row) => row.id !== hostId)
    .filter((row) => !eventDeviceCapEligible(capIndex.get(row.id) ?? [], declarationCaps))
    .map((row) => row.id)
}

export function eventPickerItems(
  fleet: readonly PickerDevice[],
  hostId: number,
): readonly PickerItem<number>[] {
  return fleet
    .filter((row) => row.id !== hostId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      type: row.type,
      ...(row.location !== null ? { location: row.location } : {}),
    }))
}
