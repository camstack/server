/**
 * The in-memory records world (`makeInMemoryRecords`, `@camstack/types`) and the
 * REAL engine (`RecordsEngine` behind `RecordsProvider`, SQLite in memory) answer
 * the same cases the same way — refusals included. Every spec that builds a store
 * on the in-memory world is only as honest as this file: a rule the engine
 * enforces and the in-memory world does not (an unindexed `where`, an `order`
 * next to a `where`, a page whose last row has no ordering value) once hid a
 * production bug for a day. Add the case here before relying on it there.
 */
import {
  BatchTooLargeError,
  createRecordsAccess,
  createSecretsAccess,
  defineRecordKinds,
  FilterRequiredError,
  InvalidRecordError,
  makeInMemoryRecords,
  RecordNotFoundError,
  type RecordsAccess,
  RecordTooLargeError,
  RecordUniqueViolationError,
  RevConflictError,
  UnindexedFilterError,
  UnknownRecordKindError,
} from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { makeFakeKeychain, makeRecordsWorld } from './support/records-world.js'

const OWNER = 'contract'

const kinds = defineRecordKinds({
  hit: {
    schema: z.object({
      camera: z.string(),
      score: z.number().optional(),
      label: z.string().optional(),
      flag: z.boolean().optional(),
      nested: z.object({ a: z.number().optional(), b: z.number().optional() }).optional(),
    }),
    database: 'events',
    class: 'ledger',
    writeTrigger: 'a contract spec writes it',
    device: 'optional',
    at: 'required',
    indexes: [
      { name: 'cam_score', fields: ['camera', 'score'] },
      { name: 'label', fields: ['label'] },
      { name: 'flag', fields: ['flag'] },
    ],
    retention: { owner: OWNER, reason: 'the spec sweeps it' },
    deviceRemoval: 'delete',
  },
  conf: {
    schema: z.object({
      name: z.string(),
      code: z.string().optional(),
      pad: z.string().optional(),
    }),
    class: 'config',
    writeTrigger: 'a contract spec writes it',
    indexes: [{ name: 'code', fields: ['code'], unique: true }],
    retention: { none: 'config' },
    maxDataBytes: 256,
  },
  ring: {
    schema: z.object({ n: z.number() }),
    database: 'events',
    class: 'ledger',
    writeTrigger: 'a contract spec writes it',
    at: 'required',
    retention: { maxRows: 3 },
  },
  ttl: {
    schema: z.object({ n: z.number() }),
    database: 'events',
    class: 'ephemeral',
    writeTrigger: 'a contract spec writes it',
    at: 'required',
    retention: { ttlMs: 1000, from: 'at' },
  },
})

interface World {
  readonly records: RecordsAccess
}

const worlds: readonly (readonly [string, () => World])[] = [
  [
    'engine',
    () => {
      const world = makeRecordsWorld()
      const secrets = createSecretsAccess({
        owner: OWNER,
        transport: makeFakeKeychain(),
      })
      return {
        records: createRecordsAccess({
          owner: OWNER,
          transport: world.transportFor(OWNER),
          secrets,
        }),
      }
    },
  ],
  ['in-memory', () => ({ records: makeInMemoryRecords(OWNER).records })],
]

