import {
  type FlattenRowPorts,
  type IntegrationRowsApi,
  type KeychainResolveResult,
  type MigrationApiV1,
} from '@camstack/types'
import { z } from 'zod'
import { alexaBrokersEntryKind } from '../broker-record-kinds.js'
import { echoRecordPortsOver } from '../speak/echo-store.js'
import { alexaBrokerLinkPorts } from './broker-links-to-connections.js'
import type { AlexaMigrationPorts } from './index.js'
import { alexaIntegrationRowsPorts } from './integration-rows-to-record.js'
import { type PositionalRecordsDoor, positionalRecordsOver } from './records-door.js'

/** The slice of the migration API these ports use. */
export type AlexaPortsApi = Pick<
  MigrationApiV1,
  'settings' | 'secrets' | 'log' | 'records' | 'integrations' | 'legacyRows'
>

const NESTED_MAX = 1000

/** The registry list and the migration-only rows door, over the migration API. */
function integrationRowsApiOver(
  api: Pick<MigrationApiV1, 'integrations' | 'legacyRows'>,
): IntegrationRowsApi {
  return {
    list: async () => (await api.integrations.list({})).integrations,
    readLegacyIntegrationRows: (input) => api.legacyRows.read(input),
    clearLegacyIntegrationRows: (input) => api.legacyRows.clear(input),
  }
}

/** The keychain handle of the migration API: resolve and delete, owner-scoped by the transport. */
function secretsOver(api: Pick<MigrationApiV1, 'secrets'>) {
  return {
    resolve: async (refs: readonly string[]): Promise<KeychainResolveResult> => {
      const { values } = await api.secrets.resolve({ refs: [...refs] })
      const out: KeychainResolveResult = {}
      for (const ref of refs) {
        const value = values[ref]
        // The migration API returns no version and the result type requires one.
        out[ref] =
          value === null || value === undefined
            ? { kind: 'missing' }
            : { kind: 'value', value, version: 0 }
      }
      return out
    },
    delete: async (refs: readonly string[]): Promise<number> =>
      (await api.secrets.delete({ refs: [...refs] })).deleted,
  }
}

/** The Echo targets kept in the addon's `echoTargets` setting, read and written as stored. */
export function echoSettingPortsOver(api: Pick<MigrationApiV1, 'settings'>) {
  return {
    readRows: async (): Promise<readonly unknown[]> => {
      const { store } = await api.settings.read({})
      const rows = store['echoTargets']
      return Array.isArray(rows) ? rows : []
    },
    // Written as given: a row that does not parse stays where it is, never dropped on a guess (D49).
    writeRows: async (rows: readonly unknown[]): Promise<void> => {
      await api.settings.write({ patch: { echoTargets: [...rows] } })
    },
  }
}

/** The broker rows' flatten ports over the records door. */
function flattenPortsOverDoor(records: PositionalRecordsDoor): FlattenRowPorts {
  const handle = records.kind({
    name: alexaBrokersEntryKind.name,
    declaration: alexaBrokersEntryKind.declaration,
    schema: z.record(z.string(), z.unknown()),
  })
  return {
    listNested: async (legacyKey) =>
      (await handle.query({ limit: NESTED_MAX })).records
        .filter((row) => legacyKey in row.data)
        .map((row) => row.id),
    readResolved: async (id) => {
      const row = await handle.getResolved(id)
      if (row === null) throw new Error('the record is gone')
      return row.data
    },
    patch: async (id, patch) => {
      await handle.patch(id, patch)
    },
  }
}

/**
 * The catalogue's ports over {@link MigrationApiV1}, and nothing else (planning#447): the addon's
 * own settings store (the Echo rows), its keychain handle, the legacy integration rows door and its
 * broker, connection and Echo target records.
 */
export function alexaPortsOver(api: AlexaPortsApi): AlexaMigrationPorts {
  const records = positionalRecordsOver(api)
  const warn = (message: string): void => {
    void api.log.warn({ message })
  }
  return {
    ...echoSettingPortsOver(api),
    ...flattenPortsOverDoor(records),
    ...alexaBrokerLinkPorts(records, warn),
    ...echoRecordPortsOver(records, {
      warn: (message, extras) => {
        void api.log.warn({
          message,
          ...(extras?.meta === undefined ? {} : { meta: extras.meta }),
        })
      },
    }),
    ...alexaIntegrationRowsPorts({
      api: integrationRowsApiOver(api),
      records,
      secrets: secretsOver(api),
      warn,
    }),
  }
}
