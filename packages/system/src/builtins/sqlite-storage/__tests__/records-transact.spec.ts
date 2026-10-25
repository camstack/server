/**
 * `transact` (D881 plan section 1.3): several put / patch / delete in ONE
 * SQLite transaction over kinds of one `transactFamily` in one file. The real
 * engine behind the real provider and the in-memory records answer the same
 * cases the same way: an op that throws leaves NOTHING of the call visible, and
 * a call that spans two families or two files is refused by name before a row
 * moves.
 */
import {
  createRecordsAccess,
  defineRecordKinds,
  makeInMemoryRecords,
  PlaintextSecretError,
  RecordNotFoundError,
  type RecordsAccess,
  RecordUniqueViolationError,
  TransactRefusedError,
} from '@camstack/types'
import { beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { declaration, makeHarness } from './support/records-harness.js'
import { makeRecordsWorld } from './support/records-world.js'

const OWNER = 'tx-spec'
const Body = z.object({ n: z.number(), key: z.string().optional() })
const base = {
  schema: Body,
  database: 'events',
  class: 'ledger',
  writeTrigger: 'a transact spec writes it',
  at: 'required',
  retention: { none: 'spec' },
} as const

const kinds = defineRecordKinds({
  frame: { ...base, device: 'required', transactFamily: 'ret' },
  note: {
    ...base,
    device: 'required',
    transactFamily: 'ret',
    indexes: [{ name: 'key', fields: ['key'], unique: true }],
  },
  other: { ...base, device: 'required', transactFamily: 'else' },
  loner: { ...base, device: 'required' },
})
// A family lives in ONE file, so the cross-file case uses a settings kind of its own family.
const settingsKind = defineRecordKinds({
  conf: { ...base, database: 'settings', device: 'required', transactFamily: 'conf' },
}).conf

const worlds: readonly (readonly [string, () => RecordsAccess])[] = [
  [
    'engine',
    () => {
      const world = makeRecordsWorld()
      return createRecordsAccess({
        owner: OWNER,
        transport: world.transportFor(OWNER),
        secrets: null,
      })
    },
  ],
  ['in-memory', () => makeInMemoryRecords(OWNER).records],
]

describe.each(worlds)('records transact: %s', (_name, make) => {
  let records: RecordsAccess
  beforeEach(async () => {
    records = make()
    await records.declare(kinds)
    await records.declare({ conf: settingsKind })
  })
  const frame = () => records.kind(kinds.frame)
  const note = () => records.kind(kinds.note)

  it('applies put, patch and delete together, results in op order', async () => {
    await frame().put({ id: 'old', deviceId: 1, at: 1, data: { n: 1 } })
    const results = await records.transact([
      await frame().txPut({ id: 'f1', deviceId: 1, at: 2, data: { n: 10 } }),
      await note().txPut({ id: 'n1', deviceId: 1, at: 2, data: { n: 5, key: 'k1' } }),
      await frame().txPatch('old', { n: 2 }),
      frame().txDelete('absent'),
    ])
    expect(results.map((r) => r.deleted)).toEqual([false, false, false, false])
    expect(results.map((r) => r.rev)).toEqual([1, 1, 2, null])
    expect((await frame().get('f1'))?.data).toEqual({ n: 10 })
    expect((await note().get('n1'))?.data).toEqual({ n: 5, key: 'k1' })
    expect((await frame().get('old'))?.data).toEqual({ n: 2 })
  })

  it('op 2 throws: nothing of the call is visible (put, patch and delete all rolled back)', async () => {
    await frame().put({ id: 'keep', deviceId: 1, at: 1, data: { n: 1 } })
    await expect(
      records.transact([
        await frame().txPut({ id: 'f1', deviceId: 1, at: 2, data: { n: 10 } }),
        frame().txDelete('keep'),
        await note().txPatch('missing', { n: 9 }),
      ]),
    ).rejects.toBeInstanceOf(RecordNotFoundError)
    expect(await frame().get('f1')).toBeNull()
    expect((await frame().get('keep'))?.data).toEqual({ n: 1 })
  })

  it('a unique-index refusal on a later op rolls the earlier ones back', async () => {
    await note().put({ id: 'n0', deviceId: 1, at: 1, data: { n: 1, key: 'dup' } })
    await expect(
      records.transact([
        await frame().txPut({ id: 'f1', deviceId: 1, at: 2, data: { n: 10 } }),
        await note().txPut({ id: 'n1', deviceId: 1, at: 2, data: { n: 5, key: 'dup' } }),
      ]),
    ).rejects.toBeInstanceOf(RecordUniqueViolationError)
    expect(await frame().get('f1')).toBeNull()
  })

  it('refuses two kinds of different families, by name, before any row moves', async () => {
    const attempt = records.transact([
      await frame().txPut({ id: 'f1', deviceId: 1, at: 2, data: { n: 1 } }),
      await records.kind(kinds.other).txPut({ id: 'o1', deviceId: 1, at: 2, data: { n: 1 } }),
    ])
    await expect(attempt).rejects.toBeInstanceOf(TransactRefusedError)
    await expect(attempt).rejects.toThrow(/cross-family/)
    expect(await frame().get('f1')).toBeNull()
  })

  it('refuses two kinds when one declares no family', async () => {
    const attempt = records.transact([
      await frame().txPut({ id: 'f1', deviceId: 1, at: 2, data: { n: 1 } }),
      await records.kind(kinds.loner).txPut({ id: 'l1', deviceId: 1, at: 2, data: { n: 1 } }),
    ])
    await expect(attempt).rejects.toThrow(/no-family/)
    expect(await frame().get('f1')).toBeNull()
  })

  it('refuses kinds that live in two database files', async () => {
    const attempt = records.transact([
      await frame().txPut({ id: 'f1', deviceId: 1, at: 2, data: { n: 1 } }),
      await records.kind(settingsKind).txPut({ id: 'c1', deviceId: 1, at: 2, data: { n: 1 } }),
    ])
    await expect(attempt).rejects.toBeInstanceOf(TransactRefusedError)
    await expect(attempt).rejects.toThrow(/cross-file/)
    expect(await frame().get('f1')).toBeNull()
  })

  it('a single-kind transact needs no family', async () => {
    const loner = records.kind(kinds.loner)
    await records.transact([
      await loner.txPut({ id: 'a', deviceId: 1, at: 2, data: { n: 1 } }),
      await loner.txPut({ id: 'b', deviceId: 1, at: 2, data: { n: 2 } }),
    ])
    expect((await loner.get('b'))?.data).toEqual({ n: 2 })
  })
})

describe('records transact: the engine runs the single-row code paths', () => {
  it('a plaintext secret in op 2 is refused as a single put would, and op 1 does not land', async () => {
    const h = makeHarness()
    const secretKind = declaration({
      database: 'settings',
      transactFamily: 'sec',
      secretPaths: ['token'],
    })
    await h.engine.declareKinds({
      owner: OWNER,
      kinds: { a: declaration({ transactFamily: 'sec' }), b: secretKind },
    })
    await expect(
      h.engine.transact({
        owner: OWNER,
        ops: [
          { op: 'put', kind: 'a', record: { id: '1', deviceId: 1, at: 1, data: { n: 1 } } },
          {
            op: 'put',
            kind: 'b',
            record: { id: '1', deviceId: 1, at: 1, data: { token: 'plain' } },
          },
        ],
      }),
    ).rejects.toBeInstanceOf(PlaintextSecretError)
    expect(await h.engine.get({ owner: OWNER, kind: 'a', id: '1' })).toBeNull()
  })
})
