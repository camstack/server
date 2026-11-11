/**
 * A device's KIND is its type plus its role (D1033): the type is the set of
 * controls it has, the role says which thing it is among the devices that
 * share those controls. A plug-in heater is a `switch` with role
 * `switch-heater`; an air conditioner and a radiator valve are both `climate`,
 * told apart by their `climate-*` role.
 */
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

/** The `climate-*` roles, in the order the role picker lists them. */
export const CLIMATE_ROLES: readonly DeviceRole[] = [
  DeviceRole.ClimateThermostat,
  DeviceRole.ClimateAc,
  DeviceRole.ClimateRadiator,
  DeviceRole.ClimateFloor,
  DeviceRole.ClimateHeater,
  DeviceRole.ClimateHeatPumpCircuit,
]

export type ClimateRole =
  | DeviceRole.ClimateThermostat
  | DeviceRole.ClimateAc
  | DeviceRole.ClimateRadiator
  | DeviceRole.ClimateFloor
  | DeviceRole.ClimateHeater
  | DeviceRole.ClimateHeatPumpCircuit

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

/** The part of a capability definition that says which devices it is offered on. */
export interface DeviceKindGate {
  readonly deviceTypes?: readonly DeviceType[]
  readonly deviceRoles?: Readonly<Partial<Record<DeviceType, readonly DeviceRole[]>>>
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
