import {
  parentDetailOf,
  resolveParentNames,
  type ParentResolvable,
  type PickerItem,
} from '@camstack/ui-library'
import type { SourceCandidateDevice } from './source-selector-model'

/**
 * Build {@link DevicePicker} rows for compatible devices only, but resolve
 * `in <parent>` from the full fleet so a container filtered to incompatible
 * still names correctly.
 */
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
