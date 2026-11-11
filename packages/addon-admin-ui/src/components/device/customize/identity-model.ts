/**
 * The ONE display override with `hidden` set or cleared (D676 ruling 3). Every
 * other key is kept — the identity draft writes the same object on Save — and
 * an override with nothing left is cleared (`null`).
 */
import { type DeviceDisplayOverride, DeviceRole, DeviceType } from '@camstack/types'

export function displayWithHidden(
  display: DeviceDisplayOverride | undefined,
  hidden: boolean,
): DeviceDisplayOverride | null {
  const { hidden: _previous, ...rest } = display ?? {}
  const next: DeviceDisplayOverride = hidden ? { ...rest, hidden: true } : rest
  return Object.keys(next).length === 0 ? null : next
}

const KNOWN_ROLES: ReadonlySet<string> = new Set(Object.values(DeviceRole))

export function isKnownRole(role: string): boolean {
  return KNOWN_ROLES.has(role)
}

/**
 * Roles that belong on a `DeviceType`, mirrored from the groupings on
 * `DeviceRole` in `@camstack/types`. A Camera / Hub / Container has none —
 * role is an accessory / sub-type fact, not a top-level one. Showing every
 * role on every device made the Customize select unusable.
 */
const ROLES_BY_TYPE: Readonly<Partial<Record<DeviceType, readonly DeviceRole[]>>> = {
  [DeviceType.Switch]: [
    DeviceRole.Siren,
    DeviceRole.Floodlight,
    DeviceRole.Spotlight,
    DeviceRole.PirSensor,
    DeviceRole.Chime,
    DeviceRole.Autotrack,
    DeviceRole.Nightvision,
    DeviceRole.PrivacyMask,
    DeviceRole.BinaryHelper,
  ],
  [DeviceType.Light]: [DeviceRole.Floodlight, DeviceRole.Spotlight, DeviceRole.Nightvision],
  [DeviceType.Siren]: [DeviceRole.Siren],
  [DeviceType.Button]: [DeviceRole.Doorbell],
  [DeviceType.Sensor]: [
    DeviceRole.MotionSensor,
    DeviceRole.ContactSensor,
    DeviceRole.LeakSensor,
    DeviceRole.SmokeSensor,
    DeviceRole.COSensor,
    DeviceRole.GasSensor,
    DeviceRole.TamperSensor,
    DeviceRole.VibrationSensor,
    DeviceRole.ConnectivitySensor,
    DeviceRole.SoundSensor,
    DeviceRole.BinarySensor,
    DeviceRole.TemperatureSensor,
    DeviceRole.HumiditySensor,
    DeviceRole.AmbientLightSensor,
    DeviceRole.PressureSensor,
    DeviceRole.WindSensor,
    DeviceRole.RainSensor,
    DeviceRole.UvSensor,
    DeviceRole.SolarRadiationSensor,
    DeviceRole.SoilMoistureSensor,
    DeviceRole.PowerSensor,
    DeviceRole.EnergySensor,
    DeviceRole.VoltageSensor,
    DeviceRole.CurrentSensor,
    DeviceRole.AirQualitySensor,
    DeviceRole.BatterySensor,
    DeviceRole.NumericSensor,
    DeviceRole.EnumSensor,
    DeviceRole.DateTimeSensor,
    DeviceRole.GenericSensor,
  ],
  [DeviceType.Control]: [
    DeviceRole.NumericControl,
    DeviceRole.SelectControl,
    DeviceRole.TextControl,
    DeviceRole.DateTimeControl,
  ],
  [DeviceType.Notifier]: [
    DeviceRole.MobilePushNotifier,
    DeviceRole.MessagingNotifier,
    DeviceRole.EmailNotifier,
    DeviceRole.GenericNotifier,
  ],
}

function isDeviceType(value: string): value is DeviceType {
  for (const candidate of Object.values(DeviceType)) {
    if (candidate === value) return true
  }
  return false
}

/** Roles the Role select offers for a device type (may be empty). */
export function rolesForDeviceType(type: string): readonly string[] {
  if (!isDeviceType(type)) return []
  return ROLES_BY_TYPE[type] ?? []
}

/**
 * The Role select's options for a device: roles that belong on its type,
 * plus the stored role when it is not among them — the wire type is a plain
 * string, and an unmatched value must be shown as itself, never as "none"
 * (L5).
 */
export function roleOptions(current: string | null | undefined, type: string): readonly string[] {
  const known = rolesForDeviceType(type)
  if (current === null || current === undefined || current === '') return known
  if (known.includes(current)) return known
  return [...known, current]
}
