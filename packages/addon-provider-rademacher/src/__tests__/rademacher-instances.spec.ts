import {
  defineAddonMigrations,
  type IntegrationRowsApi,
  makeInMemoryRecords,
  type MigrationOwnerResult,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  buildRademacherInstances,
  RADEMACHER_MIGRATIONS,
  RADEMACHER_ROWS_TO_RECORD_ID,
  rademacherConnectionOf,
  rademacherRecordKinds,
  rademacherRowsPorts,
} from '../rademacher-instances.js'

const PASSWORD = 'hub-pw-CANARY-91'
const INTEGRATION = {
  id: 'int_0001',
  addonId: 'provider-rademacher',
  name: 'Attic hub',
}

/** The legacy rows with a marked field (`basePath`), a secret and a key nothing reads. */
const ROWS = {
  host: '192.0.2.7',
  password: PASSWORD,
  basePath: '/hp',
  pollIntervalMs: 45000,
  stale: 'x',
}

async function world() {
  const rows = new Map<string, Record<string, unknown>>([[INTEGRATION.id, { ...ROWS }]])
  const warnings: string[] = []
  const mem = makeInMemoryRecords('provider-rademacher')
  await mem.records.declare(rademacherRecordKinds)
  const api: IntegrationRowsApi = {
    list: async () => [INTEGRATION],
    readLegacyIntegrationRows: async ({ integrationId: id }) => ({ ...rows.get(id) }),
    clearLegacyIntegrationRows: async ({ integrationId: id }) => {
      rows.set(id, {})
    },
  }
  const ports = rademacherRowsPorts({
    api,
    records: mem.records,
    warn: (m) => warnings.push(m),
  })
  const run = async (): Promise<readonly MigrationOwnerResult[]> => {
    const bound = defineAddonMigrations(RADEMACHER_MIGRATIONS, ports)
    return Promise.all(bound.map((m) => m.execute()))
  }
  return { rows, warnings, mem, run }
}

describe('rademacher integration rows move to a record', () => {
  it('the record holds every field and the password; the rows are gone; a rerun is a no-op', async () => {
    const w = await world()
    expect(RADEMACHER_MIGRATIONS.map((m) => m.meta.id)).toEqual([RADEMACHER_ROWS_TO_RECORD_ID])
    await w.run()

    const handle = w.mem.records.kind(rademacherRecordKinds.connections)
    const record = (await handle.getResolved(INTEGRATION.id))?.data
    expect(record).toEqual({
      name: 'Attic hub',
      host: '192.0.2.7',
      password: PASSWORD,
      basePath: '/hp',
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
    const instances = buildRademacherInstances(w.mem.records, {
      onChanged: async () => undefined,
      tester: {
        testSettings: async () => ({ outcome: 'validated' }),
      },
    })
    expect(await rademacherConnectionOf(instances, INTEGRATION.id)).toEqual({
      host: '192.0.2.7',
      password: PASSWORD,
      basePath: '/hp',
      pollIntervalMs: 45000,
    })
    expect(await rademacherConnectionOf(instances, 'int_9999')).toBeNull()
  })
})
