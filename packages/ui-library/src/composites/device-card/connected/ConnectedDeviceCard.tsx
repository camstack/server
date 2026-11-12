import { DeviceRole, DeviceType, isSwitchLight, resolveDeviceControlKind } from '@camstack/types'
import type { ReactElement } from 'react'
import {
  useDeviceManagerGetBindings,
  useDeviceManagerGetDevice,
} from '../../../generated/system-hooks'
import { ConnectedApplianceCard } from './ConnectedApplianceCard'
import { ConnectedClimateCard } from './ConnectedClimateCard'
import { ConnectedCoverCard } from './ConnectedCoverCard'
import { ConnectedDishwasherCard } from './ConnectedDishwasherCard'
import { ConnectedFanCard } from './ConnectedFanCard'
import { ConnectedHeaterCard } from './ConnectedHeaterCard'
import { ConnectedHeatPumpCard } from './ConnectedHeatPumpCard'
import { ConnectedLightCard } from './ConnectedLightCard'
import { ConnectedMediaCard } from './ConnectedMediaCard'
import { type ConnectedCardProps, ConnectedPlugCard } from './ConnectedPlugCard'
import { ConnectedMowerCard, ConnectedVacuumCard } from './ConnectedRobotCard'
import { ConnectedWaterHeaterCard } from './ConnectedWaterHeaterCard'

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
  | 'water-heater'

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
 * a heat pump needs `heat-pump-status`, a water heater `water-heater`.
 */
export function connectedCardKindOf(
  deviceType: string | null,
  role: string | null | undefined,
  capNames: readonly string[],
): ConnectedCardKind | null {
  if (deviceType === null) return null
  if (deviceType === DeviceType.HeatPump)
    return capNames.includes('heat-pump-status') ? 'heat-pump' : null
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
  return null
}

/** Resolves the card of a device; a failed read answers `null` so the caller falls back. */
export function useConnectedCardKind(deviceId: number): ConnectedCardResolution {
  const device = useDeviceManagerGetDevice({ deviceId })
  const bindings = useDeviceManagerGetBindings({ deviceId })
  if (device.status === 'pending' || bindings.status === 'pending') return 'pending'
  if (device.status === 'error' || bindings.status === 'error') return null
  return connectedCardKindOf(
    device.data?.type ?? null,
    device.data?.role ?? null,
    bindings.data.entries.map((entry) => entry.capName),
  )
}

export interface ConnectedDeviceCardProps extends ConnectedCardProps {
  readonly kind: ConnectedCardKind
}

/** The card of a real device, by scene. */
export function ConnectedDeviceCard({
  kind,
  ...props
}: ConnectedDeviceCardProps): ReactElement | null {
  switch (kind) {
    case 'plug':
      return <ConnectedPlugCard {...props} />
    case 'climate':
      return <ConnectedClimateCard {...props} />
    case 'cover':
      return <ConnectedCoverCard {...props} />
    case 'light':
      return <ConnectedLightCard {...props} />
    case 'fan':
      return <ConnectedFanCard {...props} />
    case 'heater':
      return <ConnectedHeaterCard {...props} />
    case 'appliance':
      return <ConnectedApplianceCard {...props} />
    case 'dishwasher':
      return <ConnectedDishwasherCard {...props} />
    case 'media':
      return <ConnectedMediaCard {...props} />
    case 'vacuum':
      return <ConnectedVacuumCard {...props} />
    case 'mower':
      return <ConnectedMowerCard {...props} />
    case 'heat-pump':
      return <ConnectedHeatPumpCard {...props} />
    case 'water-heater':
      return <ConnectedWaterHeaterCard {...props} />
  }
}
