/**
 * A device field bound in an expression names its device by the PAIR
 * (`addonId`, `stableId`): a stable id is only unique per addon (D1021).
 * Bindings written before the pair existed carry no `addonId`; they resolve by
 * the stable id alone and only while it is unambiguous.
 */
import type { ExpressionBindingSource } from '@camstack/types'
import type { AutomationDevice } from './automation-data'

export type GlobalBinding = Extract<ExpressionBindingSource, { kind: 'global' }>

/** The binding a picked `(device, cap, field)` authors — with the owning addon, so the pair is complete. */
export function globalBindingFor(
  devices: readonly AutomationDevice[],
  pick: { readonly deviceId: number; readonly cap: string; readonly fieldPath: string },
): GlobalBinding {
  const device = devices.find((d) => d.id === pick.deviceId)
  return {
    kind: 'global',
    sourceStableId: device?.stableId ?? '',
    ...(device?.addonId !== undefined ? { addonId: device.addonId } : {}),
    cap: pick.cap,
    fieldPath: pick.fieldPath,
  }
}

/** The device a binding names: by the pair when it has one, else by a stable id no other addon shares. */
export function deviceIdOfBinding(
  devices: readonly AutomationDevice[],
  source: GlobalBinding,
): number {
  if (source.addonId !== undefined) {
    return (
      devices.find((d) => d.stableId === source.sourceStableId && d.addonId === source.addonId)
        ?.id ?? 0
    )
  }
  const sameStableId = devices.filter((d) => d.stableId === source.sourceStableId)
  return sameStableId.length === 1 ? (sameStableId[0]?.id ?? 0) : 0
}
