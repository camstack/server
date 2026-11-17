/**
 * What a Tuya device declares as its identity (D1059): the Tuya cloud device id (`devId`), as a
 * `vendor-uid` (`tuya:<id>`). The vendor cloud assigns it once per device and
 * never reuses it. The API gives no MAC or serial this integration reads. A blank
 * id declares nothing, so the stored value is kept (D49).
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@camstack/types'

export interface TuyaIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function tuyaIdentifiers(cloudId: string): TuyaIdentifierDeclaration | null {
  const id = cloudId.trim()
  if (id === '') return null
  return { identifiers: { vendorUid: { vendor: 'tuya', id } }, unread: [] }
}
