/**
 * The Matter broker records go flat (planning#408 P3): same ids, the fabric settings at the top
 * level, both secrets read back from their new keychain refs before the nested object goes, the
 * old refs deleted.
 */
import {
  defineEntryKind,
  entryBody,
  type FlattenRowPorts,
  flattenPortsOver,
  makeInMemoryRecords,
  recordSecretRef,
} from '@camstack/types'
import { z } from 'zod'
import { beforeEach, describe, expect, it } from 'vitest'
import { matterBrokersEntryKind } from '../../broker-record-kinds.js'
import { ADDON_MIGRATIONS, FLATTEN_BROKER_RECORDS_ID } from '../index.js'
import { flattenBrokerRecords } from '../flatten-broker-records.js'

const OWNER = 'matter-broker'
const FLAT_SECRETS: readonly string[] = ['threadDataset', 'wifiPassword']
const nestedRef = (id: string, key: string): string =>
  recordSecretRef(OWNER, 'brokers', id, `connection.${key}`)

/** The kind as the hub declared it before the flat body: the connection nested, secrets inside. */
const legacyKind = defineEntryKind('brokers', {
  title: 'legacy brokers',
  schema: entryBody({
    connection: z.object({
      threadDataset: z.string().optional().meta({ secret: true }),
      wifiSsid: z.string().optional(),
      wifiPassword: z.string().optional().meta({ secret: true }),
      reconcileIntervalMs: z.number().optional(),
    }),
    integrationId: z.string().optional(),
  }),
})

async function world() {
  const memory = makeInMemoryRecords(OWNER)
  await memory.records.declare({ brokers: legacyKind })
  const legacyHandle = memory.records.kind(legacyKind)
  const seed = async (
    id: string,
    plain: Record<string, unknown>,
    secrets: Record<string, string>,
  ): Promise<void> => {
    await legacyHandle.put(
      {
        id,
        data: {
          name: `Fabric ${id}`,
          integrationId: `int-${id}`,
          connection: { ...plain, ...secrets },
        },
      },
      { ifRev: 0 },
    )
  }
  await memory.records.declare({ brokers: matterBrokersEntryKind })
  const handle = memory.records.kind(matterBrokersEntryKind)
  return { memory, handle, ports: flattenPortsOver(handle), seed }
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
    expect(await flattenBrokerRecords(w.ports)).toMatchObject({
      outcome: 'already-done',
    })
    expect(snapshot(w)).toBe(before)
  })

  it('an unreadable secret blocks with nothing written', async () => {
    await w.memory.secrets.delete([nestedRef('matter_001', 'wifiPassword')])
    const before = snapshot(w)
    await expect(flattenBrokerRecords(w.ports)).rejects.toThrow(/matter_001/)
    expect(snapshot(w)).toBe(before)
  })

  it('a secret that does not read back keeps the nested row and its refs', async () => {
    const seen = new Set<string>()
    const lying: FlattenRowPorts = {
      ...w.ports,
      // The first read of a row is the honest phase-A read; the read-back finds no flat secret.
      readResolved: async (id) => {
        const data = await w.ports.readResolved(id)
        if (!seen.has(id)) {
          seen.add(id)
          return data
        }
        return Object.fromEntries(
          Object.entries(data).filter(([key]) => !FLAT_SECRETS.includes(key)),
        )
      },
    }
    await expect(flattenBrokerRecords(lying)).rejects.toThrow()
    const row = (await w.handle.query({ limit: 10 })).records.find((r) => r.id === 'matter_001')
    expect(row?.data).toHaveProperty('connection')
    expect(row?.data).not.toHaveProperty('wifiPassword')
    const answers = await w.memory.secrets.resolve([nestedRef('matter_001', 'wifiPassword')])
    expect(answers[nestedRef('matter_001', 'wifiPassword')]?.kind).toBe('value')
  })

  it('a crash before the nested object is patched out strands no ref; the rerun finishes the row', async () => {
    let calls = 0
    const crashing: FlattenRowPorts = {
      ...w.ports,
      patch: async (id, patch) => {
        calls += 1
        // 1 = flat fields of the first row, 2 = its nested object going out: crash there.
        if (calls === 2) throw new Error('crash before the nested object left')
        await w.ports.patch(id, patch)
      },
    }
    await expect(flattenBrokerRecords(crashing)).rejects.toThrow(/crash/)
    const stillThere = await w.memory.secrets.resolve([nestedRef('matter_001', 'wifiPassword')])
    expect(stillThere[nestedRef('matter_001', 'wifiPassword')]?.kind).toBe('value')

    expect(await flattenBrokerRecords(w.ports)).toMatchObject({
      outcome: 'done',
    })
    for (const row of (await w.handle.query({ limit: 10 })).records) {
      expect(row.data).not.toHaveProperty('connection')
    }
    const gone = await w.memory.secrets.resolve([nestedRef('matter_001', 'wifiPassword')])
    expect(gone[nestedRef('matter_001', 'wifiPassword')]?.kind).toBe('missing')
  })
})
