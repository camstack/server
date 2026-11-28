/**
 * What a Kia vehicle declares as its identity (D1059): the maker cloud's vehicle id, as a
 * `vendor-uid` (`kia:<id>`). The cloud assigns it once per vehicle. The VIN is deliberately not
 * the identity: it is personal data and the cloud id is as stable. A blank id declares nothing,
 * so the stored value is kept (D49).
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@dominevo/types'

export interface KiaIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function kiaIdentifiers(cloudId: string): KiaIdentifierDeclaration | null {
  const id = cloudId.trim()
  if (id === '') return null
  return { identifiers: { vendorUid: { vendor: 'kia', id } }, unread: [] }
}
