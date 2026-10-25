import { DeviceType } from '@camstack/types'

/**
 * The Dreame device kind we support, derived from the cloud `model` prefix.
 * `vacuum` → `dreame.vacuum.*`; `mower` → `dreame.mower.*`; anything else is
 * `unsupported` and skipped during discovery/adoption.
 */
export type DreameDeviceKind = 'vacuum' | 'mower' | 'unsupported'

/** Classify a Dreame cloud `model` string into a supported device kind. Pure. */
export function classifyDreameModel(model: string): DreameDeviceKind {
  if (model.startsWith('dreame.vacuum.')) return 'vacuum'
  if (model.startsWith('dreame.mower.')) return 'mower'
  return 'unsupported'
}

/** The camstack {@link DeviceType} for a supported Dreame kind. */
export function deviceTypeForKind(kind: 'vacuum' | 'mower'): DeviceType {
  return kind === 'vacuum' ? DeviceType.Vacuum : DeviceType.LawnMower
}

/** The device-scoped control cap a supported Dreame accessory child registers. */
export function controlCapForKind(kind: 'vacuum' | 'mower'): string {
  return kind === 'vacuum' ? 'vacuum-control' : 'lawn-mower-control'
}
