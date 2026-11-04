/**
 * Tuya integrations are `connections` records (planning#416, D1007): the rows move into the
 * record with their Access Secret, the addon's runtime reads the record, and nothing reads the
 * legacy rows afterwards.
 */
import {
  defineAddonMigrations,
  integrationRowsMigration,
  integrationRowsPortsOver,
  makeInMemoryRecords,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildTuyaInstances,
  tuyaConnectionOf,
  tuyaConnectionsEntryKind,
  tuyaRecordKinds,
} from '../tuya-instances.js'

const ADDON = 'provider-tuya'
const MARK_ID = 'access-id-marked-by-the-spec'
const SECRET = 'tuya-secret-the-spec-must-see-again'

async function world() {
  const mem = makeInMemoryRecords(ADDON)
  await mem.records.declare(tuyaRecordKinds)
  const rows = new Map<string, Record<string, unknown>>([
    [
      'int_0001',
      { accessId: MARK_ID, accessSecret: SECRET, region: 'us', discoveryTimeoutMs: 9000 },
    ],
  ])
  const cleared: string[] = []
  const api = {
    list: async () => [{ id: 'int_0001', addonId: ADDON, name: 'Home' }],
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
        kind: tuyaConnectionsEntryKind,
        fixtureMark: 'accessId',
      }),
    ],
    integrationRowsPortsOver({
      api,
      records: mem.records,
      kind: tuyaConnectionsEntryKind,
      warn: () => undefined,
    }),
  )
  if (migration === undefined) throw new Error('no migration')
  const instances = buildTuyaInstances(mem.records, { onChanged: async () => undefined })
  return { mem, rows, cleared, migration, instances }
}

describe('tuya integration instances', () => {
  it('moves the marked field and the Access Secret into the record and clears the rows', async () => {
    const w = await world()

    const result = await w.migration.execute()

    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    expect(await tuyaConnectionOf(w.instances, 'int_0001')).toMatchObject({
      accessId: MARK_ID,
      accessSecret: SECRET,
      region: 'us',
      discoveryTimeoutMs: 9000,
    })
    expect(JSON.stringify(w.mem.tables.get('connections')?.get('int_0001')?.data)).not.toContain(
      SECRET,
    )
    expect(w.cleared).toEqual(['int_0001'])
    expect(w.rows.get('int_0001')).toEqual({})
    expect(await w.migration.execute()).toMatchObject({ result: { outcome: 'already-done' } })
  })

  it('reads no connection from a record without credentials', async () => {
    const w = await world()
    await w.instances.createInstance({ id: 'int_0009', name: 'Empty' })
    expect(await tuyaConnectionOf(w.instances, 'int_0009')).toBeNull()
    expect(await tuyaConnectionOf(w.instances, 'int_0404')).toBeNull()
  })
})
