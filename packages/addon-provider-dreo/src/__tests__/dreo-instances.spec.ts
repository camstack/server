/**
 * Dreo integrations are `connections` records (planning#416, D1007): the rows move into the
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
  buildDreoInstances,
  dreoConnectionOf,
  dreoConnectionsEntryKind,
  dreoRecordKinds,
} from '../dreo-instances.js'

const ADDON = 'provider-dreo'
const MARK_EMAIL = 'marked@spec.example'
const SECRET = 'dreo-password-the-spec-must-see-again'

async function world() {
  const mem = makeInMemoryRecords(ADDON)
  await mem.records.declare(dreoRecordKinds)
  const rows = new Map<string, Record<string, unknown>>([
    [
      'int_0001',
      {
        email: MARK_EMAIL,
        password: SECRET,
        region: 'eu',
      },
    ],
  ])
  const cleared: string[] = []
  const api = {
    list: async () => [{ id: 'int_0001', addonId: ADDON, name: 'Account' }],
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
        kind: dreoConnectionsEntryKind,
        fixtureMark: 'email',
      }),
    ],
    integrationRowsPortsOver({
      api,
      records: mem.records,
      kind: dreoConnectionsEntryKind,
      warn: () => undefined,
    }),
  )
  if (migration === undefined) throw new Error('no migration')
  const instances = buildDreoInstances(mem.records, {
    onChanged: async () => undefined,
    tester: { testSettings: async () => ({ outcome: 'validated' }) },
  })
  return { mem, rows, cleared, migration, instances }
}

describe('dreo integration instances', () => {
  it('moves the marked field and the API key into the record and clears the rows', async () => {
    const w = await world()

    const result = await w.migration.execute()

    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const read = await dreoConnectionOf(w.instances, 'int_0001')
    expect(read).toEqual({ email: MARK_EMAIL, password: SECRET, region: 'eu' })
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
    expect(await dreoConnectionOf(w.instances, 'int_0009')).toBeNull()
    expect(await dreoConnectionOf(w.instances, 'int_0404')).toBeNull()
  })
})
