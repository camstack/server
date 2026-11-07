/**
 * Where a storage location's credentials live (planning#440 step 6, D879, D987).
 *
 * A credential is a keychain value bound to the location's OWN record: the body's `secrets` map
 * (`secrets{password}`) is what the records door stores, so deleting the row deletes the value and
 * one location's credential is never another's. Before this, the credential was filed under
 * `row/storage_locations/<id>` and the row's `config` held the marker; those refs are the LEGACY
 * ones the migration `storage-orchestrator/2026-11-07-location-secrets-to-record` moves.
 *
 * The in-memory location still carries a marker per credential in `config` (the orchestrator
 * resolves it through `ctx.secrets` when a provider needs the value); the marker built here is the
 * one the records door itself wrote, so both ends agree without a read.
 */
import {
  isSecretMarker,
  makeSecretMarker,
  recordSecretRef,
  type SecretMarker,
} from '@camstack/types'

/** The addon id the records door and the keychain both file this owner's values under. */
export const STORAGE_RECORD_OWNER = 'storage-orchestrator'

/** The record kind the locations live in (`record-kinds.ts`). */
export const LOCATIONS_RECORD_KIND = 'locations'

/** The body field that holds the credentials, by config key. */
export const LOCATION_SECRETS_FIELD = 'secrets'

/** The ref the records door files the credential `key` of location `id` under. */
export function locationSecretRef(id: string, key: string): string {
  return recordSecretRef(
    STORAGE_RECORD_OWNER,
    LOCATIONS_RECORD_KIND,
    id,
    `${LOCATION_SECRETS_FIELD}{${encodeURIComponent(key)}}`,
  )
}

/** The marker the location carries in memory for a credential kept in its record. */
export function locationSecretMarker(id: string, key: string): SecretMarker {
  return makeSecretMarker(locationSecretRef(id, key))
}

/** Is `value` the marker of the credential `key` of location `id` kept in its own record? */
export function isOwnLocationMarker(id: string, key: string, value: unknown): boolean {
  return isSecretMarker(value) && value.$secret === locationSecretRef(id, key)
}
