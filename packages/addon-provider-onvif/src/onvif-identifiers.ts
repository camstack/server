/**
 * What an ONVIF camera declares as its identity (D1059): its serial, prefixed by
 * the manufacturer its `GetDeviceInformation` reports; the MACs of its
 * `GetNetworkInterfaces` answer; and the host it is reached at (weak). A read
 * that failed — or answered without the value, which never legitimately
 * disappears — is `unread`, so the stored value is kept (D49).
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@camstack/types'
import { z } from 'zod'

/** The `GetDeviceInformation` fields used here. */
export interface OnvifDeviceIdentity {
  readonly manufacturer: string
  readonly serialNumber: string
}

export interface OnvifIdentityRead {
  /** Null when `GetDeviceInformation` failed. */
  readonly deviceInfo: OnvifDeviceIdentity | null
  /** Null when `GetNetworkInterfaces` failed. */
  readonly macs: readonly string[] | null
  readonly host: string
}

export interface OnvifIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function onvifIdentifiers(read: OnvifIdentityRead): OnvifIdentifierDeclaration {
  const serial = read.deviceInfo?.serialNumber.trim() ?? ''
  const manufacturer = read.deviceInfo?.manufacturer.trim() ?? ''
  const hasSerial = serial.length > 0 && manufacturer.length > 0
  const macs = read.macs ?? []
  return {
    identifiers: {
      serial: hasSerial ? { manufacturer, serial } : null,
      mac: macs,
      host: read.host,
    },
    unread: [
      ...(hasSerial ? [] : (['serial'] as const)),
      ...(macs.length > 0 ? [] : (['mac'] as const)),
    ],
  }
}

const interfaceSchema = z.object({
  info: z.object({ hwAddress: z.string().optional() }).partial().optional(),
})

/**
 * The MACs of a `getNetworkInterfaces` answer as the `onvif` library hands it over
 * (camel-cased by its `linerase`, a lone interface not wrapped in an array). Anything
 * else reads as no MAC.
 */
export function parseOnvifMacs(raw: unknown): readonly string[] {
  const list = Array.isArray(raw) ? raw : [raw]
  const macs: string[] = []
  for (const item of list) {
    const parsed = interfaceSchema.safeParse(item)
    const mac = parsed.success ? parsed.data.info?.hwAddress?.trim() : undefined
    if (mac !== undefined && mac.length > 0) macs.push(mac)
  }
  return macs
}