describe.each(worlds)('records contract: %s', (_name, make) => {
  let records: RecordsAccess
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(1_000_000)
    records = make().records
    await records.declare(kinds)
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const hit = () => records.kind(kinds.hit)
  const conf = () => records.kind(kinds.conf)

  async function seedHits(
    rows: readonly {
      id: string
      at: number
      deviceId?: number
      data: z.infer<typeof kinds.hit.schema>
    }[],
  ): Promise<void> {
    for (const row of rows) await hit().put(row)
  }

  describe('rows', () => {
    it('a view carries the header the write stated', async () => {
      await hit().put({ id: 'a', deviceId: 7, at: 50, data: { camera: 'c1' } })
      const row = await hit().get('a')
      expect(row).toMatchObject({
        id: 'a',
        deviceId: 7,
        at: 50,
        expiresAt: null,
        rev: 1,
      })
      expect(row?.updatedAt).toBe(1_000_000)
      expect(row?.data).toEqual({ camera: 'c1' })
    })

    it('a ttl kind gets its expiry from the engine', async () => {
      await records.kind(kinds.ttl).put({ id: 't', at: 5000, data: { n: 1 } })
      expect((await records.kind(kinds.ttl).get('t'))?.expiresAt).toBe(6000)
    })

    it('refuses a header the kind forbids', async () => {
      await expect(hit().put({ id: 'a', data: { camera: 'c' } })).rejects.toBeInstanceOf(
        InvalidRecordError,
      )
      await expect(
        conf().put({ id: 'a', deviceId: 1, data: { name: 'n' } }),
      ).rejects.toBeInstanceOf(InvalidRecordError)
      await expect(conf().put({ id: 'a', at: 1, data: { name: 'n' } })).rejects.toBeInstanceOf(
        InvalidRecordError,
      )
      await expect(
        records.kind(kinds.ttl).put({ id: 'a', at: 1, expiresAt: 9, data: { n: 1 } }),
      ).rejects.toBeInstanceOf(InvalidRecordError)
    })

    it('ifRev: 0 means must not exist, N means exactly rev N', async () => {
      await conf().put({ id: 'a', data: { name: 'one' } })
      await expect(
        conf().put({ id: 'a', data: { name: 'x' } }, { ifRev: 0 }),
      ).rejects.toBeInstanceOf(RevConflictError)
      await expect(
        conf().put({ id: 'a', data: { name: 'x' } }, { ifRev: 2 }),
      ).rejects.toBeInstanceOf(RevConflictError)
      expect((await conf().put({ id: 'a', data: { name: 'two' } }, { ifRev: 1 })).rev).toBe(2)
    })

    it('patch merges RFC 7396 onto the stored row, and refuses a missing row or a stale rev', async () => {
      await hit().put({
        id: 'a',
        at: 10,
        data: { camera: 'c', nested: { a: 1, b: 2 } },
      })
      const { rev } = await hit().patch('a', {
        nested: { a: null, b: 3 },
        label: 'L',
      })
      expect(rev).toBe(2)
      const row = await hit().get('a')
      expect(row?.data).toEqual({ camera: 'c', nested: { b: 3 }, label: 'L' })
      expect(row?.at).toBe(10)
      await hit().patch('a', { label: 'M' }, { at: 20 })
      expect((await hit().get('a'))?.at).toBe(20)
      await expect(hit().patch('nope', { label: 'x' })).rejects.toBeInstanceOf(RecordNotFoundError)
      await expect(hit().patch('a', { label: 'x' }, { ifRev: 1 })).rejects.toBeInstanceOf(
        RevConflictError,
      )
      await expect(conf().put({ id: 'p', data: { name: 'n' } })).resolves.toBeDefined()
      await expect(conf().patch('p', { name: 'n' }, { at: 5 })).rejects.toBeInstanceOf(
        InvalidRecordError,
      )
    })

    it('a nested object patched onto an absent field loses its nulls', async () => {
      await hit().put({ id: 'a', at: 1, data: { camera: 'c' } })
      await hit().patch('a', { nested: { a: 1, b: null } })
      expect((await hit().get('a'))?.data).toEqual({
        camera: 'c',
        nested: { a: 1 },
      })
    })

    it('a unique index refuses a second row with the same value, and NULLs never collide', async () => {
      await conf().put({ id: 'a', data: { name: 'n', code: 'X' } })
      await expect(conf().put({ id: 'b', data: { name: 'n', code: 'X' } })).rejects.toBeInstanceOf(
        RecordUniqueViolationError,
      )
      await conf().put({ id: 'a', data: { name: 'renamed', code: 'X' } })
      await conf().put({ id: 'c', data: { name: 'n' } })
      await conf().put({ id: 'd', data: { name: 'n' } })
      expect(await conf().count({})).toBe(3)
    })

    it('a body over maxDataBytes is refused', async () => {
      await expect(
        conf().put({ id: 'a', data: { name: 'n', pad: 'x'.repeat(400) } }),
      ).rejects.toBeInstanceOf(RecordTooLargeError)
    })

    it('getMany returns each stored row once, in id order', async () => {
      await conf().put({ id: 'b', data: { name: 'b' } })
      await conf().put({ id: 'a', data: { name: 'a' } })
      const rows = await conf().getMany(['b', 'zz', 'a', 'b'])
      expect(rows.map((r) => r.id)).toEqual(['a', 'b'])
    })

    it('putMany is one transaction: a refused row writes nothing', async () => {
      await expect(
        hit().putMany([
          { id: 'ok', at: 1, data: { camera: 'c' } },
          { id: 'bad', data: { camera: 'c' } },
        ]),
      ).rejects.toBeInstanceOf(InvalidRecordError)
      expect(await hit().get('ok')).toBeNull()
    })

    it('putMany refuses a batch over the size bound', async () => {
      const rows = Array.from({ length: 1001 }, (_, i) => ({
        id: `r${i}`,
        data: { name: 'n' },
      }))
      await expect(conf().putMany(rows)).rejects.toBeInstanceOf(BatchTooLargeError)
    })

    it('an undeclared kind is unknown', async () => {
      const other = defineRecordKinds({
        ghost: {
          schema: z.object({ n: z.number() }),
          class: 'config',
          writeTrigger: 'never',
          retention: { none: 'x' },
        },
      })
      await expect(records.kind(other.ghost).get('a')).rejects.toBeInstanceOf(
        UnknownRecordKindError,
      )
    })

    it('a ring keeps its newest rows', async () => {
      const ring = records.kind(kinds.ring)
      for (let i = 1; i <= 5; i += 1) await ring.put({ id: `r${i}`, at: i * 10, data: { n: i } })
      const { records: rows } = await ring.query({})
      expect(rows.map((r) => r.id)).toEqual(['r3', 'r4', 'r5'])
    })
  })

  describe('query', () => {
    it('refuses a where no declared index serves', async () => {
      await expect(hit().query({ where: { score: 1 } })).rejects.toBeInstanceOf(
        UnindexedFilterError,
      )
      await expect(hit().query({ where: { camera: 'c', label: 'x' } })).rejects.toBeInstanceOf(
        UnindexedFilterError,
      )
      await expect(
        hit().query({ where: { camera: { gt: 'a' }, score: { gt: 1 } } }),
      ).rejects.toBeInstanceOf(UnindexedFilterError)
      await expect(hit().query({ where: { label: { in: ['a', 'b'] } } })).rejects.toBeInstanceOf(
        UnindexedFilterError,
      )
    })

    it("with a where the order is the index's: asking for one is refused", async () => {
      await expect(hit().query({ where: { camera: 'c' }, order: 'at' })).rejects.toBeInstanceOf(
        InvalidRecordError,
      )
    })

    it('a where returns rows in the order of the index fields after the equality prefix', async () => {
      await seedHits([
        { id: 'a', at: 1, data: { camera: 'c', score: 3 } },
        { id: 'b', at: 2, data: { camera: 'c', score: 1 } },
        { id: 'c', at: 3, data: { camera: 'd', score: 2 } },
        { id: 'd', at: 4, data: { camera: 'c', score: 2 } },
      ])
      const asc = await hit().query({ where: { camera: 'c' } })
      expect(asc.records.map((r) => r.id)).toEqual(['b', 'd', 'a'])
      const desc = await hit().query({ where: { camera: 'c' }, desc: true })
      expect(desc.records.map((r) => r.id)).toEqual(['a', 'd', 'b'])
      const range = await hit().query({
        where: { camera: 'c', score: { gte: 2 } },
      })
      expect(range.records.map((r) => r.id)).toEqual(['d', 'a'])
      const leading = await hit().query({ where: { camera: { gte: 'd' } } })
      expect(leading.records.map((r) => r.id)).toEqual(['c'])
    })

    it('pages a where by keyset: a row written behind the cursor does not shift the next page', async () => {
      await seedHits(
        [1, 2, 3, 4, 5].map((s) => ({
          id: `s${s}`,
          at: s,
          data: { camera: 'c', score: s },
        })),
      )
      const first = await hit().query({ where: { camera: 'c' }, limit: 2 })
      expect(first.records.map((r) => r.id)).toEqual(['s1', 's2'])
      await hit().put({ id: 's0', at: 9, data: { camera: 'c', score: 0 } })
      const second = await hit().query({
        where: { camera: 'c' },
        limit: 2,
        cursor: first.nextCursor ?? '',
      })
      expect(second.records.map((r) => r.id)).toEqual(['s3', 's4'])
      const third = await hit().query({
        where: { camera: 'c' },
        limit: 2,
        cursor: second.nextCursor ?? '',
      })
      expect(third.records.map((r) => r.id)).toEqual(['s5'])
      expect(third.nextCursor).toBeNull()
    })

    it('refuses to page when the last row of a page has no value for an ordering field', async () => {
      await seedHits([
        { id: 'a', at: 1, data: { camera: 'c' } },
        { id: 'b', at: 2, data: { camera: 'c' } },
        { id: 'c', at: 3, data: { camera: 'c', score: 1 } },
      ])
      await expect(hit().query({ where: { camera: 'c' }, limit: 1 })).rejects.toBeInstanceOf(
        InvalidRecordError,
      )
      // A single page needs no cursor and is served.
      const all = await hit().query({ where: { camera: 'c' }, limit: 10 })
      expect(all.records.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    })

    it('a cursor issued for one access path is refused on another', async () => {
      await seedHits(
        [1, 2, 3].map((s) => ({
          id: `s${s}`,
          at: s,
          data: { camera: 'c', score: s },
        })),
      )
      const page = await hit().query({ limit: 1 })
      await expect(
        hit().query({
          where: { camera: 'c' },
          limit: 1,
          cursor: page.nextCursor ?? '',
        }),
      ).rejects.toBeInstanceOf(InvalidRecordError)
      await expect(hit().query({ limit: 1, cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(
        InvalidRecordError,
      )
    })

    it('without a where: at order by default, id order on request, windows and refusals', async () => {
      await seedHits([
        { id: 'z', at: 1, deviceId: 1, data: { camera: 'c' } },
        { id: 'a', at: 3, deviceId: 2, data: { camera: 'c' } },
        { id: 'm', at: 2, deviceId: 1, data: { camera: 'c' } },
      ])
      expect((await hit().query({})).records.map((r) => r.id)).toEqual(['z', 'm', 'a'])
      expect((await hit().query({ desc: true })).records.map((r) => r.id)).toEqual(['a', 'm', 'z'])
      expect((await hit().query({ order: 'id' })).records.map((r) => r.id)).toEqual(['a', 'm', 'z'])
      expect((await hit().query({ deviceId: 1 })).records.map((r) => r.id)).toEqual(['z', 'm'])
      expect((await hit().query({ atFrom: 2, atTo: 3 })).records.map((r) => r.id)).toEqual(['m'])
      await expect(hit().query({ order: 'id', deviceId: 1 })).rejects.toBeInstanceOf(
        UnindexedFilterError,
      )
      await expect(conf().query({ order: 'at' })).rejects.toBeInstanceOf(InvalidRecordError)
      await expect(conf().query({ deviceId: 1 })).rejects.toBeInstanceOf(InvalidRecordError)
      await expect(conf().query({ atFrom: 1 })).rejects.toBeInstanceOf(InvalidRecordError)
    })

    it('pages at order and id order by keyset', async () => {
      await seedHits(
        [1, 2, 3].map((s) => ({
          id: `s${s}`,
          at: s * 10,
          data: { camera: 'c' },
        })),
      )
      const one = await hit().query({ limit: 2 })
      const two = await hit().query({ limit: 2, cursor: one.nextCursor ?? '' })
      expect([...one.records, ...two.records].map((r) => r.id)).toEqual(['s1', 's2', 's3'])
      const a = await hit().query({ order: 'id', desc: true, limit: 2 })
      const b = await hit().query({
        order: 'id',
        desc: true,
        limit: 2,
        cursor: a.nextCursor ?? '',
      })
      expect([...a.records, ...b.records].map((r) => r.id)).toEqual(['s3', 's2', 's1'])
    })

    it('a boolean where matches a stored boolean', async () => {
      await seedHits([
        { id: 'a', at: 1, data: { camera: 'c', flag: true } },
        { id: 'b', at: 2, data: { camera: 'c', flag: false } },
        { id: 'c', at: 3, data: { camera: 'c' } },
      ])
      expect((await hit().query({ where: { flag: true } })).records.map((r) => r.id)).toEqual(['a'])
      expect((await hit().query({ where: { flag: false } })).records.map((r) => r.id)).toEqual([
        'b',
      ])
    })
  })

  describe('count, aggregate, histogram', () => {
    beforeEach(async () => {
      await seedHits([
        {
          id: 'a',
          at: 100,
          deviceId: 1,
          data: { camera: 'c', score: 3, label: 'x' },
        },
        {
          id: 'b',
          at: 250,
          deviceId: 1,
          data: { camera: 'c', score: 5, label: 'y' },
        },
        {
          id: 'c',
          at: 260,
          deviceId: 2,
          data: { camera: 'd', score: 4, label: 'x' },
        },
        { id: 'd', at: 900, deviceId: 2, data: { camera: 'd', label: 'z' } },
      ])
    })

    it('count honours the where, an in set and the window', async () => {
      expect(await hit().count({})).toBe(4)
      expect(await hit().count({ where: { camera: 'c' } })).toBe(2)
      expect(await hit().count({ where: { label: { in: ['x', 'z'] } } })).toBe(3)
      expect(await hit().count({ deviceId: 2 })).toBe(2)
      expect(await hit().count({ atFrom: 250, atTo: 900 })).toBe(2)
      expect(await hit().count({ where: { camera: 'd', score: { gt: 1 } } })).toBe(1)
      await expect(hit().count({ where: { score: 1 } })).rejects.toBeInstanceOf(
        UnindexedFilterError,
      )
    })

    it('aggregate folds index fields, grouped in group order', async () => {
      expect(await hit().aggregate({ op: 'count', groupBy: 'camera' })).toEqual([
        { group: 'c', value: 2 },
        { group: 'd', value: 2 },
      ])
      expect(await hit().aggregate({ op: 'sum', field: 'score', groupBy: 'camera' })).toEqual([
        { group: 'c', value: 8 },
        { group: 'd', value: 4 },
      ])
      expect(
        await hit().aggregate({
          op: 'max',
          field: 'score',
          where: { camera: 'c' },
        }),
      ).toEqual([{ group: null, value: 5 }])
      expect(await hit().aggregate({ op: 'min', field: 'score' })).toEqual([
        { group: null, value: 3 },
      ])
      expect(await hit().aggregate({ op: 'count', field: 'score' })).toEqual([
        { group: null, value: 3 },
      ])
      expect(
        await hit().aggregate({
          op: 'sum',
          field: 'score',
          where: { camera: 'nope' },
        }),
      ).toEqual([{ group: null, value: null }])
      expect(
        await hit().aggregate({
          op: 'count',
          groupBy: 'label',
          where: { label: { in: ['x', 'z'] } },
        }),
      ).toEqual([
        { group: 'x', value: 2 },
        { group: 'z', value: 1 },
      ])
    })

    it('aggregate refuses what the engine refuses', async () => {
      await expect(hit().aggregate({ op: 'sum' })).rejects.toBeInstanceOf(InvalidRecordError)
      await expect(hit().aggregate({ op: 'count' })).rejects.toBeInstanceOf(InvalidRecordError)
      await expect(hit().aggregate({ op: 'count', groupBy: 'nested.a' })).rejects.toBeInstanceOf(
        UnindexedFilterError,
      )
      await expect(
        hit().aggregate({ op: 'sum', field: 'score', groupBy: 'label' }),
      ).rejects.toBeInstanceOf(UnindexedFilterError)
    })

    it('histogram buckets the at window, per device', async () => {
      expect(await hit().histogram({ from: 0, to: 1000, bucketMs: 200 })).toEqual([
        { bucketStart: 0, count: 1 },
        { bucketStart: 200, count: 2 },
        { bucketStart: 800, count: 1 },
      ])
      expect(await hit().histogram({ deviceId: 2, from: 0, to: 900, bucketMs: 500 })).toEqual([
        { bucketStart: 0, count: 1 },
      ])
      await expect(hit().histogram({ from: 5, to: 5, bucketMs: 1 })).rejects.toBeInstanceOf(
        InvalidRecordError,
      )
      await expect(conf().histogram({ from: 0, to: 5, bucketMs: 1 })).rejects.toBeInstanceOf(
        InvalidRecordError,
      )
    })
  })

  describe('deletes and ids', () => {
    beforeEach(async () => {
      await seedHits([
        { id: 'a', at: 100, deviceId: 1, data: { camera: 'c', label: 'x' } },
        { id: 'b', at: 200, deviceId: 1, data: { camera: 'c', label: 'y' } },
        { id: 'c', at: 300, deviceId: 2, data: { camera: 'd', label: 'x' } },
      ])
    })

    it('deleteWhere needs a predicate and honours each', async () => {
      await expect(hit().deleteWhere({})).rejects.toBeInstanceOf(FilterRequiredError)
      await expect(hit().deleteWhere({ where: { score: 1 } })).rejects.toBeInstanceOf(
        UnindexedFilterError,
      )
      expect(await hit().deleteWhere({ atBefore: 200 })).toBe(1)
      expect(await hit().deleteWhere({ where: { label: { in: ['y', 'q'] } } })).toBe(1)
      expect(await hit().deleteWhere({ deviceId: 2 })).toBe(1)
      expect(await hit().count({})).toBe(0)
    })

    it('deleteDevice removes the device rows of every kind declared for it', async () => {
      expect(await records.deleteDevice(1)).toEqual({ hit: 2 })
      expect((await hit().query({})).records.map((r) => r.id)).toEqual(['c'])
    })

    it('allocateId counts up per kind; putMany raises it above numeric ids; an allocated id is insert-only', async () => {
      const ring = records.kind(kinds.ring)
      expect(await hit().allocateId()).toBe(1)
      expect(await hit().allocateId()).toBe(2)
      expect(await ring.allocateId()).toBe(1)
      await hit().putMany([{ id: '41', at: 1, data: { camera: 'c' } }])
      expect(await hit().allocateId()).toBe(42)
      await hit().put({ id: '43', at: 1, data: { camera: 'c' } })
      const next = await hit().allocateId()
      expect(next).toBe(43)
      await expect(
        hit().put({ id: String(next), at: 2, data: { camera: 'c' } }),
      ).rejects.toBeInstanceOf(RevConflictError)
    })
  })
})
