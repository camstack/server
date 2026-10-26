/**
 * The unit a composed-device field row offers convert-unit from (D941, D944).
 */
import { CAP_RUNTIME_FIELD_UNITS } from '../generated/customize-catalog.js'

export function runtimeFieldUnit(cap: string, path: string): string | undefined {
  const table: Readonly<Record<string, Readonly<Record<string, string>>>> = CAP_RUNTIME_FIELD_UNITS
  return table[cap]?.[path]
}
