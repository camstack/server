/**
 * The Alexa broker records go flat (planning#408 P3): same ids, the account fields at the top
 * level, every secret (the cookie, the refresh token and the macDms that used to be plain text) a
 * keychain secret read back before the nested object goes, the old refs deleted.
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
import { alexaBrokersEntryKind } from '../../broker-record-kinds.js'
import { ADDON_MIGRATIONS, FLATTEN_BROKER_RECORDS_ID } from '../index.js'
import { flattenBrokerRecords } from '../flatten-broker-records.js'

const OWNER = 'import-alexa'
const FLAT_SECRETS: readonly string[] = ['cookie', 'refreshToken', 'macDms']
const nestedRef = (id: string, key: string): string =>
  recordSecretRef(OWNER, 'brokers', id, `connection.${key}`)

/** The kind as the hub declared it before the flat body: the connection nested, secrets inside. */
const legacyKind = defineEntryKind('brokers', {
  title: 'legacy brokers',
  schema: entryBody({
    connection: z.object({
      amazonDomain: z.string().optional(),
      cookie: z.string().optional().meta({ secret: true }),
      refreshToken: z.string().optional().meta({ secret: true }),
      macDms: z.string().optional(),
      pollIntervalMs: z.number().optional(),
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
          name: `Account ${id}`,
          integrationId: `int-${id}`,
          connection: { ...plain, ...secrets },
        },
      },
      { ifRev: 0 },
    )
  }
  await memory.records.declare({ brokers: alexaBrokersEntryKind })
  const handle = memory.records.kind(alexaBrokersEntryKind)
  return { memory, handle, ports: flattenPortsOver(handle), seed }
}
type World = Awaited<ReturnType<typeof world>>
const snapshot = (w: World): string =>
  JSON.stringify([...(w.memory.tables.get('brokers')?.entries() ?? [])])

describe('import-alexa flatten-broker-records', () => {
  let w: World
  beforeEach(async () => {
    w = await world()
    await w.seed(
      'alexa_001',
      { amazonDomain: 'amazon.it', macDms: 'mac-1', pollIntervalMs: 90_000 },
      { cookie: 'cookie-1', refreshToken: 'rt-1' },
    )
    await w.seed('alexa_002', { amazonDomain: 'amazon.de', macDms: '' }, { cookie: 'cookie-2' })
  })

  it('blocks the owner when it fails', () => {
    expect(
      ADDON_MIGRATIONS.find((m) => m.meta.id === FLATTEN_BROKER_RECORDS_ID)?.meta.onFailure,
    ).toBe('block-owner')
  })

  it('moves every account flat under the same id: marked fields kept, secrets resolve, old refs gone', async () => {
    expect(await flattenBrokerRecords(w.ports)).toMatchObject({
      outcome: 'done',
      summary: { converted: 2 },
    })
    const rows = (await w.handle.query({ limit: 10 })).records
    expect(rows.map((r) => r.id).sort()).toEqual(['alexa_001', 'alexa_002'])
    for (const row of rows) {
      expect(row.data).not.toHaveProperty('connection')
      expect(row.data).toMatchObject({ integrationId: `int-${row.id}` })
    }
    expect((await w.handle.getResolved('alexa_001'))?.data).toMatchObject({
      amazonDomain: 'amazon.it',
      pollIntervalMs: 90_000,
      cookie: 'cookie-1',
      refreshToken: 'rt-1',
      macDms: 'mac-1',
    })
    expect((await w.handle.getResolved('alexa_002'))?.data).toMatchObject({
      amazonDomain: 'amazon.de',
      cookie: 'cookie-2',
    })
    const old = [nestedRef('alexa_001', 'cookie'), nestedRef('alexa_001', 'refreshToken')]
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
    await w.memory.secrets.delete([nestedRef('alexa_002', 'cookie')])
    const before = snapshot(w)
    await expect(flattenBrokerRecords(w.ports)).rejects.toThrow(/alexa_002/)
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
    const row = (await w.handle.query({ limit: 10 })).records.find((r) => r.id === 'alexa_001')
    expect(row?.data).toHaveProperty('connection')
    expect(row?.data).not.toHaveProperty('cookie')
    const answers = await w.memory.secrets.resolve([nestedRef('alexa_001', 'cookie')])
    expect(answers[nestedRef('alexa_001', 'cookie')]?.kind).toBe('value')
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
    const stillThere = await w.memory.secrets.resolve([nestedRef('alexa_001', 'cookie')])
    expect(stillThere[nestedRef('alexa_001', 'cookie')]?.kind).toBe('value')

    expect(await flattenBrokerRecords(w.ports)).toMatchObject({
      outcome: 'done',
    })
    for (const row of (await w.handle.query({ limit: 10 })).records) {
      expect(row.data).not.toHaveProperty('connection')
    }
    const gone = await w.memory.secrets.resolve([nestedRef('alexa_001', 'cookie')])
    expect(gone[nestedRef('alexa_001', 'cookie')]?.kind).toBe('missing')
  })
})
