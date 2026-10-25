/** Device ↔ composition source ref, from ONE `listAll` read (D676). */
import { type CompositionSourceRef, compositionSourceKey } from '@camstack/types'
import type { PickerDevice } from './source-picker-model'

function refOf(device: PickerDevice): CompositionSourceRef {
  return { addonId: device.addonId, stableId: device.stableId }
}

/** compositionSourceKey → device, from ONE listAll read. */
export function devicesByRef(devices: readonly PickerDevice[]): ReadonlyMap<string, PickerDevice> {
  return new Map(devices.map((d) => [compositionSourceKey(refOf(d)), d]))
}
