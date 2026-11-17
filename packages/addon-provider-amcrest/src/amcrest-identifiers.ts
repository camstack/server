/**
 * What an Amcrest camera declares as its identity (D1059): the `getSystemInfo`
 * serial (`amcrest:<serial>`), the MAC of the interface serving its host
 * (`resolveMac`), and the host itself (weak). A serial or MAC that was not read
 * — the read failed, or answered without it — is `unread`: neither ever
 * legitimately disappears, so the stored value is kept (D49).
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@camstack/types'

export interface AmcrestIdentityRead {
  readonly serialNumber: string | null
  /** Null when the network read failed or found no MAC. */
  readonly mac: string | null
  readonly host: string
}

export interface AmcrestIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function amcrestIdentifiers(read: AmcrestIdentityRead): AmcrestIdentifierDeclaration {
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
