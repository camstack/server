import type { AddonMigration } from '@camstack/types'
import {
  type LocationSecretPorts,
  moveLocationSecretsToRecords,
} from './location-secrets-to-record.js'

export type {
  LegacyLocationRow,
  LegacySecretRead,
  LocationSecretPorts,
  MovedLocationRow,
} from './location-secrets-to-record.js'

export const STORAGE_ORCHESTRATOR_ID = 'storage-orchestrator'
export const RESEED_PRUNED_DEFAULTS_ID = 'storage-orchestrator/2026-11-04-reseed-pruned-defaults'
export const LOCATION_SECRETS_TO_RECORD_ID =
  'storage-orchestrator/2026-11-07-location-secrets-to-record'

/** What the repair may do: ask the service to re-create the defaults a prune removed. */
export interface ReseedPorts {
  /** Re-seed every declared type whose seed marker survived the loss of all its rows; returns the types restored. */
  reseed(): readonly string[]
}

/** Every body of the catalogue reads through ONE port object, so the addon binds it once. */
export type StorageCataloguePorts = ReseedPorts & LocationSecretPorts

export const RESEED_PRUNED_DEFAULTS_MIGRATION: AddonMigration<ReseedPorts> = {
  meta: {
    id: RESEED_PRUNED_DEFAULTS_ID,
    owner: STORAGE_ORCHESTRATOR_ID,
    level: 'addon-state',
    seq: 1,
    dependsOn: [],
    store: 'settings',
    scope: 'cluster',
    // `block-owner` would stop the storage orchestrator, and with it the settings store, from
    // booting over a repair of a default location. A repair that did not run leaves the
    // alert on the Alerts panel; the operator loses nothing the bug had not already taken.
    onFailure: 'tolerate',
    bodyKind: 'procedure',
    description:
      'Re-create the default storage location of a declared type whose seed marker survived the 2026-11-01 prune with no rows left',
    fixtureMark:
      'a type that still has its row and its seed marker, which the repair must not touch',
  },
  procedure: async (ports) => {
    const types = ports.reseed()
    return {
      outcome: types.length > 0 ? 'done' : 'already-done',
      summary: { types: [...types] },
    }
  },
}

export const LOCATION_SECRETS_TO_RECORD_MIGRATION: AddonMigration<LocationSecretPorts> = {
  meta: {
    id: LOCATION_SECRETS_TO_RECORD_ID,
    owner: STORAGE_ORCHESTRATOR_ID,
    level: 'addon-state',
    seq: 2,
    dependsOn: [],
    store: 'settings',
    scope: 'cluster',
    // A location whose credential was not moved would be served with a marker nobody resolves
    // once the old refs are gone; the step refuses before it writes, and holds its dependents.
    onFailure: 'block-owner',
    bodyKind: 'procedure',
    description:
      "Move each storage location's credentials from the per-row keychain refs into the location's own record",
    fixtureMark:
      'a location row that carries no credential (a drain row, recordings:default), which the move must not touch',
  },
  procedure: moveLocationSecretsToRecords,
}

/** The `storage-orchestrator` catalogue (D987), declared whole every time and run by id. */
export const ADDON_MIGRATIONS: readonly AddonMigration<StorageCataloguePorts>[] = [
  RESEED_PRUNED_DEFAULTS_MIGRATION,
  LOCATION_SECRETS_TO_RECORD_MIGRATION,
]
