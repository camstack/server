/**
 * A device's KIND is its type plus its role (D1033): the type is the set of
 * controls it has, the role says which thing it is among the devices that
 * share those controls. A plug-in heater is a `switch` with role
 * `switch-heater`; an air conditioner and a radiator valve are both `climate`,
 * told apart by their `climate-*` role.
 */
import { z } from 'zod'
import { DeviceRole, DeviceType } from './device-type.js'

/**
 * Type values a persisted row may still carry after the type was retired, and
 * the type each one is read as. The row is rewritten by the next registration
 * of the device (its provider stamps the live type), so this is a read alias,
 * not a migration.
 *
 * `heater` is deliberately absent: the only heaters were composed devices the
 * operator deletes. Such a row stays an unknown type, which every reader
 * treats as a generic device.
 */
const RETIRED_DEVICE_TYPES: Readonly<Record<string, DeviceType>> = {
  thermostat: DeviceType.Climate,
}

/** The live type a stored `type` value stands for (itself unless retired). */
export function canonicalStoredDeviceType(stored: string): string {
  return RETIRED_DEVICE_TYPES[stored] ?? stored
}

/**
 * The schema for a device type read back from STORAGE — a device config, a
 * container's `entities[]`, a persisted identity. A retired type is read as its
 * live type before the enum check, so a type retired after the record was
 * written never fails the parse and never drops the device (D1033).
 *
 * Never on a schema that is also a WIRE input: a preprocess makes its input
 * type `unknown`, which loosens the generated client. A store whose row schema
 * is a wire schema (a grant, an action, a composition, a notification rule)
 * keeps it strict and rewrites the row with {@link canonicalStoredDeviceType}
 * where it reads the row back.
 */
export const StoredDeviceTypeSchema = z.preprocess(
  (value) => (typeof value === 'string' ? canonicalStoredDeviceType(value) : value),
  z.enum(DeviceType),
)

/** The `climate-*` roles, in the order the role picker lists them. */
export const CLIMATE_ROLES: readonly DeviceRole[] = [
  DeviceRole.ClimateThermostat,
  DeviceRole.ClimateAc,
  DeviceRole.ClimateRadiator,
  DeviceRole.ClimateFloor,
  DeviceRole.ClimateHeater,
  DeviceRole.ClimateHeatPumpCircuit,
  DeviceRole.ClimateVehicle,
]

export type ClimateRole =
  | DeviceRole.ClimateThermostat
  | DeviceRole.ClimateAc
  | DeviceRole.ClimateRadiator
  | DeviceRole.ClimateFloor
  | DeviceRole.ClimateHeater
  | DeviceRole.ClimateHeatPumpCircuit
  | DeviceRole.ClimateVehicle

function isClimateRole(role: string): role is ClimateRole {
  return CLIMATE_ROLES.some((candidate) => candidate === role)
}

/**
 * Which climate device this is. A climate device with no role, or a role that
 * is not a climate one, is a room thermostat: that is what most of them are,
 * and it is the presentation a thermostat had before the types were folded.
 */
export function climateRoleOf(role: string | null | undefined): ClimateRole {
  return role !== null && role !== undefined && isClimateRole(role)
    ? role
    : DeviceRole.ClimateThermostat
}

/** An air conditioner: exports present it as an AC unit, not a thermostat. */
export function isAirConditioner(type: string, role: string | null | undefined): boolean {
  return type === DeviceType.Climate && climateRoleOf(role) === DeviceRole.ClimateAc
}

/** The `media-player-*` roles, in the order the role picker lists them. */
export const MEDIA_PLAYER_ROLES: readonly DeviceRole[] = [DeviceRole.MediaPlayerTv]

/** A car's central locking (a `lock` with role `lock-vehicle`). Consumers ask this, never the role string. */
export function isVehicleLock(type: string, role: string | null | undefined): boolean {
  return type === DeviceType.Lock && role === DeviceRole.LockVehicle
}

/** A car's cabin climate (a `climate` with role `climate-vehicle`). */
export function isVehicleClimate(type: string, role: string | null | undefined): boolean {
  return type === DeviceType.Climate && role === DeviceRole.ClimateVehicle
}

