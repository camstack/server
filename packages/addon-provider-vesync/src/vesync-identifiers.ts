/**
 * What a VeSync purifier declares as its identity (D1059): its cloud device id
 * (`vendor-uid` `vesync:<cid>`) and the MAC its device-list entry carries. An
 * entry without a MAC (not reported) keeps the stored one (D49); no snapshot
 * declares nothing.
 */
import type { DeviceIdentifierKey, RawDeviceIdentifiers } from '@camstack/types'
import type { VeSyncPurifierSnapshot } from './vesync-client-contract.js'

export type VeSyncIdentityRead = Pick<VeSyncPurifierSnapshot, 'nativeId' | 'mac'>

export interface VeSyncIdentifierDeclaration {
  readonly identifiers: RawDeviceIdentifiers
  readonly unread: readonly DeviceIdentifierKey[]
}

export function vesyncIdentifiers(
  read: VeSyncIdentityRead | null,
): VeSyncIdentifierDeclaration | null {
  if (read === null) return null
  return {
    identifiers: {
      vendorUid: { vendor: 'vesync', id: read.nativeId },
      mac: read.mac ?? null,
    },
    unread: read.mac === undefined ? ['mac'] : [],
  }
}
