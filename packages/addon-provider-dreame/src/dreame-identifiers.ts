/**
 * What a Dreame robot declares as its identity (D1059): the Dreame cloud device id (`did`), as a
 * `vendor-uid` (`dreame:<id>`). The vendor cloud assigns it once per device and
 * never reuses it. The API gives no MAC or serial this integration reads. A blank
 * id declares nothing, so the stored value is kept (D49).
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@camstack/types'

export interface DreameIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function dreameIdentifiers(cloudId: string): DreameIdentifierDeclaration | null {
  const id = cloudId.trim()
  if (id === '') return null
  return { identifiers: { vendorUid: { vendor: 'dreame', id } }, unread: [] }
}
