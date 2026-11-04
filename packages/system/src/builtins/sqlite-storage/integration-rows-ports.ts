/**
 * The system-side ports of `moveIntegrationRowsToRecords` (planning#416): the legacy
 * `integration_settings` rows are read through the registry and their secrets resolved through the
 * integration's OWNER keychain door (never exposed further), and cleared together with their
 * keychain values. The addon's own record kind is reached through its records handle.
 */
import {
  type IntegrationRowsPorts,
  type RecordKindHandle,
  resolveSecretMarkers,
  type RowsMigrationLog,
  RevConflictError,
  type SecretsAccess,
} from '@camstack/types'
import type { IntegrationRegistry } from './integration-registry.js'

export interface IntegrationRowsPortsDeps {
  readonly registry: Pick<
    IntegrationRegistry,
    'listIntegrations' | 'getIntegrationSettings' | 'clearIntegrationSettings'
  >
  /** The OWNER addon's keychain handle, or null when there is no keychain. */
  readonly secrets: SecretsAccess | null
  readonly records: RecordKindHandle<Record<string, unknown>>
  readonly log: RowsMigrationLog
}

export interface ClearIntegrationRowsDeps {
  readonly registry: Pick<
    IntegrationRegistry,
    'getIntegrationSettings' | 'clearIntegrationSettings'
  >
  /** The OWNER addon's keychain handle, or null when there is no keychain. */
  readonly secrets: SecretsAccess | null
}

/**
 * The hub-side "clear rows" operation: delete one integration's legacy setting rows AND the
 * keychain values they pointed at. The integration itself stays. A rerun on cleared rows is a
 * no-op. Counts only; never a value.
 */
export async function clearIntegrationRows(
  deps: ClearIntegrationRowsDeps,
  integrationId: string,
): Promise<{ readonly rows: number; readonly secrets: number }> {
  const rows = Object.keys(await deps.registry.getIntegrationSettings(integrationId)).length
  const refs = await deps.registry.clearIntegrationSettings(integrationId)
  if (refs.length > 0 && deps.secrets !== null) await deps.secrets.delete(refs)
  return { rows, secrets: refs.length }
}

export function integrationRowsPortsOver(deps: IntegrationRowsPortsDeps): IntegrationRowsPorts {
  return {
    warn: (message) => deps.log.warn(message),
    listIntegrations: async (addonId) =>
      (await deps.registry.listIntegrations())
        .filter((i) => i.addonId === addonId)
        .map((i) => ({ id: i.id, name: i.name })),
    readRows: async (integrationId) => {
      const stored = await deps.registry.getIntegrationSettings(integrationId)
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
      await clearIntegrationRows(deps, integrationId)
    },
  }
}
