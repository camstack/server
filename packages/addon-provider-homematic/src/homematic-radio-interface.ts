import type { HmDevice } from 'nodehomematic'

/**
 * Which radio interface a device or an event belongs to, read from the library's
 * own data-point id (`<central>-<interface>:<channel>:<paramset>:<parameter>`,
 * lowercased), never from the shape of the address: a wired device carries an
 * address that looks like a radio one. Virtual devices, groups and anything the
 * id does not name belong to no radio.
 */
export type RadioInterface = 'HmIP-RF' | 'BidCos-RF'

/** The radio interface a data-point id belongs to, or `null`. */
export function radioInterfaceOfDataPointId(id: string): RadioInterface | null {
  const owner = (id.split(':')[0] ?? '').toLowerCase()
  if (owner.endsWith('-hmip-rf')) return 'HmIP-RF'
  if (owner.endsWith('-bidcos-rf')) return 'BidCos-RF'
  return null
}

/** The radio interface of a device (all its data points share one), or `null` when it has none. */
export function radioInterfaceOfDevice(device: Pick<HmDevice, 'channels'>): RadioInterface | null {
  for (const channel of device.channels) {
    for (const point of channel.dataPoints) return radioInterfaceOfDataPointId(point.id)
  }
  return null
}
