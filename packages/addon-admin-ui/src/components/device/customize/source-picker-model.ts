/**
 * The source picker's model (D676 ruling 9): a device is found by a search
 * over ONE `listAll` read, and only the picked device's fields are read —
 * `getWireableFields` (which walks `getBindings`, measured up to 5.24 s) and
 * one `deviceState.getSnapshot` for the live values. Item leaves are never
 * offered (a per-item path needs an item key the picker does not choose).
 */
import type {
  CompositionFieldKind,
  CompositionFieldSource,
  CompositionSourceRef,
  DeviceInfo,
} from '@camstack/types'
import { sourceFor } from './source-for'

export interface PickerDevice {
  readonly id: number
  readonly name: string
  readonly addonId: string
  readonly stableId: string
  readonly location: string | null
  readonly type: string
  readonly parentDeviceId: number | null
}

export interface WireableCatalogField {
  readonly path: string
  readonly kind: CompositionFieldKind
  readonly enumValues?: readonly string[]
  readonly item?: boolean
}

export interface WireableCatalogCap {
  readonly cap: string
  readonly fields: readonly WireableCatalogField[]
}

export interface WireableCatalog {
  readonly caps: readonly WireableCatalogCap[]
}

export type DeviceSnapshot = Readonly<Record<string, Readonly<Record<string, unknown>>>>

export interface PickerFieldRow {
  readonly cap: string
  readonly path: string
  readonly kind: CompositionFieldKind
  readonly value: unknown
  /** null = not usable for the target kind (not offered). */
  readonly source: CompositionFieldSource | null
}

export const PICKER_DEVICE_LIMIT = 20

export function toPickerDevices(devices: readonly DeviceInfo[]): readonly PickerDevice[] {
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    addonId: d.addonId,
    stableId: d.stableId,
    location: d.location,
    type: d.type,
    parentDeviceId: d.parentDeviceId,
  }))
}

export function searchPickerDevices(
  devices: readonly PickerDevice[],
  query: string,
  excludeIds: readonly number[],
): readonly PickerDevice[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return []
  return devices
    .filter(
      (d) =>
        !excludeIds.includes(d.id) &&
        [d.name, d.stableId, d.location ?? ''].some((v) => v.toLowerCase().includes(needle)),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .slice(0, PICKER_DEVICE_LIMIT)
}

export function readPath(slice: unknown, path: string): unknown {
  let current: unknown = slice
  for (const segment of path.split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) return undefined
    current = Object.getOwnPropertyDescriptor(current, segment)?.value
  }
  return current
}

function fieldSource(
  ref: CompositionSourceRef,
  cap: string,
  field: WireableCatalogField,
  targetKind: CompositionFieldKind | null,
): CompositionFieldSource | null {
  if (targetKind === null) return { kind: 'from', source: ref, cap, fieldPath: field.path }
  return sourceFor(targetKind, { source: ref, cap, fieldPath: field.path, kind: field.kind })
}

export function pickerFieldRows(
  device: PickerDevice,
  catalog: WireableCatalog,
  snapshot: DeviceSnapshot | null,
  targetKind: CompositionFieldKind | null,
): readonly PickerFieldRow[] {
  const ref = { addonId: device.addonId, stableId: device.stableId }
  return catalog.caps.flatMap((cap) =>
    cap.fields
      .filter((f) => f.item !== true)
      .map((f) => ({
        cap: cap.cap,
        path: f.path,
        kind: f.kind,
        value: snapshot === null ? undefined : readPath(snapshot[cap.cap], f.path),
        source: fieldSource(ref, cap.cap, f, targetKind),
      })),
  )
}

/** The live value as text; `answered` = the snapshot read has answered (else "…", never "no value" — D315). */
export function formatLiveValue(value: unknown, answered: boolean): string {
  if (!answered) return '…'
  if (value === undefined) return '—'
  if (value === null) return 'null'
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return String(value)
  }
  return JSON.stringify(value)
}
