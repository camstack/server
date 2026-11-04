/**
 * The HA broker records go flat (planning#408 P3): same ids, secrets at the top level, the nested
 * `auth` refs deleted. Records are the real facade over the engine-contract world; the keychain
 * is the spec keychain that world exposes.
 */
import {
  type FlattenRowPorts,
  flattenPortsOver,
  makeInMemoryRecords,
  recordSecretRef,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { HA_BROKERS_KIND, HA_BROKERS_OWNER, haBrokersEntryKind } from '../../broker-record-kinds.js'
import { ADDON_MIGRATIONS, FLATTEN_BROKER_RECORDS_ID } from '../index.js'
import { flattenBrokerRecords } from '../flatten-broker-records.js'

const nestedRef = (id: string, key: string): string =>
  recordSecretRef(HA_BROKERS_OWNER, HA_BROKERS_KIND, id, `auth.${key}`)

async function world() {
  const memory = makeInMemoryRecords(HA_BROKERS_OWNER)
  await memory.records.declare({ [HA_BROKERS_KIND]: haBrokersEntryKind })
  const handle = memory.records.kind(haBrokersEntryKind)
  const seed = async (
    id: string,
    auth: Record<string, string>,
    secrets: Record<string, string>,
  ): Promise<void> => {
    const nested: Record<string, unknown> = { ...auth }
    for (const [key, value] of Object.entries(secrets)) {
      await memory.secrets.put(nestedRef(id, key), value)
      nested[key] = { $secret: nestedRef(id, key), v: 1 }
    }
    memory.seed(HA_BROKERS_KIND, {
      id,
      data: { name: `Broker ${id}`, integrationId: `int-${id}`, auth: nested },
    })
  }
  return { memory, handle, ports: flattenPortsOver(handle, memory.secrets), seed }
}

type World = Awaited<ReturnType<typeof world>>

async function seedBoth(w: World): Promise<void> {
  await w.seed(
    'ha_001',
    { kind: 'long-lived', baseUrl: 'http://ha.local:8123' },
    { accessToken: 'tok-1' },
  )
  await w.seed('ha_002', { kind: 'supervisor' }, { supervisorToken: 'sup-2' })
}

describe('flatten-broker-records', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
    await seedBoth(w)
  })

  it('is registered to block the owner when it fails', () => {
    const entry = ADDON_MIGRATIONS.find((m) => m.meta.id === FLATTEN_BROKER_RECORDS_ID)
    expect(entry?.meta.onFailure).toBe('block-owner')
  })

  it('moves every record flat under the same id: marked field kept, secrets resolve, old refs gone', async () => {
    const result = await flattenBrokerRecords(w.ports)
    expect(result).toMatchObject({ outcome: 'done', summary: { converted: 2 } })

    const rows = (await w.handle.query({ limit: 10 })).records
    expect(rows.map((r) => r.id).sort()).toEqual(['ha_001', 'ha_002'])
    for (const row of rows) {
      expect(row.data).not.toHaveProperty('auth')
      expect(row.data).toMatchObject({ integrationId: `int-${row.id}` })
    }
    const one = await w.handle.getResolved('ha_001')
    expect(one?.data).toMatchObject({
      authKind: 'long-lived',
      baseUrl: 'http://ha.local:8123',
      accessToken: 'tok-1',
    })
    const two = await w.handle.getResolved('ha_002')
    expect(two?.data).toMatchObject({ authKind: 'supervisor', supervisorToken: 'sup-2' })

    const old = [nestedRef('ha_001', 'accessToken'), nestedRef('ha_002', 'supervisorToken')]
    const answers = await w.memory.secrets.resolve(old)
    expect(old.map((ref) => answers[ref]?.kind)).toEqual(['missing', 'missing'])
  })

  it('a second run is already-done and writes nothing', async () => {
    await flattenBrokerRecords(w.ports)
    const before = JSON.stringify([...(w.memory.tables.get(HA_BROKERS_KIND)?.entries() ?? [])])
    expect(await flattenBrokerRecords(w.ports)).toMatchObject({ outcome: 'already-done' })
    expect(JSON.stringify([...(w.memory.tables.get(HA_BROKERS_KIND)?.entries() ?? [])])).toBe(
      before,
    )
  })

  it('an unreadable secret blocks with nothing written, not even for the readable rows', async () => {
    await w.memory.secrets.delete([nestedRef('ha_002', 'supervisorToken')])
    const before = JSON.stringify([...(w.memory.tables.get(HA_BROKERS_KIND)?.entries() ?? [])])
    await expect(flattenBrokerRecords(w.ports)).rejects.toThrow(/ha_002/)
    expect(JSON.stringify([...(w.memory.tables.get(HA_BROKERS_KIND)?.entries() ?? [])])).toBe(
      before,
    )
    const kept = await w.memory.secrets.resolve([nestedRef('ha_001', 'accessToken')])
    expect(kept[nestedRef('ha_001', 'accessToken')]?.kind).toBe('value')
  })

  it('a secret that does not read back from its new home keeps the nested row and its refs', async () => {
    const lying: FlattenRowPorts = { ...w.ports, readFlatSecrets: async () => ({}) }
    await expect(flattenBrokerRecords(lying)).rejects.toThrow()
    const row = (await w.handle.query({ limit: 10 })).records.find((r) => r.id === 'ha_001')
    expect(row?.data).toHaveProperty('auth')
    expect(row?.data).not.toHaveProperty('authKind')
    const answers = await w.memory.secrets.resolve([nestedRef('ha_001', 'accessToken')])
    expect(answers[nestedRef('ha_001', 'accessToken')]?.kind).toBe('value')
  })
})
