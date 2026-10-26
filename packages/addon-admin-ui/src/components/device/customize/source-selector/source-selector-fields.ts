import type { DeviceSnapshot, PickerDevice, WireableCatalog } from '../source-picker-model'
import { formatLiveValue, pickerFieldRows, readPath } from '../source-picker-model'
import { keyedFieldOffers } from '../keyed/keyed-fit'
import { scalarFieldOffers } from '../scalar/scalar-fit'
import type { EventShape } from '../event/event-fit'
import {
  destinationIsKeyed,
  type SourceDestination,
  type SourceWireableField,
} from './source-selector-model'
import { wireableEventFields } from './source-selector-event-fields'

export function wireableFieldsForDestination(
  destination: SourceDestination,
  catalog: WireableCatalog,
  snapshotAnswered: boolean,
  snapshot: DeviceSnapshot | null,
  device: PickerDevice | null,
  eventShape: EventShape | null = null,
): readonly SourceWireableField[] {
  if (eventShape !== null) {
    return wireableEventFields(destination, catalog, eventShape, snapshotAnswered, snapshot)
  }
  if (destination.pickerTargetKind !== undefined && device !== null) {
    return pickerFieldRows(device, catalog, snapshot, destination.pickerTargetKind).map((row) => ({
      cap: row.cap,
      path: row.path,
      kind: row.kind,
      unit: null,
      currentText: formatLiveValue(row.value, snapshotAnswered),
    }))
  }
  const offers = destinationIsKeyed(destination)
    ? keyedFieldOffers(catalog, snapshot)
    : scalarFieldOffers(catalog, snapshot)
  return offers.map((offer) => {
    const value = snapshot === null ? undefined : readPath(snapshot[offer.cap], offer.path)
    return {
      cap: offer.cap,
      path: offer.path,
      kind: offer.kind,
      unit: offer.unit,
      currentText: formatLiveValue(value, snapshotAnswered),
    }
  })
}
