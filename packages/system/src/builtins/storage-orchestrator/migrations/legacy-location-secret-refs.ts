/**
 * The keychain refs a storage location's credentials were filed under BEFORE they moved into the
 * location's own record (`row/storage_locations/<id>`). Only the migration
 * `storage-orchestrator/2026-11-07-location-secrets-to-record` reads this shape.
 */
import { buildSecretRef, isSecretMarker, parseSecretRef, type SecretMarker } from '@camstack/types'
import { STORAGE_RECORD_OWNER } from '../location-secret-refs.js'

/** The keychain collection of the legacy per-row refs (the table it was named for is gone). */
const LEGACY_LOCATION_SECRET_COLLECTION = 'storage_locations'

/** The ref a credential of `id` was filed under before the move to the record. */
export function legacyLocationSecretRef(id: string, key: string): string {
  return buildSecretRef({
    owner: STORAGE_RECORD_OWNER,
    scope: {
      kind: 'row',
      collection: LEGACY_LOCATION_SECRET_COLLECTION,
      rowId: id,
    },
    fieldPath: key,
  })
}

/**
 * Is `value` a marker the migration has to move: a keychain marker of THIS location's legacy
 * collection. Anything else (a record-bound marker, someone else's ref) is left alone.
 */
export function isLegacyLocationMarker(id: string, value: unknown): value is SecretMarker {
  if (!isSecretMarker(value)) return false
  const parts = parseSecretRef(value.$secret)
  if (parts === null || parts.scope.kind !== 'row') return false
  return parts.scope.collection === LEGACY_LOCATION_SECRET_COLLECTION && parts.scope.rowId === id
}
