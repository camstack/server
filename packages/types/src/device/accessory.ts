/**
 * Accessory device helpers — shared across drivers.
 *
 * Many vendor-specific drivers register accessory child devices on
 * top of a parent (Reolink: siren / floodlight / PIR / autotrack /
 * chime; ONVIF: relay outputs; future: Tapo Hub child devices). Each
 * driver picks the right `DeviceType` + `DeviceRole` explicitly when
 * spawning, builds a name derived from the parent, and produces a
 * stableId tied to the parent so boot-restore can reconstruct the
 * relationship.
 *
 * Centralised `(kind → DeviceType)` mapping was dropped on purpose:
 * drivers may reasonably disagree on the right type for an accessory
 * (a Reolink PIR exposes a switch on/off + sensitivity, while a hypothetical
 * read-only motion-only sensor might be `DeviceType.Sensor`). Forcing
 * one canonical mapping was over-prescriptive and added a layer of
 * indirection without saving meaningful code at call sites — the
 * driver knows its own hardware best.
 */
import { DeviceRole } from './device-type.js'

/**
 * Subset of `DeviceRole` values that drivers register as child
 * accessories of a parent device. Sourced verbatim from `DeviceRole`
 * — `AccessoryKind` is the alias drivers use when building accessory
 * children, so the call site reads as
 * `accessoryStableId(parent, AccessoryKind.Siren)` rather than
 * `accessoryStableId(parent, DeviceRole.Siren)` (which would imply
 * any role works, including non-accessory ones like Doorbell).
 */
export const AccessoryKind = {
  Siren: DeviceRole.Siren,
  Floodlight: DeviceRole.Floodlight,
  Spotlight: DeviceRole.Spotlight,
  PirSensor: DeviceRole.PirSensor,
  Chime: DeviceRole.Chime,
  Autotrack: DeviceRole.Autotrack,
  Nightvision: DeviceRole.Nightvision,
  PrivacyMask: DeviceRole.PrivacyMask,
} as const

export type AccessoryKindValue = (typeof AccessoryKind)[keyof typeof AccessoryKind]

/**
 * Default English label for each accessory kind. Drivers append this
 * to the parent's name — e.g. `"Living Room Siren"` for a camera named
 * `"Living Room"`. Localisation lives in the UI layer; the driver only
 * has to surface a stable English name.
 */
export const ACCESSORY_LABEL: Record<AccessoryKindValue, string> = {
  [AccessoryKind.Siren]: 'Siren',
  [AccessoryKind.Floodlight]: 'Floodlight',
  [AccessoryKind.Spotlight]: 'Spotlight',
  [AccessoryKind.PirSensor]: 'PIR',
  [AccessoryKind.Chime]: 'Chime',
  [AccessoryKind.Autotrack]: 'Autotracking',
  [AccessoryKind.Nightvision]: 'Night Vision',
  [AccessoryKind.PrivacyMask]: 'Privacy Mask',
}

/**
 * Canonical stableId for an accessory child. Format: `${parent}:${role}`
 * for single-instance accessories; drivers that need multiple instances
 * of the same kind (e.g. wireless chimes) pass an extra `index` token
 * which the helper appends as `:${index}`.
 *
 * The stableId is the persistence key the device-manager uses to
 * resolve `(addonId, stableId) → numeric id` across reboots, so it
 * MUST be stable across runs. Using the parent's stableId + the role
 * meets this — a driver can re-create children deterministically as
 * long as the parent's stableId is also stable (which the platform
 * already guarantees).
 */
export function accessoryStableId(
  parentStableId: string,
  kind: AccessoryKindValue,
  index?: number,
): string {
  const base = `${parentStableId}:${kind}`
  return typeof index === 'number' ? `${base}:${index}` : base
}
