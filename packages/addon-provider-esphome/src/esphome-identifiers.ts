/**
 * What an ESPHome board declares as its identity (D1059): the MAC its DeviceInfo
 * reports, and its node name, which ESPHome uses as the board's mDNS hostname
 * (weak). A DeviceInfo without a MAC (not reported) keeps the stored one (D49);
 * a board that is not connected declares nothing.
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@dominevo/types'
import type { EspBoardInfo } from './esphome-link.js'

export interface EspIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function espBoardIdentifiers(info: EspBoardInfo | null): EspIdentifierDeclaration | null {
  if (info === null) return null
  const mac = info.macAddress.trim()
  const name = info.name.trim()
  const unread: DeviceIdentifierKey[] = [
    ...(mac.length === 0 ? (['mac'] as const) : []),
    ...(name.length === 0 ? (['hostname'] as const) : []),
  ]
  return {
    identifiers: { mac: mac.length > 0 ? mac : null, hostname: name.length > 0 ? name : null },
    unread,
  }
}
