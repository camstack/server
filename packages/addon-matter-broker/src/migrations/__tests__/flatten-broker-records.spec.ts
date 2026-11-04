/**
 * The Matter broker records go flat (planning#408 P3): same ids, the fabric settings at the top
 * level, both secrets read back from their new keychain refs before the nested object goes, the
 * old refs deleted.
 */
import {
  type FlattenRowPorts,
  flattenPortsOver,
  makeInMemoryRecords,
  recordSecretRef,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { matterBrokersEntryKind } from '../../broker-record-kinds.js'
import { ADDON_MIGRATIONS, FLATTEN_BROKER_RECORDS_ID } from '../index.js'
import { flattenBrokerRecords } from '../flatten-broker-records.js'

const OWNER = 'matter-broker'
const nestedRef = (id: string, key: string): string =>
  recordSecretRef(OWNER, 'brokers', id, `connection.${key}`)

async function world() {
  const memory = makeInMemoryRecords(OWNER)
  await memory.records.declare({ brokers: matterBrokersEntryKind })
  const handle = memory.records.kind(matterBrokersEntryKind)
  const seed = async (
    id: string,
    plain: Record<string, unknown>,
    secrets: Record<string, string>,
  ): Promise<void> => {
    const connection: Record<string, unknown> = { ...plain }
    for (const [key, value] of Object.entries(secrets)) {
      await memory.secrets.put(nestedRef(id, key), value)
      connection[key] = { $secret: nestedRef(id, key), v: 1 }
    }
    memory.seed('brokers', {
      id,
      data: { name: `Fabric ${id}`, integrationId: `int-${id}`, connection },
    })
  }
  return { memory, handle, ports: flattenPortsOver(handle, memory.secrets), seed }
}
type World = Awaited<ReturnType<typeof world>>
const snapshot = (w: World): string =>
  JSON.stringify([...(w.memory.tables.get('brokers')?.entries() ?? [])])

describe('matter-broker flatten-broker-records', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
    await w.seed(
      'matter_001',
      { wifiSsid: 'home-net', reconcileIntervalMs: 120_000 },
      { threadDataset: '0e0800aa', wifiPassword: 'wifi-pw' },
    )
    await w.seed('matter_002', { wifiSsid: '' }, {})
  })

  it('blocks the owner when it fails', () => {
    expect(
      ADDON_MIGRATIONS.find((m) => m.meta.id === FLATTEN_BROKER_RECORDS_ID)?.meta.onFailure,
    ).toBe('block-owner')
  })

  it('moves every fabric flat under the same id: marked fields kept, secrets resolve, old refs gone', async () => {
    expect(await flattenBrokerRecords(w.ports)).toMatchObject({
      outcome: 'done',
      summary: { converted: 2 },
    })
    const rows = (await w.handle.query({ limit: 10 })).records
    expect(rows.map((r) => r.id).sort()).toEqual(['matter_001', 'matter_002'])
    for (const row of rows) {
      expect(row.data).not.toHaveProperty('connection')
      expect(row.data).toMatchObject({ integrationId: `int-${row.id}` })
    }
    expect((await w.handle.getResolved('matter_001'))?.data).toMatchObject({
      wifiSsid: 'home-net',
      reconcileIntervalMs: 120_000,
      threadDataset: '0e0800aa',
      wifiPassword: 'wifi-pw',
    })
    const old = [nestedRef('matter_001', 'threadDataset'), nestedRef('matter_001', 'wifiPassword')]
    const answers = await w.memory.secrets.resolve(old)
    expect(old.map((ref) => answers[ref]?.kind)).toEqual(['missing', 'missing'])
  })

  it('a second run is already-done and writes nothing', async () => {
    await flattenBrokerRecords(w.ports)
    const before = snapshot(w)
    expect(await flattenBrokerRecords(w.ports)).toMatchObject({ outcome: 'already-done' })
    expect(snapshot(w)).toBe(before)
  })

  it('an unreadable secret blocks with nothing written', async () => {
    await w.memory.secrets.delete([nestedRef('matter_001', 'wifiPassword')])
    const before = snapshot(w)
    await expect(flattenBrokerRecords(w.ports)).rejects.toThrow(/matter_001/)
    expect(snapshot(w)).toBe(before)
  })

  it('a secret that does not read back keeps the nested row and its refs', async () => {
    const lying: FlattenRowPorts = { ...w.ports, readFlatSecrets: async () => ({}) }
    await expect(flattenBrokerRecords(lying)).rejects.toThrow()
    const row = (await w.handle.query({ limit: 10 })).records.find((r) => r.id === 'matter_001')
    expect(row?.data).toHaveProperty('connection')
    expect(row?.data).not.toHaveProperty('wifiPassword')
    const answers = await w.memory.secrets.resolve([nestedRef('matter_001', 'wifiPassword')])
    expect(answers[nestedRef('matter_001', 'wifiPassword')]?.kind).toBe('value')
  })
})
