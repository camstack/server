import type {
  CompositionFieldKind,
  CompositionFieldSource,
  CompositionSourceRef,
} from '@camstack/types'
import type { DeviceSnapshot, PickerDevice, WireableCatalog } from './source-picker-model'
import { pickerFieldRows } from './source-picker-model'

export interface SourcePick {
  readonly device: PickerDevice
  readonly ref: CompositionSourceRef
  readonly cap: string
  readonly path: string
  readonly kind: CompositionFieldKind
  readonly source: CompositionFieldSource
  readonly value: unknown
}

export function sourcePickOf(
  device: PickerDevice,
  cap: string,
  path: string,
  catalog: WireableCatalog,
  snapshot: DeviceSnapshot | null,
  targetKind: CompositionFieldKind | null,
): SourcePick | null {
  const rows = pickerFieldRows(device, catalog, snapshot, targetKind)
  const row = rows.find((entry) => entry.cap === cap && entry.path === path)
  if (row === undefined || row.source === null) return null
  const ref = { addonId: device.addonId, stableId: device.stableId }
  return {
    device,
    ref,
    cap: row.cap,
    path: row.path,
    kind: row.kind,
    source: row.source,
    value: row.value,
  }
}
