/**
 * Velux integrations are `connections` records (planning#416, D1007): the rows move into the
 * record with their API key, the addon's runtime reads the record, and nothing reads the legacy
 * rows afterwards.
 */
import {
  defineAddonMigrations,
  integrationRowsMigration,
  integrationRowsPortsOver,
  makeInMemoryRecords,
} from '@camstack/types'
import { REDACTED_SECRET } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { VeluxLoginRefusedError } from '../velux-client-contract.js'
import { buildVeluxConnectionTestProvider } from '../velux-connection-test.js'
import {
  buildVeluxInstances,
  veluxConnectionOf,
  veluxConnectionsEntryKind,
  veluxRecordKinds,
} from '../velux-instances.js'

const ADDON = 'provider-velux'
const MARK_HOST = '192.0.2.65'
const SECRET = 'velux-password-the-spec-must-see-again'

async function world() {
  const mem = makeInMemoryRecords(ADDON)
  await mem.records.declare(veluxRecordKinds)
  const rows = new Map<string, Record<string, unknown>>([
    [
      'int_0001',
      {
        host: MARK_HOST,
        password: SECRET,
      },
    ],
  ])
  const cleared: string[] = []
  const api = {
    list: async () => [{ id: 'int_0001', addonId: ADDON, name: 'Gateway' }],
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
        kind: veluxConnectionsEntryKind,
        fixtureMark: 'host',
      }),
    ],
    integrationRowsPortsOver({
      api,
      records: mem.records,
      kind: veluxConnectionsEntryKind,
      warn: () => undefined,
    }),
  )
  if (migration === undefined) throw new Error('no migration')
  // A gateway that accepts exactly one password; records every login it was asked for.
  const seen: Array<{ host: string; password: string }> = []
  const probe = async (input: { host: string; password: string }) => {
    seen.push(input)
    if (input.password !== SECRET) throw new VeluxLoginRefusedError()
    return { firmware: '2.0.0.71' }
  }
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  const tester = buildVeluxConnectionTestProvider({ logger: logger as never, probe })
  const instances = buildVeluxInstances(mem.records, { onChanged: async () => undefined, tester })
  return { mem, rows, cleared, migration, instances, seen }
}

describe('velux integration instances', () => {
  it('moves the marked field and the API key into the record and clears the rows', async () => {
    const w = await world()

    const result = await w.migration.execute()

    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const read = await veluxConnectionOf(w.instances, 'int_0001')
    expect(read).toEqual({ host: MARK_HOST, password: SECRET })
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
    expect(await veluxConnectionOf(w.instances, 'int_0009')).toBeNull()
    expect(await veluxConnectionOf(w.instances, 'int_0404')).toBeNull()
  })
})

describe('velux testInstance', () => {
  it('offers the Test action', async () => {
    const w = await world()
    expect((await w.instances.describe()).canTest).toBe(true)
  })

  it('a stored instance is tested with its keychain password when the form does not retype it', async () => {
    const w = await world()
    await w.migration.execute()
    const result = await w.instances.testInstance({
      id: 'int_0001',
      values: { host: MARK_HOST, password: REDACTED_SECRET },
    })
    expect(result).toMatchObject({ success: true, status: 'validated' })
    expect(w.seen.at(-1)).toEqual({ host: MARK_HOST, password: SECRET })
  })

  it('a draft with a wrong password is rejected', async () => {
    const w = await world()
    const result = await w.instances.testInstance({
      id: null,
      values: { host: MARK_HOST, password: 'wrong' },
    })
    expect(result).toMatchObject({ success: false, status: 'rejected' })
    expect(w.seen.at(-1)).toEqual({ host: MARK_HOST, password: 'wrong' })
  })
})
