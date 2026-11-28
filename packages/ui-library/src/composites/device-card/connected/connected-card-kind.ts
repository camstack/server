import { DeviceRole, DeviceType, isSwitchLight, resolveDeviceControlKind } from '@dominevo/types'
import { type CapCardKind, capCardKindOf } from './cap-card-kinds'

/** The scenes a real device can be drawn with today. */
export type ConnectedCardKind =
  | 'plug'
  | 'climate'
  | 'cover'
  | 'light'
  | 'fan'
  | 'heater'
  | 'appliance'
  | 'dishwasher'
  | 'media'
  | 'vacuum'
  | 'mower'
  | 'heat-pump'
  | 'energy'
  | 'water-heater'
  | 'ir-transmitter'
  | CapCardKind

/** `pending` until both the device and its bindings answered; `null` = no card for it. */
export type ConnectedCardResolution = ConnectedCardKind | 'pending' | null

/** Either draws the climate card: a radiator valve that only reports is still one. */
const CLIMATE_CAPS: readonly string[] = ['climate-control', 'heating-valve']

/**
 * Which card draws a device, from what it IS (type + role, D1033) and what it
 * binds. Power is always the `switch` cap (D1042): a switch is a plug, or a
 * heater / a fan / an on/off light by its role; a light and a fan need it too. A cover needs
 * `cover`. A washer / dryer / dishwasher known only by its supply is the
 * appliance card (`running-state` or `switch`); a dishwasher that speaks for
 * itself (`dishwasher`), a media player, a vacuum and a mower need their cap;
 * a heat pump needs `heat-pump-status`, an energy system `energy-system`, a
 * water heater `water-heater`; the types with one cap of their own (lock,
 * alarm, valve …) are in `cap-card-kinds`.
 */
export function connectedCardKindOf(
  deviceType: string | null,
  role: string | null | undefined,
  capNames: readonly string[],
): ConnectedCardKind | null {
  if (deviceType === null) return null
  const byCap = capCardKindOf(deviceType, role, capNames)
  if (byCap !== undefined) return byCap
  if (deviceType === DeviceType.HeatPump)
    return capNames.includes('heat-pump-status') ? 'heat-pump' : null
  if (deviceType === DeviceType.EnergySystem)
    return capNames.includes('energy-system') ? 'energy' : null
  const control = resolveDeviceControlKind(deviceType, role)
  const hasSwitch = capNames.includes('switch')
  if (deviceType === DeviceType.Switch) {
    if (!hasSwitch) return null
    if (control === 'heater') return 'heater'
    if (role === DeviceRole.SwitchFan) return 'fan'
    if (isSwitchLight(deviceType, role)) return 'light'
    return control === 'switch' ? 'plug' : null
  }
  if (control === 'light') return hasSwitch ? 'light' : null
  if (control === 'fan') return hasSwitch ? 'fan' : null
  if (control === 'cover') return capNames.includes('cover') ? 'cover' : null
  const fedBySupply = hasSwitch || capNames.includes('running-state')
  if (control === 'dishwasher') {
    if (capNames.includes('dishwasher')) return 'dishwasher'
    return fedBySupply ? 'appliance' : null
  }
  if (control === 'appliance') return fedBySupply ? 'appliance' : null
  if (control === 'media-player') return capNames.includes('media-player') ? 'media' : null
  if (control === 'vacuum') return capNames.includes('vacuum-control') ? 'vacuum' : null
  if (control === 'water-heater') return capNames.includes('water-heater') ? 'water-heater' : null
  if (control === 'lawn-mower') return capNames.includes('lawn-mower-control') ? 'mower' : null
  if (
    (control === 'thermostat' || control === 'climate') &&
    CLIMATE_CAPS.some((cap) => capNames.includes(cap))
  )
    return 'climate'
  if (capNames.includes('ir-transmitter')) return 'ir-transmitter'
  return null
}
