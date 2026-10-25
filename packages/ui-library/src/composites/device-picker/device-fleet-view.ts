/**
 * What an admin picker judges a selected id against: the WHOLE fleet, with
 * whether it answered. Never the list the picker draws — a camera picker
 * draws cameras, and a selected sensor missing from it still exists.
 *
 * Generic over the id since D637: the system family's node and package
 * pickers judge string ids the same way (`scope-pickers.helpers.ts`).
 */

import {
  type DeviceListQueryLike,
  type DeviceListState,
  deviceListStateOf,
  type NamedDevice,
  type SelectionId,
} from './device-selection'

export interface PickerFleetView<Id extends SelectionId = number> {
  readonly state: DeviceListState
  readonly devices: readonly NamedDevice<Id>[] | undefined
}

export type DeviceFleetView = PickerFleetView<number>

export function fleetViewOf(query: DeviceListQueryLike): DeviceFleetView {
  return { state: deviceListStateOf(query), devices: query.data }
}
