import { DeviceType } from '@camstack/types'
import type { ReactElement } from 'react'
import {
  useDeviceManagerGetBindings,
  useDeviceManagerGetDevice,
} from '../../../generated/system-hooks'
import { ConnectedClimateCard } from './ConnectedClimateCard'
import { type ConnectedCardProps, ConnectedPlugCard } from './ConnectedPlugCard'

/** The scenes a real device can be drawn with today. */
export type ConnectedCardKind = 'plug' | 'climate'

/** `pending` until both the device and its bindings answered; `null` = no card for it. */
export type ConnectedCardResolution = ConnectedCardKind | 'pending' | null

/** Either draws the climate card: a radiator valve that only reports is still one. */
const CLIMATE_CAPS: readonly string[] = ['climate-control', 'heating-valve']
const CLIMATE_TYPES: ReadonlySet<string> = new Set([DeviceType.Thermostat, DeviceType.Climate])

/** Which card draws a device, from what it IS and what it binds. */
export function connectedCardKindOf(
  deviceType: string | null,
  capNames: readonly string[],
): ConnectedCardKind | null {
  if (deviceType === DeviceType.Switch && capNames.includes('switch')) return 'plug'
  if (
    deviceType !== null &&
    CLIMATE_TYPES.has(deviceType) &&
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
  return kind === 'plug' ? <ConnectedPlugCard {...props} /> : <ConnectedClimateCard {...props} />
}
