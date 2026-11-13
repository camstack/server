import type { HmDevice } from 'nodehomematic'
import { hmName } from '../devices/hm-name.js'

/** What the CCU calls a channel and its device, for a link row. */
export interface HmChannelNames {
  readonly channelName: string | null
  readonly deviceName: string | null
  readonly deviceType: string | null
}

/** The device part of a `DEVICE:index` channel address. */
export function deviceAddressOf(channelAddress: string): string {
  const idx = channelAddress.lastIndexOf(':')
  return idx === -1 ? channelAddress : channelAddress.slice(0, idx)
}

/**
 * Resolve CCU names for channel addresses against the facade's device list.
 * A channel the CCU does not know (a foreign interface, a virtual key) has no
 * names, never its address in their place.
 */
export function channelNameLookup(
  devices: readonly HmDevice[],
): (channelAddress: string) => HmChannelNames {
  const byAddress = new Map(devices.map((device) => [device.address, device]))
  return (channelAddress) => {
    const device = byAddress.get(deviceAddressOf(channelAddress))
    if (device === undefined) return { channelName: null, deviceName: null, deviceType: null }
    const channel = device.channels.find((candidate) => candidate.address === channelAddress)
    return {
      channelName: channel === undefined ? null : hmName(channel.name),
      deviceName: hmName(device.name),
      deviceType: device.type,
    }
  }
}
