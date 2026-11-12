import { DeviceRole, DeviceType, resolveDeviceControlKind } from '@camstack/types'
import type { ReactElement } from 'react'
import {
  useDeviceManagerGetBindings,
  useDeviceManagerGetDevice,
} from '../../../generated/system-hooks'
import { ConnectedClimateCard } from './ConnectedClimateCard'
import { ConnectedCoverCard } from './ConnectedCoverCard'
import { ConnectedFanCard } from './ConnectedFanCard'
import { ConnectedHeaterCard } from './ConnectedHeaterCard'
import { ConnectedLightCard } from './ConnectedLightCard'
import { type ConnectedCardProps, ConnectedPlugCard } from './ConnectedPlugCard'

/** The scenes a real device can be drawn with today. */
export type ConnectedCardKind = 'plug' | 'climate' | 'cover' | 'light' | 'fan' | 'heater'

/** `pending` until both the device and its bindings answered; `null` = no card for it. */
export type ConnectedCardResolution = ConnectedCardKind | 'pending' | null

/** Either draws the climate card: a radiator valve that only reports is still one. */
const CLIMATE_CAPS: readonly string[] = ['climate-control', 'heating-valve']

/**
 * Which card draws a device, from what it IS (type + role, D1033) and what it
 * binds. Power is always the `switch` cap (D1042): a switch is a plug, or a
 * heater / a fan by its role; a light and a fan need it too. A cover needs
 * `cover`.
 */
export function connectedCardKindOf(
  deviceType: string | null,
  role: string | null | undefined,
  capNames: readonly string[],
): ConnectedCardKind | null {
  if (deviceType === null) return null
  const control = resolveDeviceControlKind(deviceType, role)
  const hasSwitch = capNames.includes('switch')
  if (deviceType === DeviceType.Switch) {
    if (!hasSwitch) return null
    if (control === 'heater') return 'heater'
    if (role === DeviceRole.SwitchFan) return 'fan'
    return control === 'switch' ? 'plug' : null
  }
  if (control === 'light') return hasSwitch ? 'light' : null
  if (control === 'fan') return hasSwitch ? 'fan' : null
  if (control === 'cover') return capNames.includes('cover') ? 'cover' : null
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
  }
}
