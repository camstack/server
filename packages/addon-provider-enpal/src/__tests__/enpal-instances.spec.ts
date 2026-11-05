/**
 * Enpal integrations are `connections` records (planning#416, D1007): the rows move into the
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
  buildEnpalInstances,
  enpalConnectionOf,
  enpalConnectionsEntryKind,
  enpalRecordKinds,
} from '../enpal-instances.js'

const ADDON = 'provider-enpal'
const MARK_HOST = '192.0.2.77'
const SECRET = 'enpal-token-the-spec-must-see-again'

async function world() {
  const mem = makeInMemoryRecords(ADDON)
  await mem.records.declare(enpalRecordKinds)
  const rows = new Map<string, Record<string, unknown>>([
    [
      'int_0001',
      {
        host: MARK_HOST,
        source: 'influx',
        influxPort: 8087,
        org: 'marked-org',
        bucket: 'marked_bucket',
        token: SECRET,
        pagePort: 8080,
        pollIntervalMs: 20_000,
        invertBatteryPower: true,
      },
    ],
  ])
  const cleared: string[] = []
  const api = {
    list: async () => [{ id: 'int_0001', addonId: ADDON, name: 'Box' }],
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
        kind: enpalConnectionsEntryKind,
        fixtureMark: 'host',
      }),
    ],
    integrationRowsPortsOver({
      api,
      records: mem.records,
      kind: enpalConnectionsEntryKind,
      warn: () => undefined,
    }),
  )
  if (migration === undefined) throw new Error('no migration')
  const instances = buildEnpalInstances(mem.records, { onChanged: async () => undefined })
  return { mem, rows, cleared, migration, instances }
}

describe('enpal integration instances', () => {
  it('moves the marked field and the API key into the record and clears the rows', async () => {
    const w = await world()

    const result = await w.migration.execute()

    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const read = await enpalConnectionOf(w.instances, 'int_0001')
    expect(read?.tokenLocked).toBe(false)
    expect(read?.connection).toMatchObject({
      host: MARK_HOST,
      source: 'influx',
      influxPort: 8087,
      org: 'marked-org',
      bucket: 'marked_bucket',
      token: SECRET,
      pagePort: 8080,
      pollIntervalMs: 20_000,
      invertBatteryPower: true,
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
    expect(await enpalConnectionOf(w.instances, 'int_0009')).toBeNull()
    expect(await enpalConnectionOf(w.instances, 'int_0404')).toBeNull()
  })
})
