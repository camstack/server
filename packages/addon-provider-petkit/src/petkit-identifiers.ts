/**
 * What a PetKit feeder declares as its identity (D1059): the PetKit cloud device id, as a
 * `vendor-uid` (`petkit:<id>`). The vendor cloud assigns it once per device and
 * never reuses it. The API gives no MAC or serial this integration reads. A blank
 * id declares nothing, so the stored value is kept (D49).
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@camstack/types'

export interface PetkitIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function petkitIdentifiers(cloudId: string): PetkitIdentifierDeclaration | null {
  const id = cloudId.trim()
  if (id === '') return null
  return { identifiers: { vendorUid: { vendor: 'petkit', id } }, unread: [] }
}
