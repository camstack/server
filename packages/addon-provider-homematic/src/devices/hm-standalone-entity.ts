import type { SavedDevice } from '@camstack/types'

/**
 * Standalone-entity restore predicate for the Homematic `'entities'` adoption
 * granularity. Mirrors the HA addon's `isStandaloneEntitySaved`.
 *
 * A standalone entity device is a TOP-LEVEL (`parentDeviceId === null`)
 * Homematic-adopted device whose config carries the `hmEntityKey` marker (set
 * only on the `adopt('entities')` create path). The Container parent carries no
 * `hmEntityKey`; its accessory children carry a `parentDeviceId`. Both are
 * excluded.
 *
 * The default `BaseDeviceProvider` two-pass restore resolves a top-level row's
 * class from `deviceClasses[type]`, which for Homematic only maps
 * `Container → HmContainerDevice`. A standalone entity device persists with an
 * ENTITY device-type (Switch / Sensor / EventEmitter / Update / …) NOT in that
 * map — so the default pass would skip it and it would vanish on reboot. The
 * addon's `onRestoreDevices` restores these rows explicitly via the
 * cap-re-derive dispatcher (`hmChildDeviceClass`).
 */
export function isStandaloneEntitySaved(saved: SavedDevice): boolean {
  if (saved.parentDeviceId !== null) return false
  if (saved.config['system'] !== 'homematic') return false
  const key = saved.config['hmEntityKey']
  return typeof key === 'string' && key.length > 0
}
