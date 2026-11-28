/**
 * What a Gree AC declares as its identity (D1059): the MAC its bind answered
 * with (persisted as `greeMac`, the durable identity) and its last-known LAN IP
 * (weak). An AC whose address was never learnt keeps the stored IP (D49).
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@dominevo/types'

export interface GreeIdentityRead {
  readonly mac: string
  readonly ip: string | undefined
}

export interface GreeIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function greeIdentifiers(read: GreeIdentityRead): GreeIdentifierDeclaration {
  const ip = read.ip?.trim() ?? ''
  return {
    identifiers: { mac: read.mac, ip: ip === '' ? null : ip },
    unread: ip === '' ? ['ip'] : [],
  }
}
