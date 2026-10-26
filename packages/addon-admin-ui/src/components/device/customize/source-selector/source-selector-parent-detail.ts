/**
 * Customize rows and the picker beside them share one label. The picker's
 * primary line is `DeviceName`; this is the same string for a card that
 * already holds the fleet.
 */
import {
  deviceNameNouns,
  indexDeviceNames,
  resolveDeviceLabel,
  type DeviceNameFields,
  type DeviceNameNouns,
  type PickerItem,
} from '@camstack/ui-library'
import type { SourceCandidateDevice } from './source-selector-model'

export interface DeviceNameSource {
  readonly id: number
  readonly name: string
  readonly type: string
  readonly stableId: string
  readonly parentDeviceId?: number | null
  readonly location?: string | null
  readonly role?: string | null
  readonly primaryChildEntityId?: string | null
}

export function candidateFields(entry: DeviceNameSource): DeviceNameFields {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    stableId: entry.stableId,
    parentDeviceId: entry.parentDeviceId ?? null,
    ...(entry.location !== undefined && entry.location !== null
      ? { location: entry.location }
      : {}),
    ...(entry.role !== undefined && entry.role !== null ? { role: entry.role } : {}),
    ...(entry.primaryChildEntityId !== undefined && entry.primaryChildEntityId !== null
      ? { primaryChildEntityId: entry.primaryChildEntityId }
      : {}),
  }
}

export function sourceRowLabel(
  device: DeviceNameFields,
  fleet: readonly DeviceNameFields[],
  nouns: DeviceNameNouns = deviceNameNouns('en'),
): string {
  return resolveDeviceLabel(device, 'compact', indexDeviceNames(fleet), nouns)
}

/** Compatible rows. The picker paints the label; `name` stays the stored string so search still finds it. */
export function compatiblePickerItems(
  compatible: readonly SourceCandidateDevice[],
): readonly PickerItem<number>[] {
  return compatible.map((row) => ({
    id: row.id,
    name: row.name,
    type: row.type,
    parentDeviceId: row.parentDeviceId,
    ...(row.location !== null ? { location: row.location } : {}),
  }))
}
