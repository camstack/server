import {
  defineAddonMigrations,
  type IntegrationRowsApi,
  makeInMemoryRecords,
  type MigrationOwnerResult,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildPetkitInstances,
  PETKIT_MIGRATIONS,
  PETKIT_ROWS_TO_RECORD_ID,
  petkitConnectionOf,
  petkitRecordKinds,
  petkitRowsPorts,
} from '../petkit-instances.js'

const PASSWORD = 'acct-pw-CANARY-91'
const INTEGRATION = {
  id: 'int_0001',
  addonId: 'provider-petkit',
  name: 'Family account',
}

/** The legacy rows with a marked field (`basePath`), a secret and a key nothing reads. */
const ROWS = {
  email: 'marked@example.com',
  password: PASSWORD,
  region: 'us',
  timezone: 'Europe/Rome',
  pollIntervalMs: 45000,
  stale: 'x',
}

async function world() {
  const rows = new Map<string, Record<string, unknown>>([[INTEGRATION.id, { ...ROWS }]])
  const warnings: string[] = []
  const mem = makeInMemoryRecords('provider-petkit')
  await mem.records.declare(petkitRecordKinds)
  const api: IntegrationRowsApi = {
    list: async () => [INTEGRATION],
    getSettings: async ({ id }) => ({ ...rows.get(id) }),
    clearSettings: async ({ id }) => {
      rows.set(id, {})
    },
  }
  const ports = petkitRowsPorts({
    api,
    records: mem.records,
    warn: (m) => warnings.push(m),
  })
  const run = async (): Promise<readonly MigrationOwnerResult[]> => {
    const bound = defineAddonMigrations(PETKIT_MIGRATIONS, ports)
    return Promise.all(bound.map((m) => m.execute()))
  }
  return { rows, warnings, mem, run }
}

describe('petkit integration rows move to a record', () => {
  it('the record holds every field and the password; the rows are gone; a rerun is a no-op', async () => {
    const w = await world()
    expect(PETKIT_MIGRATIONS.map((m) => m.meta.id)).toEqual([PETKIT_ROWS_TO_RECORD_ID])
    await w.run()

    const handle = w.mem.records.kind(petkitRecordKinds.connections)
    const record = (await handle.getResolved(INTEGRATION.id))?.data
    expect(record).toEqual({
      name: 'Family account',
      email: 'marked@example.com',
      password: PASSWORD,
      region: 'us',
      timezone: 'Europe/Rome',
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
    const instances = buildPetkitInstances(w.mem.records, {
      onChanged: async () => undefined,
      tester: {
        describeTest: async () => ({ label: 'x' }),
        testSettings: async () => ({ outcome: 'validated' }),
      },
    })
    expect(await petkitConnectionOf(instances, INTEGRATION.id)).toEqual({
      email: 'marked@example.com',
      password: PASSWORD,
      region: 'us',
      timezone: 'Europe/Rome',
      pollIntervalMs: 45000,
    })
    expect(await petkitConnectionOf(instances, 'int_9999')).toBeNull()
  })
})
