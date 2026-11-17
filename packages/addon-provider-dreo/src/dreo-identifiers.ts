/**
 * What a Dreo appliance declares as its identity (D1059): the Dreo cloud device id, as a
 * `vendor-uid` (`dreo:<id>`). The vendor cloud assigns it once per device and
 * never reuses it. The API gives no MAC or serial this integration reads. A blank
 * id declares nothing, so the stored value is kept (D49).
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@camstack/types'

export interface DreoIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function dreoIdentifiers(cloudId: string): DreoIdentifierDeclaration | null {
  const id = cloudId.trim()
  if (id === '') return null
  return { identifiers: { vendorUid: { vendor: 'dreo', id } }, unread: [] }
}
