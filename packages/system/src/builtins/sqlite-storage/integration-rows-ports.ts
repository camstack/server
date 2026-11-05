/**
 * The system-side ports of `moveIntegrationRowsToRecords` (planning#416). The leftover rows are
 * read on the settings connection by the migration-only door, and their secrets are resolved
 * through the integration's OWNER keychain handle (never exposed further) and cleared together
 * with the rows. The addon's own record kind is reached through its records handle.
 */
import {
  type IntegrationRowsPorts,
  type RecordKindHandle,
  resolveSecretMarkers,
  type RowsMigrationLog,
  RevConflictError,
  type SecretsAccess,
  collectSecretMarkerRefs,
} from '@camstack/types'
import {
  clearLegacyIntegrationRows,
  readLegacyIntegrationRows,
} from './migrations/legacy-integration-rows-door.js'
import type { MigrationDatabase } from './migrations/migration-types.js'

export interface IntegrationRowsPortsDeps {
  readonly db: MigrationDatabase
  /** The OWNER addon's keychain handle, or null when there is no keychain. */
  readonly secrets: SecretsAccess | null
  readonly records: RecordKindHandle<Record<string, unknown>>
  readonly log: RowsMigrationLog
  readonly listIntegrations: (
    addonId: string,
  ) => Promise<readonly { readonly id: string; readonly name: string }[]>
}

/**
 * Delete one integration's leftover rows AND the keychain values they pointed at (values first,
 * so a failed delete leaves the rows to retry). A missing store is a no-op. Counts only.
 */
export async function clearIntegrationRows(
  db: MigrationDatabase,
  secrets: SecretsAccess | null,
  integrationId: string,
): Promise<{ readonly rows: number; readonly secrets: number }> {
  const stored = readLegacyIntegrationRows(db, integrationId)
  const refs = collectSecretMarkerRefs(stored)
  if (refs.length > 0 && secrets !== null) await secrets.delete(refs)
  return clearLegacyIntegrationRows(db, integrationId)
}

export function integrationRowsPortsOver(deps: IntegrationRowsPortsDeps): IntegrationRowsPorts {
  return {
    warn: (message) => deps.log.warn(message),
    listIntegrations: (addonId) => deps.listIntegrations(addonId),
    readRows: async (integrationId) => {
      const stored = readLegacyIntegrationRows(deps.db, integrationId)
      if (deps.secrets === null) return stored
      const { value, unresolved } = await resolveSecretMarkers(stored, deps.secrets)
      if (unresolved.length > 0) {
        throw new Error(`${unresolved.length} secret(s) cannot be read from the keychain`)
      }
      return value
    },
    putRecord: async (id, body) => {
      if ((await deps.records.get(id)) !== null) return 'exists'
      try {
        await deps.records.put({ id, data: body }, { ifRev: 0 })
      } catch (err: unknown) {
        if (err instanceof RevConflictError) return 'exists'
        throw err
      }
      return 'created'
    },
    readRecord: async (id) => (await deps.records.getResolved(id))?.data ?? null,
    deleteRecord: async (id) => {
      await deps.records.delete(id)
    },
    clearRows: async (integrationId) => {
      await clearIntegrationRows(deps.db, deps.secrets, integrationId)
    },
  }
}
