/**
 * Devices offered to the OSD DevicePicker — containers INCLUDED so the
 * operator can pick a gateway, then an OSD-supported child.
 */
import { isContainerDeviceType, isOsdLeafDeviceType } from './osd-source-fields.js'

export interface SlimDeviceRow {
  readonly id: number
  readonly name: string
  readonly type?: string | null
  readonly location?: string | null
  readonly parentDeviceId?: number | null
}

export interface OsdPickerDevice {
  readonly id: number
  readonly name: string
  /** Absent when the row has none — the DevicePicker's `PickerItem.type` has no `null`. */
  readonly type?: string
  readonly location: string | null
  readonly parentDeviceId: number | null
}

export function toOsdPickerDevices(devices: readonly SlimDeviceRow[]): OsdPickerDevice[] {
  return devices.map((d) => ({
    id: d.id,
    name: d.name,
    ...(typeof d.type === 'string' ? { type: d.type } : {}),
    location: d.location ?? null,
    parentDeviceId: d.parentDeviceId ?? null,
  }))
}

/** Children of a container that have at least one OSD catalog field. */
export function osdSupportedChildrenOf(
  containerId: number,
  devices: readonly OsdPickerDevice[],
  deviceIdsWithOsdFields: ReadonlySet<number>,
): OsdPickerDevice[] {
  return devices
    .filter(
      (d) =>
        d.parentDeviceId === containerId &&
        isOsdLeafDeviceType(d.type) &&
        deviceIdsWithOsdFields.has(d.id),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name))
}

export function deviceById(
  devices: readonly OsdPickerDevice[],
  id: number,
): OsdPickerDevice | undefined {
  return devices.find((d) => d.id === id)
}

export { isContainerDeviceType }
