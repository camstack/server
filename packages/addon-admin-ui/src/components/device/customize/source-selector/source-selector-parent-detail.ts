import {
  parentDetailOf,
  resolveParentNames,
  type ParentResolvable,
  type PickerItem,
} from '@camstack/ui-library'
import type { SourceCandidateDevice } from './source-selector-model'

/**
 * A Customize card row: the device's own name, and — when it lives under a
 * container — that container's name from the same map the picker turns into
 * "in &lt;parent&gt;". A top-level device stays its own name.
 */
export function sourceRowLabel(
  name: string,
  deviceId: number | null,
  fleet: readonly ParentResolvable[],
): string {
  if (deviceId === null) return name
  const parent = resolveParentNames(fleet).get(deviceId)
  if (parent === undefined || parent.length === 0) return name
  return `${name} · ${parent}`
}

/** Compatible rows only; parent names still resolve from the full fleet. */
export function compatiblePickerItems(
  compatible: readonly SourceCandidateDevice[],
  fleet: readonly ParentResolvable[],
): readonly PickerItem<number>[] {
  const parents = resolveParentNames(fleet)
  return compatible.map((row) => {
    const base: PickerItem<number> = {
      id: row.id,
      name: row.name,
      type: row.type,
      parentDeviceId: row.parentDeviceId,
      ...(row.location !== null ? { location: row.location } : {}),
    }
    const detail = parentDetailOf(parents.get(row.id))
    if (detail === undefined) return base
    return { ...base, detail }
  })
}
