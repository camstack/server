import type { DeviceFaultType } from '@dominevo/types'

import type { PickOption } from './notification-rule-pickers'

/**
 * The fault-code picker's options from the catalogs of the devices in scope.
 *
 * One entry per CODE: the first label seen wins (two devices of one integration
 * declare the same words), and the severity rides as the hint. Sorted by label
 * so the list does not reorder between polls.
 */
export function mergeFaultTypes(
  catalogs: readonly (readonly DeviceFaultType[] | undefined)[],
): readonly PickOption[] {
  const byCode = new Map<string, PickOption>()
  for (const catalog of catalogs) {
    for (const type of catalog ?? []) {
      if (!byCode.has(type.code)) {
        byCode.set(type.code, {
          value: type.code,
          label: type.label,
          hint: type.severity,
        })
      }
    }
  }
  return [...byCode.values()].sort((a, b) => a.label.localeCompare(b.label))
}
