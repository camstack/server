import {
  defineAddonMigrations,
  type IntegrationRowsApi,
  makeInMemoryRecords,
  type MigrationOwnerResult,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildDreameInstances,
  DREAME_MIGRATIONS,
  DREAME_ROWS_TO_RECORD_ID,
  dreameConnectionOf,
  dreameRecordKinds,
  dreameRowsPorts,
} from '../dreame-instances.js'

const PASSWORD = 'acct-pw-CANARY-91'
const INTEGRATION = {
  id: 'int_0001',
  addonId: 'provider-dreame',
  name: 'Home account',
}

/** The legacy rows with a marked field (`basePath`), a secret and a key nothing reads. */
const ROWS = {
  username: 'marked@example.com',
  password: PASSWORD,
  region: 'us',
  pollIntervalMs: 45000,
  stale: 'x',
}

async function world() {
  const rows = new Map<string, Record<string, unknown>>([[INTEGRATION.id, { ...ROWS }]])
  const warnings: string[] = []
  const mem = makeInMemoryRecords('provider-dreame')
  await mem.records.declare(dreameRecordKinds)
  const api: IntegrationRowsApi = {
    list: async () => [INTEGRATION],
    getSettings: async ({ id }) => ({ ...rows.get(id) }),
    clearSettings: async ({ id }) => {
      rows.set(id, {})
    },
  }
  const ports = dreameRowsPorts({
    api,
    records: mem.records,
    warn: (m) => warnings.push(m),
  })
  const run = async (): Promise<readonly MigrationOwnerResult[]> => {
    const bound = defineAddonMigrations(DREAME_MIGRATIONS, ports)
    return Promise.all(bound.map((m) => m.execute()))
  }
  return { rows, warnings, mem, run }
}

describe('dreame integration rows move to a record', () => {
  it('the record holds every field and the password; the rows are gone; a rerun is a no-op', async () => {
    const w = await world()
    expect(DREAME_MIGRATIONS.map((m) => m.meta.id)).toEqual([DREAME_ROWS_TO_RECORD_ID])
    await w.run()

    const handle = w.mem.records.kind(dreameRecordKinds.connections)
    const record = (await handle.getResolved(INTEGRATION.id))?.data
    expect(record).toEqual({
      name: 'Home account',
      username: 'marked@example.com',
      password: PASSWORD,
      region: 'us',
      pollIntervalMs: 45000,
    })
    expect(w.rows.get(INTEGRATION.id)).toEqual({})
    expect(w.warnings.join(' ')).toContain('stale')
    expect(JSON.stringify([...(w.mem.tables.get('connections')?.values() ?? [])])).not.toContain(
      PASSWORD,
    )

    const again = await w.run()
    expect(JSON.stringify(again)).not.toContain('"done"')
  })

  it('the runtime reads the connection from the record, password included', async () => {
    const w = await world()
    await w.run()
    const instances = buildDreameInstances(w.mem.records, {
      onChanged: async () => undefined,
      tester: {
        describeTest: async () => ({ label: 'x' }),
        testSettings: async () => ({ outcome: 'validated' }),
      },
    })
    expect(await dreameConnectionOf(instances, INTEGRATION.id)).toEqual({
      username: 'marked@example.com',
      password: PASSWORD,
      region: 'us',
      pollIntervalMs: 45000,
    })
    expect(await dreameConnectionOf(instances, 'int_9999')).toBeNull()
  })
})
