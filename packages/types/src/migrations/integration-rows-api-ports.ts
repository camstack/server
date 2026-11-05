/**
 * The addon-side ports of `moveIntegrationRowsToRecords` (planning#416). An addon runs the move
 * from its own process, so the leftover rows are reached through the migration-only door
 * (`migrations.readLegacyIntegrationRows` / `clearLegacyIntegrationRows`) on the hub's connection.
 * The door returns markers. This process is the owner, so it resolves and releases them with
 * `resolveSecretMarkers` — the same call the old settings door used — and only then asks the
 * door to delete the rows. The addon's own record kind is its records handle.
 */
import { collectSecretMarkerRefs, resolveSecretMarkers } from '../addon/secret-settings-view.js'
import type { SecretsAccess } from '../keychain/secrets-access.js'
import { RevConflictError } from '../records/errors.js'
import type { RecordKindHandle } from '../records/records-access.js'
import type { IntegrationRowsPorts, RowsMigrationLog } from './integration-rows-to-record.js'

/** The slice of `ctx.api` the move needs: the registry list, and the migration-only door. */
export interface IntegrationRowsApi {
  list(): Promise<
    readonly {
      readonly id: string
      readonly addonId: string
      readonly name: string
      readonly info?: Readonly<Record<string, unknown>> | null | undefined
    }[]
  >
  readLegacyIntegrationRows(input: {
    readonly integrationId: string
  }): Promise<Readonly<Record<string, unknown>>>
  clearLegacyIntegrationRows(input: { readonly integrationId: string }): Promise<unknown>
}

async function resolvedRows(
  stored: Readonly<Record<string, unknown>>,
  secrets: SecretsAccess | null,
): Promise<Readonly<Record<string, unknown>>> {
  if (secrets === null) return stored
  const { value, unresolved } = await resolveSecretMarkers(stored, secrets)
  if (unresolved.length > 0) {
    throw new Error(`${unresolved.length} secret(s) cannot be read from the keychain`)
  }
  return value
}

export function integrationRowsPortsOverApi(deps: {
  readonly api: IntegrationRowsApi
  readonly records: RecordKindHandle<Record<string, unknown>>
  readonly log: RowsMigrationLog
  /** The owning addon's keychain handle. Null leaves markers unresolved. */
  readonly secrets?: SecretsAccess | null
}): IntegrationRowsPorts {
  const secrets = deps.secrets ?? null
  return {
    warn: (message) => deps.log.warn(message),
    listIntegrations: async (addonId) =>
      (await deps.api.list())
        .filter((i) => i.addonId === addonId)
        .map((i) => ({ id: i.id, name: i.name })),
    readRows: async (integrationId) =>
      resolvedRows(await deps.api.readLegacyIntegrationRows({ integrationId }), secrets),
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
      // Values first: a failed delete leaves the rows, so the next run retries them.
      const stored = await deps.api.readLegacyIntegrationRows({ integrationId })
      const refs = collectSecretMarkerRefs(stored)
      if (refs.length > 0 && secrets !== null) await secrets.delete(refs)
      await deps.api.clearLegacyIntegrationRows({ integrationId })
    },
  }
}
