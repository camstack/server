/**
 * What an Amcrest camera declares as its identity (D1059): the `getSystemInfo`
 * serial (`amcrest:<serial>`), the MAC of the interface serving its host
 * (`resolveMac`), and the host itself (weak). A serial or MAC that was not read
 * — the read failed, or answered without it — is `unread`: neither ever
 * legitimately disappears, so the stored value is kept (D49).
 *
 * Only channel 1 declares the serial and MAC: on a recorder every channel answers
 * with the recorder's own, so a channel past the first declares neither (and drops
 * one stored before), keeping only its host.
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@dominevo/types'

export interface AmcrestIdentityRead {
  readonly serialNumber: string | null
  /** Null when the network read failed or found no MAC. */
  readonly mac: string | null
  readonly host: string
  /** The device's channel on the unit (1 for a camera, 1…N on a recorder). */
  readonly channel: number
}

export interface AmcrestIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function amcrestIdentifiers(read: AmcrestIdentityRead): AmcrestIdentifierDeclaration {
  if (read.channel !== 1) {
    return { identifiers: { serial: null, mac: null, host: read.host }, unread: [] }
  }
  const serial = read.serialNumber?.trim() ?? ''
  const mac = read.mac?.trim() ?? ''
  return {
    identifiers: {
      serial: serial.length > 0 ? { manufacturer: 'Amcrest', serial } : null,
      mac: mac.length > 0 ? mac : null,
      host: read.host,
    },
    unread: [
      ...(serial.length > 0 ? [] : (['serial'] as const)),
      ...(mac.length > 0 ? [] : (['mac'] as const)),
    ],
  }
}
