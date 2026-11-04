/**
 * The addon-side ports of `moveIntegrationRowsToRecords` (planning#416): an addon runs the move
 * from its own process, so the legacy rows are reached through the hub (`ctx.api.integrations`:
 * `list`, `getSettings` - which answers the OWNER its secrets resolved - and `clearSettings`) and
 * the new record through the addon's own records handle. The hub deletes the rows and their
 * keychain values; the addon never touches the registry.
 */
import { RevConflictError } from '../records/errors.js'
import type { RecordKindHandle } from '../records/records-access.js'
import type { IntegrationRowsPorts, RowsMigrationLog } from './integration-rows-to-record.js'

/** The slice of `ctx.api.integrations` the move needs. */
export interface IntegrationRowsApi {
  list(): Promise<
    readonly { readonly id: string; readonly addonId: string; readonly name: string }[]
  >
  getSettings(input: { readonly id: string }): Promise<Readonly<Record<string, unknown>>>
  clearSettings(input: { readonly id: string }): Promise<unknown>
}

export function integrationRowsPortsOverApi(deps: {
  readonly api: IntegrationRowsApi
  readonly records: RecordKindHandle<Record<string, unknown>>
  readonly log: RowsMigrationLog
}): IntegrationRowsPorts {
  return {
    warn: (message) => deps.log.warn(message),
    listIntegrations: async (addonId) =>
      (await deps.api.list())
        .filter((i) => i.addonId === addonId)
        .map((i) => ({ id: i.id, name: i.name })),
    readRows: (integrationId) => deps.api.getSettings({ id: integrationId }),
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
      await deps.api.clearSettings({ id: integrationId })
    },
  }
}
