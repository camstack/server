import {
  type MigrationApiV1,
  type MigrationRecordRowV1,
  resolveSecretMarkers,
  type StoredKeyRead,
} from '@camstack/types'
import type { plainWasteSourceKind, WasteSourceBody } from '../waste-source-record-kinds.js'
import type { wasteSourceEntryKind } from '../waste-source-record-kinds.js'
import { bodyOf, rowToSource } from '../waste-source-store.js'
import type { WasteSourcePorts } from './sources-from-settings.js'

const PAGE = 1000

/** The slice of the migration API these ports use. */
export type WastePortsApi = Pick<MigrationApiV1, 'settings' | 'secrets' | 'log' | 'records'>

export type WasteSourceKindDefinition = typeof wasteSourceEntryKind | typeof plainWasteSourceKind

/**
 * The sources migration's ports over {@link MigrationApiV1}, and nothing else (planning#447): the
 * addon's own settings store, its keychain handle and its `waste-source` record kind.
 */
export function wasteSourcePortsOver(
  api: WastePortsApi,
  kind: WasteSourceKindDefinition,
): WasteSourcePorts {
  const handle = api.records.kind(kind)
  const secrets = {
    resolve: async (refs: readonly string[]) => {
      const { values } = await api.secrets.resolve({ refs: [...refs] })
      return Object.fromEntries(
        refs.map((ref) => {
          const value = values[ref]
          return [
            ref,
            value === null || value === undefined
              ? { kind: 'missing' as const }
              : { kind: 'value' as const, value, version: 0 },
          ]
        }),
      )
    },
  }
  const readStored = async (key: string): Promise<StoredKeyRead> => {
    let store: Readonly<Record<string, unknown>>
    try {
      store = (await api.settings.read({})).store
    } catch (err: unknown) {
      return {
        kind: 'unreadable',
        reason: 'store-read-failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }
    if (!Object.hasOwn(store, key)) return { kind: 'absent' }
    // A credential the keychain cannot serve stays a marker: the step refuses it by name.
    const { value } = await resolveSecretMarkers(store[key], secrets, { unresolved: 'keep-marker' })
    return { kind: 'present', value }
  }
  const asRow = (row: MigrationRecordRowV1<WasteSourceBody>) => rowToSource(row.id, row.data)
  return {
    readStored,
    listSourceIds: async () => (await handle.query({ limit: PAGE })).records.map((row) => row.id),
    putSource: async (source) => {
      if ((await handle.get({ id: source.id })) !== null) return
      await handle.put({ id: source.id, data: bodyOf(source), ifRev: 0 })
    },
    readSource: async (id) => {
      const stored = await handle.get({ id })
      if (stored === null) return null
      try {
        const resolved = await handle.getResolved({ id })
        return asRow(resolved ?? stored)
      } catch {
        // The keychain could not serve a credential: the markers come back and the step refuses.
        return asRow(stored)
      }
    },
    warn: (message) => {
      void api.log.warn({ message })
    },
  }
}
