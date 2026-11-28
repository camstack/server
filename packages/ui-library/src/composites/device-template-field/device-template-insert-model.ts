import { runtimeFieldUnit } from '@dominevo/types'
import { type DeviceCapFields, deviceTemplateToken } from './device-template-model'

export interface InsertTokenOptions {
  readonly withUnit: boolean
  readonly unit?: string
}

/** Token written when the insert dialog confirms — optional `unit()` when the field has one. */
export function tokenForInsert(
  alias: string,
  pick: { readonly cap: string; readonly path: string },
  caps: readonly DeviceCapFields[],
  options: InsertTokenOptions,
): string {
  const fieldUnit = runtimeFieldUnit(pick.cap, pick.path)
  const unit =
    options.withUnit && fieldUnit !== undefined && fieldUnit !== '' ? fieldUnit : undefined
  return deviceTemplateToken(alias, pick, caps, unit)
}
