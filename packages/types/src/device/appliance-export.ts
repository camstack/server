/**
 * How a washer, dryer or dishwasher leaves CamStack.
 *
 * Home Assistant has no laundry domain: the device is offered, and what
 * travels is its power reading. The others have a laundry type that this
 * export cannot honour yet, so they are named and withheld.
 */
import { DeviceType } from './device-type.js'

export type PlugApplianceType = DeviceType.Washer | DeviceType.Dryer | DeviceType.Dishwasher

export const PLUG_APPLIANCE_TYPES: readonly PlugApplianceType[] = [
  DeviceType.Washer,
  DeviceType.Dryer,
  DeviceType.Dishwasher,
]

export interface ApplianceExported {
  readonly exported: true
  /** What the other ecosystem actually receives. */
  readonly as: string
}

export interface ApplianceNotExported {
  readonly exported: false
  readonly reason: string
}

export type ApplianceExportDecision = ApplianceExported | ApplianceNotExported

export type ApplianceExportEcosystem = 'ha' | 'homekit' | 'alexa' | 'google' | 'matter'

const HA_AS =
  'a power sensor (device_class power). Home Assistant has no laundry domain. running-state stays unexported until a null reading can be published as unavailable.'

const HOMEKIT_REASON =
  'HomeKit has no laundry-appliance service. The export tab would pair an accessory with nothing on it: running-state is withheld until a null reading can be unavailable, and power is not a HomeKit service this export honours.'

const ALEXA_REASON =
  'Alexa has no laundry category in this export, and neither power nor running has an Alexa interface.'

const GOOGLE_REASON =
  'Google WASHER, DRYER and DISHWASHER require RunCycle. A power threshold is not that trait, and this export does not publish RunCycle.'

const MATTER_REASON =
  'No Matter export is built. The closest device types are Laundry Washer (0x0073) and Laundry Dryer (0x0074); a power threshold is not the Laundry Washer Mode cluster.'

function withheld(reason: string): Readonly<Record<PlugApplianceType, ApplianceNotExported>> {
  return {
    [DeviceType.Washer]: { exported: false, reason },
    [DeviceType.Dryer]: { exported: false, reason },
    [DeviceType.Dishwasher]: { exported: false, reason },
  }
}

function offered(received: string): Readonly<Record<PlugApplianceType, ApplianceExported>> {
  return {
    [DeviceType.Washer]: { exported: true, as: received },
    [DeviceType.Dryer]: { exported: true, as: received },
    [DeviceType.Dishwasher]: { exported: true, as: received },
  }
}

export const APPLIANCE_EXPORT: Readonly<
  Record<ApplianceExportEcosystem, Readonly<Record<PlugApplianceType, ApplianceExportDecision>>>
> = {
  ha: offered(HA_AS),
  homekit: withheld(HOMEKIT_REASON),
  alexa: withheld(ALEXA_REASON),
  google: withheld(GOOGLE_REASON),
  matter: withheld(MATTER_REASON),
}

export function isPlugApplianceType(deviceType: string): deviceType is PlugApplianceType {
  return PLUG_APPLIANCE_TYPES.some((type) => type === deviceType)
}

/** The decision for this ecosystem, or null when the type is not an appliance. */
export function applianceExport(
  ecosystem: ApplianceExportEcosystem,
  deviceType: string,
): ApplianceExportDecision | null {
  if (!isPlugApplianceType(deviceType)) return null
  return APPLIANCE_EXPORT[ecosystem][deviceType]
}
