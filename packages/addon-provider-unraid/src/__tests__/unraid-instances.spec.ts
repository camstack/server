/**
 * Unraid integrations are `connections` records (planning#416, D1007): the rows move into the
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
  buildUnraidInstances,
  unraidConnectionOf,
  unraidConnectionsEntryKind,
  unraidRecordKinds,
} from '../unraid-instances.js'

const ADDON = 'provider-unraid'
const MARK_HOST = 'tower-marked-by-the-spec.example'
const SECRET = 'unraid-api-key-the-spec-must-see-again'

async function world() {
  const mem = makeInMemoryRecords(ADDON)
  await mem.records.declare(unraidRecordKinds)
  const rows = new Map<string, Record<string, unknown>>([
    [
      'int_0001',
      {
        host: MARK_HOST,
        port: 8443,
        https: false,
        allowSelfSigned: true,
        apiKey: SECRET,
        pollIntervalMs: 20_000,
      },
    ],
  ])
  const cleared: string[] = []
  const api = {
    list: async () => [{ id: 'int_0001', addonId: ADDON, name: 'Tower' }],
    getSettings: async ({ id }: { id: string }) => ({ ...rows.get(id) }),
    clearSettings: async ({ id }: { id: string }) => {
      cleared.push(id)
      rows.set(id, {})
    },
  }
  const [migration] = defineAddonMigrations(
    [
      integrationRowsMigration({
        addonId: ADDON,
        date: '2026-11-05',
        kind: unraidConnectionsEntryKind,
        fixtureMark: 'host',
      }),
    ],
    integrationRowsPortsOver({
      api,
      records: mem.records,
      kind: unraidConnectionsEntryKind,
      warn: () => undefined,
    }),
  )
  if (migration === undefined) throw new Error('no migration')
  const instances = buildUnraidInstances(mem.records, { onChanged: async () => undefined })
  return { mem, rows, cleared, migration, instances }
}

describe('unraid integration instances', () => {
  it('moves the marked field and the API key into the record and clears the rows', async () => {
    const w = await world()

    const result = await w.migration.execute()

    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const read = await unraidConnectionOf(w.instances, 'int_0001')
    expect(read?.apiKeyLocked).toBe(false)
    expect(read?.connection).toMatchObject({
      host: MARK_HOST,
      port: 8443,
      https: false,
      allowSelfSigned: true,
      apiKey: SECRET,
      pollIntervalMs: 20_000,
    })
    expect(JSON.stringify(w.mem.tables.get('connections')?.get('int_0001')?.data)).not.toContain(
      SECRET,
    )
    expect(w.cleared).toEqual(['int_0001'])
    expect(w.rows.get('int_0001')).toEqual({})
    expect(await w.migration.execute()).toMatchObject({ result: { outcome: 'already-done' } })
  })

  it('reads no connection from a record without a host', async () => {
    const w = await world()
    await w.instances.createInstance({ id: 'int_0009', name: 'Empty' })
    expect(await unraidConnectionOf(w.instances, 'int_0009')).toBeNull()
    expect(await unraidConnectionOf(w.instances, 'int_0404')).toBeNull()
  })
})
