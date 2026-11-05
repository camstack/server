/**
 * VeSync accounts are `connections` records (planning#416, D1007): legacy rows move into
 * the record with the password, and the runtime reads the record.
 */
import {
  defineAddonMigrations,
  integrationRowsPortsOver,
  makeInMemoryRecords,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { DeviceType } from '@camstack/types'
import { buildVeSyncCandidates } from '../vesync-discovery.js'
import {
  buildVeSyncInstances,
  vesyncConnectionOf,
  vesyncConnectionsEntryKind,
  vesyncRecordKinds,
} from '../vesync-instances.js'
import { VESYNC_ROWS_TO_RECORD_MIGRATION } from '../migrations/index.js'

const ADDON = 'provider-vesync'
const SECRET = 'vesync-password-the-spec-must-see-again'

async function world() {
  const mem = makeInMemoryRecords(ADDON)
  await mem.records.declare(vesyncRecordKinds)
  const rows = new Map<string, Record<string, unknown>>([
    [
      'int_0001',
      { email: 'me@example.com', password: SECRET, region: 'EU', pollIntervalMs: 15_000 },
    ],
  ])
  const cleared: string[] = []
  const api = {
    list: async () => [{ id: 'int_0001', addonId: ADDON, name: 'Home' }],
    readLegacyIntegrationRows: async ({ integrationId: id }: { integrationId: string }) => ({
      ...rows.get(id),
    }),
    clearLegacyIntegrationRows: async ({ integrationId: id }: { integrationId: string }) => {
      cleared.push(id)
      rows.set(id, {})
    },
  }
  const [migration] = defineAddonMigrations(
    [VESYNC_ROWS_TO_RECORD_MIGRATION],
    integrationRowsPortsOver({
      api,
      records: mem.records,
      kind: vesyncConnectionsEntryKind,
      warn: () => undefined,
    }),
  )
  if (migration === undefined) throw new Error('no migration')
  const instances = buildVeSyncInstances(mem.records, { onChanged: async () => undefined })
  return { mem, rows, cleared, migration, instances }
}

describe('vesync integration instances', () => {
  it('moves the email and the password into the record and clears the rows', async () => {
    const w = await world()
    const result = await w.migration.execute()
    expect(result).toMatchObject({ kind: 'procedure', result: { outcome: 'done' } })
    const read = await vesyncConnectionOf(w.instances, 'int_0001')
    expect(read?.passwordLocked).toBe(false)
    expect(read?.connection).toMatchObject({
      email: 'me@example.com',
      password: SECRET,
      region: 'EU',
      pollIntervalMs: 15_000,
    })
    expect(JSON.stringify(w.mem.tables.get('connections')?.get('int_0001')?.data)).not.toContain(
      SECRET,
    )
    expect(w.cleared).toEqual(['int_0001'])
    expect(w.rows.get('int_0001')).toEqual({})
    expect(await w.migration.execute()).toMatchObject({ result: { outcome: 'already-done' } })
  })

  it('reads no account from a record without an email', async () => {
    const w = await world()
    await w.instances.createInstance({ id: 'int_0009', name: 'Empty' })
    expect(await vesyncConnectionOf(w.instances, 'int_0009')).toBeNull()
    expect(await vesyncConnectionOf(w.instances, 'int_0404')).toBeNull()
  })
})

describe('vesync discovery', () => {
  it('proposes the Gateway as a sibling of the purifiers', () => {
    const out = buildVeSyncCandidates({
      integrationId: 'int-1',
      accountName: 'Home',
      online: true,
      purifiers: [
        {
          nativeId: 'cid-1',
          name: 'Living room',
          power: true,
          speedPercent: 50,
          preset: '',
          availablePresets: [],
          childLock: false,
          display: true,
          filterLifePercent: 80,
          online: true,
        },
      ],
      adoptedGatewayId: null,
      adoptedDeviceIdByCid: {},
    })
    expect(out.map((c) => c.type)).toEqual([DeviceType.Gateway, DeviceType.Fan])
    expect(out[0]?.childNativeId).toBe('account')
    expect(out[0]?.children).toBeUndefined()
    expect(out[1]?.childNativeId).toBe('int-1:purifier:cid-1')
  })
})
