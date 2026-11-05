/**
 * Unifi integrations are `connections` records (planning#416, D1007): the rows move into the
 * record with their API key, the addon's runtime reads the record, and nothing reads the legacy
 * rows afterwards.
 */
import {
  defineAddonMigrations,
  integrationRowsMigration,
  integrationRowsPortsOver,
  makeInMemoryRecords,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildUnifiInstances,
  unifiConnectionOf,
  unifiConnectionsEntryKind,
  unifiRecordKinds,
} from '../unifi-instances.js'

const ADDON = 'provider-unifi'
const MARK_HOST = 'controller-marked-by-the-spec.example'
const PASSWORD = 'unifi-password-the-spec-must-see-again'
const SECRET = 'unifi-api-key-the-spec-must-see-again'

async function world() {
  const mem = makeInMemoryRecords(ADDON)
  await mem.records.declare(unifiRecordKinds)
  const rows = new Map<string, Record<string, unknown>>([
    [
      'int_0001',
      {
        host: MARK_HOST,
        port: 8443,
        apiKey: SECRET,
        username: 'admin',
        password: PASSWORD,
        site: 'marked-site',
        allowSelfSigned: true,
        pollIntervalMs: 20_000,
      },
    ],
  ])
  const cleared: string[] = []
  const api = {
    list: async () => [{ id: 'int_0001', addonId: ADDON, name: 'Controller' }],
    readLegacyIntegrationRows: async ({ integrationId: id }: { integrationId: string }) => ({
      ...rows.get(id),
    }),
    clearLegacyIntegrationRows: async ({ integrationId: id }: { integrationId: string }) => {
      cleared.push(id)
      rows.set(id, {})
    },
  }
  const [migration] = defineAddonMigrations(
    [
      integrationRowsMigration({
        addonId: ADDON,
        date: '2026-11-05',
        kind: unifiConnectionsEntryKind,
        fixtureMark: 'host',
      }),
    ],
    integrationRowsPortsOver({
      api,
      records: mem.records,
      kind: unifiConnectionsEntryKind,
      warn: () => undefined,
    }),
  )
  if (migration === undefined) throw new Error('no migration')
  const instances = buildUnifiInstances(mem.records, { onChanged: async () => undefined })
  return { mem, rows, cleared, migration, instances }
}

describe('unifi integration instances', () => {
  it('moves the marked field and the API key into the record and clears the rows', async () => {
    const w = await world()

    const result = await w.migration.execute()

    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const read = await unifiConnectionOf(w.instances, 'int_0001')
    expect(read?.credentialsLocked).toBe(false)
    expect(read?.connection).toMatchObject({
      host: MARK_HOST,
      port: 8443,
      apiKey: SECRET,
      username: 'admin',
      password: PASSWORD,
      site: 'marked-site',
      allowSelfSigned: true,
      pollIntervalMs: 20_000,
    })
    const stored = JSON.stringify(w.mem.tables.get('connections')?.get('int_0001')?.data)
    expect(stored).not.toContain(SECRET)
    expect(stored).not.toContain(PASSWORD)
    expect(w.cleared).toEqual(['int_0001'])
    expect(w.rows.get('int_0001')).toEqual({})
    expect(await w.migration.execute()).toMatchObject({ result: { outcome: 'already-done' } })
  })

  it('reads no connection from a record without a host', async () => {
    const w = await world()
    await w.instances.createInstance({ id: 'int_0009', name: 'Empty' })
    expect(await unifiConnectionOf(w.instances, 'int_0009')).toBeNull()
    expect(await unifiConnectionOf(w.instances, 'int_0404')).toBeNull()
  })
})
