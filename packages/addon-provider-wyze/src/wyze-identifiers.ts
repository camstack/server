/**
 * What a Wyze camera declares as its identity (D1059): the hardware MAC the
 * cloud lists it by (strong) and its last-known LAN IP (weak). A blank value
 * was not reported, so the stored one is kept (D49).
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@camstack/types'

export interface WyzeIdentityRead {
  readonly mac: string
  readonly ip: string
}

export interface WyzeIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function wyzeIdentifiers(read: WyzeIdentityRead): WyzeIdentifierDeclaration {
  const mac = read.mac.trim()
  const ip = read.ip.trim()
  const unread: DeviceIdentifierKey[] = []
  if (mac === '') unread.push('mac')
  if (ip === '') unread.push('ip')
  return {
    identifiers: { mac: mac === '' ? null : mac, ip: ip === '' ? null : ip },
    unread,
  }
}
