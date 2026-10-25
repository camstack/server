/**
 * Build the editor's source picker from OSD-relevant cap definitions.
 * Gateway / infrastructure caps (broker, mqtt, deviceExport, …) never
 * appear — see `osd-source-fields.ts`.
 */
import type { OsdSourceOption } from '@camstack/types'
import { isOsdLeafDeviceType, isOsdSourceCap, osdStateLeavesByName } from './osd-source-fields.js'

export interface CatalogDevice {
  readonly id: number
  readonly name: string
  /** When `container`, the device contributes no catalog rows (pick a child). */
  readonly type?: string | null
}

/** Turn `air-quality-sensor` + `pm25` into `Air Quality Sensor · pm25`. */
export function humanizeCapName(capName: string): string {
  return capName
    .split('-')
    .map((part) => (part.length === 0 ? part : part[0]!.toUpperCase() + part.slice(1)))
    .join(' ')
}

/**
 * Every OSD-bindable value across the cluster, with the camera's own
 * state first — that is what an operator reaches for, and a picker that
 * buries it under 200 other devices is a picker nobody uses.
 */
export function sourceOptionsFor(
  cameraDeviceId: number,
  devices: readonly CatalogDevice[],
  capsByDevice: ReadonlyMap<number, readonly string[]>,
): OsdSourceOption[] {
  const ordered = [...devices].sort((a, b) => {
    if (a.id === cameraDeviceId) return -1
    if (b.id === cameraDeviceId) return 1
    return a.id - b.id
  })

  const options: OsdSourceOption[] = []
  for (const device of ordered) {
    if (!isOsdLeafDeviceType(device.type ?? null)) continue
    for (const capName of capsByDevice.get(device.id) ?? []) {
      if (!isOsdSourceCap(capName)) continue
      for (const leaf of osdStateLeavesByName(capName)) {
        options.push({
          deviceId: device.id,
          deviceName: device.name,
          capName,
          valuePath: leaf.path,
          label: `${humanizeCapName(capName)} · ${leaf.path}`,
          valueType: leaf.valueType,
          ...(leaf.enumValues !== undefined ? { enumValues: leaf.enumValues } : {}),
        })
      }
    }
  }
  return options
}