/** A television (a `media-player` with role `media-player-tv`). */
export function isTv(type: string, role: string | null | undefined): boolean {
  return type === DeviceType.MediaPlayer && role === DeviceRole.MediaPlayerTv
}

/**
 * A relay driving an on/off-only lamp (a `switch` with role `switch-light`):
 * drawn and exported as a light, with the switch's power only. The one place
 * that reads the role for it — a consumer asks this, never the role string.
 */
export function isSwitchLight(type: string, role: string | null | undefined): boolean {
  return type === DeviceType.Switch && role === DeviceRole.SwitchLight
}

/**
 * A smart plug (a `switch` with role `outlet`, D875): exported as a plug /
 * outlet. Exports ask this, never the role string.
 */
export function isOutlet(type: string, role: string | null | undefined): boolean {
  return type === DeviceType.Switch && role === DeviceRole.Outlet
}

/**
 * A plain fan behind a switch (a `switch` with role `switch-fan`): exported as
 * a fan with the switch's on/off only — no speed it does not have.
 */
export function isSwitchFan(type: string, role: string | null | undefined): boolean {
  return type === DeviceType.Switch && role === DeviceRole.SwitchFan
}

/**
 * A plug-in heater behind a switch (a `switch` with role `switch-heater`): it
 * has power only, no setpoint and no room temperature, so an export never
 * presents it as a thermostat.
 */
export function isSwitchHeater(type: string, role: string | null | undefined): boolean {
  return type === DeviceType.Switch && role === DeviceRole.SwitchHeater
}

/** The part of a capability definition that says which devices it is offered on. */
export interface DeviceKindGate {
  readonly deviceTypes?: readonly DeviceType[]
  readonly deviceRoles?: Readonly<Partial<Record<DeviceType, readonly DeviceRole[]>>>
  /** Also offered on a device that has one of these caps bound (D1097). */
  readonly bindsWhenDeviceHas?: readonly string[]
}

/**
 * Is a capability offered on a device of this type and role?
 *
 * Fails open where the old type-only gate did: no `deviceTypes` (or an empty
 * list) applies to every device, and an unknown type never filters (a failed
 * meta read must not destroy work, D49). A type the cap's `deviceRoles` names
 * is offered only to the roles listed there; an unknown role is NOT one of
 * them, so a `switch` whose role could not be read is not a heater.
 */
export function capAppliesToDeviceKind(
  gate: DeviceKindGate | undefined,
  deviceType: string | undefined,
  role: string | null | undefined,
): boolean {
  if (deviceType === undefined) return true
  const types = gate?.deviceTypes
  if (!types || types.length === 0) return true
  const type = types.find((candidate) => candidate === deviceType)
  if (type === undefined) return false
  const roles = gate?.deviceRoles?.[type]
  if (roles === undefined) return true
  return role !== null && role !== undefined && roles.some((candidate) => candidate === role)
}

/**
 * Is a capability offered on this device, by its kind OR by a cap it has (D1097)?
 *
 * Without `bindsWhenDeviceHas` this is exactly {@link capAppliesToDeviceKind}. With
 * it, a device that has one of the named caps is admitted whatever its type, and
 * otherwise only a KNOWN type that `deviceTypes` names is: the fail-open of an
 * unresolved type does not apply, because "has a switch" is the rule and an
 * unresolved type must not conjure a cap onto a device that has none.
 */
export function capAdmitsDevice(
  gate: DeviceKindGate | undefined,
  deviceType: string | undefined,
  role: string | null | undefined,
  hasCap: (capName: string) => boolean,
): boolean {
  const companions = gate?.bindsWhenDeviceHas
  if (companions === undefined || companions.length === 0) {
    return capAppliesToDeviceKind(gate, deviceType, role)
  }
  if (companions.some(hasCap)) return true
  if (deviceType === undefined || (gate?.deviceTypes?.length ?? 0) === 0) return false
  return capAppliesToDeviceKind(gate, deviceType, role)
}
