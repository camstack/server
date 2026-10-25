/**
 * The records engine on real SQLite (D881): the operations of plan section 1.3,
 * the refusals that keep an unindexed filter from compiling, secrets as a
 * feature of a kind, TTL and ring retention, batched deletes - and the plans of
 * the statements the engine REALLY prepares (spy on `prepare`, D447).
 */
import {
  FilterRequiredError,
  InvalidRecordError,
  PlaintextSecretError,
  RecordNotFoundError,
  RecordTooLargeError,
  RecordUniqueViolationError,
  RevConflictError,
  UnindexedFilterError,
  UnknownRecordKindError,
  DeclarationRefusedError,
  ForeignSecretMarkerError,
  makeSecretMarker,
  recordSecretRef,
  REDACTED_SECRET,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  declaration,
  type Harness,
  lastStatement,
  makeHarness,
  planOf,
  tableColumnReads,
} from './support/records-harness.js'

const OWNER = 'spec-addon'

async function declare(
  h: Harness,
  kinds: Record<string, ReturnType<typeof declaration>>,
  owner = OWNER,
) {
  return h.engine.declareKinds({ owner, kinds })
}

const MEDIA = declaration({
  device: 'required',
  at: 'required',
  indexes: [
    { name: 'loc', fields: ['loc', 'bytes'] },
    { name: 'track', fields: ['trackId'], unique: true },
  ],
})

async function seedMedia(h: Harness, n = 30): Promise<void> {
  await declare(h, { media: MEDIA })
  await h.engine.putMany({
    owner: OWNER,
    kind: 'media',
    records: Array.from({ length: n }, (_, i) => ({
      id: `m${i}`,
      deviceId: i % 3,
      at: 1000 + i,
      data: { loc: `L${i % 2}`, bytes: i + 1, trackId: `t${i}` },
    })),
  })
}

describe('records engine: operations', () => {
  it('put/get round-trips a row and bumps rev on every write', async () => {
    const h = makeHarness()
    await declare(h, { ev: declaration() })
    const first = await h.engine.put({
      owner: OWNER,
      kind: 'ev',
      record: { id: 'a', deviceId: 7, at: 5, data: { x: 1 } },
    })
    expect(first.rev).toBe(1)
    const second = await h.engine.put({
      owner: OWNER,
      kind: 'ev',
      record: { id: 'a', deviceId: 7, at: 6, data: { x: 2 } },
    })
    expect(second.rev).toBe(2)
    const row = await h.engine.get({ owner: OWNER, kind: 'ev', id: 'a' })
    expect(row).toMatchObject({ id: 'a', deviceId: 7, at: 6, rev: 2, data: { x: 2 } })
  })

  it('an absent row is null, and an unknown kind THROWS (never an empty answer)', async () => {
    const h = makeHarness()
    await declare(h, { ev: declaration() })
    expect(await h.engine.get({ owner: OWNER, kind: 'ev', id: 'nope' })).toBeNull()
    await expect(h.engine.get({ owner: OWNER, kind: 'ghost', id: 'a' })).rejects.toBeInstanceOf(
      UnknownRecordKindError,
    )
  })

  it('ifRev is compare-and-set: a stale rev throws and writes nothing; ifRev 0 means "must not exist"', async () => {
    const h = makeHarness()
    await declare(h, { ev: declaration() })
    const put = (data: Record<string, unknown>, ifRev?: number) =>
      h.engine.put({
        owner: OWNER,
        kind: 'ev',
        record: { id: 'a', deviceId: 1, at: 1, data },
        ...(ifRev === undefined ? {} : { ifRev }),
      })
    await put({ v: 1 }, 0)
    await expect(put({ v: 'dup' }, 0)).rejects.toBeInstanceOf(RevConflictError)
    await expect(put({ v: 'stale' }, 5)).rejects.toBeInstanceOf(RevConflictError)
    expect((await h.engine.get({ owner: OWNER, kind: 'ev', id: 'a' }))?.data).toEqual({ v: 1 })
    expect((await put({ v: 2 }, 1)).rev).toBe(2)
  })

  it('patch merges in ONE statement (RFC 7396: null removes) and never loses a sibling field', async () => {
    const h = makeHarness()
    await declare(h, { ev: declaration() })
    await h.engine.put({
      owner: OWNER,
      kind: 'ev',
      record: { id: 'a', deviceId: 1, at: 1, data: { a: 1, b: 2, keep: true } },
    })
    await h.engine.patch({ owner: OWNER, kind: 'ev', id: 'a', data: { a: 10 } })
    await h.engine.patch({ owner: OWNER, kind: 'ev', id: 'a', data: { b: null, c: 3 } })
    const row = await h.engine.get({ owner: OWNER, kind: 'ev', id: 'a' })
    expect(row?.data).toEqual({ a: 10, keep: true, c: 3 })
    expect(row?.rev).toBe(3)
    // a patch never SELECTs the row on a kind without secrets
    expect(
      h.statements.filter(
        (s) => s.sql.startsWith('UPDATE records') && s.sql.includes('jsonb_patch'),
      ),
    ).toHaveLength(2)
    await expect(
      h.engine.patch({ owner: OWNER, kind: 'ev', id: 'ghost', data: { a: 1 } }),
    ).rejects.toBeInstanceOf(RecordNotFoundError)
    await expect(
      h.engine.patch({ owner: OWNER, kind: 'ev', id: 'a', data: { a: 1 }, ifRev: 99 }),
    ).rejects.toBeInstanceOf(RevConflictError)
  })

  it('refuses data above maxDataBytes, names the kind, and logs once a minute', async () => {
    const h = makeHarness()
    await declare(h, { ev: declaration({ maxDataBytes: 64 }) })
    const big = { blob: 'x'.repeat(200) }
    const put = () =>
      h.engine.put({ owner: OWNER, kind: 'ev', record: { id: 'a', deviceId: 1, at: 1, data: big } })
    await expect(put()).rejects.toBeInstanceOf(RecordTooLargeError)
    await expect(put()).rejects.toBeInstanceOf(RecordTooLargeError)
    expect(h.logLines.filter((l) => l.includes('exceeded maxDataBytes'))).toHaveLength(1)
    h.clock.now += 61_000
    await expect(put()).rejects.toBeInstanceOf(RecordTooLargeError)
    expect(h.logLines.filter((l) => l.includes('exceeded maxDataBytes'))).toHaveLength(2)
    expect(await h.engine.get({ owner: OWNER, kind: 'ev', id: 'a' })).toBeNull()
  })

  it('enforces the declared device / at requirements', async () => {
    const h = makeHarness()
    await declare(h, { dev: declaration(), plain: declaration({ device: 'none', at: 'none' }) })
    await expect(
      h.engine.put({ owner: OWNER, kind: 'dev', record: { id: 'a', at: 1, data: {} } }),
    ).rejects.toBeInstanceOf(InvalidRecordError)
    await expect(
      h.engine.put({ owner: OWNER, kind: 'plain', record: { id: 'a', deviceId: 1, data: {} } }),
    ).rejects.toBeInstanceOf(InvalidRecordError)
  })

  it('delete and deleteMany report what they removed; allocateId counts per kind', async () => {
    const h = makeHarness()
    await declare(h, { ev: declaration(), other: declaration() })
    await h.engine.putMany({
      owner: OWNER,
      kind: 'ev',
      records: [1, 2, 3].map((n) => ({ id: `r${n}`, deviceId: 1, at: n, data: {} })),
    })
    expect((await h.engine.delete({ owner: OWNER, kind: 'ev', id: 'r1' })).deleted).toBe(true)
    expect((await h.engine.delete({ owner: OWNER, kind: 'ev', id: 'r1' })).deleted).toBe(false)
    expect(
      (await h.engine.deleteMany({ owner: OWNER, kind: 'ev', ids: ['r2', 'r3', 'zz'] })).deleted,
    ).toBe(2)
    expect((await h.engine.allocateId({ owner: OWNER, kind: 'ev' })).id).toBe(1)
    expect((await h.engine.allocateId({ owner: OWNER, kind: 'ev' })).id).toBe(2)
    expect((await h.engine.allocateId({ owner: OWNER, kind: 'other' })).id).toBe(1)
  })
})

describe('records engine: ownership and kind isolation', () => {
  it('another addon cannot see, write or delete a kind it does not own', async () => {
    const h = makeHarness()
    await declare(h, { ev: declaration() })
    await h.engine.put({
      owner: OWNER,
      kind: 'ev',
      record: { id: 'a', deviceId: 1, at: 1, data: {} },
    })
    await expect(h.engine.get({ owner: 'thief', kind: 'ev', id: 'a' })).rejects.toBeInstanceOf(
      UnknownRecordKindError,
    )
    await expect(
      h.engine.deleteWhere({ owner: 'thief', kind: 'ev', deviceId: 1 }),
    ).rejects.toBeInstanceOf(UnknownRecordKindError)
  })

  it('two kinds of one owner sharing ids and devices never leak into each other (random filters)', async () => {
    const h = makeHarness()
    const indexes = [{ name: 'tag', fields: ['tag'] }]
    await declare(h, { one: declaration({ indexes }), two: declaration({ indexes }) })
    let seed = 7
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    for (const kind of ['one', 'two']) {
      await h.engine.putMany({
        owner: OWNER,
        kind,
        records: Array.from({ length: 40 }, (_, i) => ({
          id: `id${i}`,
          deviceId: i % 4,
          at: i,
          data: { tag: `t${i % 5}`, kind },
        })),
      })
    }
    for (let round = 0; round < 25; round += 1) {
      const device = rnd(4)
      const tag = `t${rnd(5)}`
      const q = await h.engine.query({ owner: OWNER, kind: 'one', deviceId: device, limit: 100 })
      expect(q.records.every((r) => r.data['kind'] === 'one' && r.deviceId === device)).toBe(true)
      const w = await h.engine.query({ owner: OWNER, kind: 'two', where: { tag }, limit: 100 })
      expect(w.records.every((r) => r.data['kind'] === 'two' && r.data['tag'] === tag)).toBe(true)
    }
    await h.engine.deleteWhere({ owner: OWNER, kind: 'one', where: { tag: 't1' } })
    expect((await h.engine.count({ owner: OWNER, kind: 'one' })).count).toBe(32)
    expect((await h.engine.count({ owner: OWNER, kind: 'two' })).count).toBe(40)
  })

  it('every statement carries kind_id as a LITERAL, never a bound parameter', async () => {
    const h = makeHarness()
    await seedMedia(h, 5)
    await h.engine.query({ owner: OWNER, kind: 'media', where: { trackId: 't1' }, limit: 5 })
    await h.engine.count({ owner: OWNER, kind: 'media', deviceId: 1 })
    for (const s of h.statements.filter(
      (x) => /\bFROM records\b/.test(x.sql) && !x.sql.startsWith('EXPLAIN'),
    )) {
      expect(s.sql).toMatch(/kind_id = \d+/)
      expect(s.sql).not.toMatch(/kind_id = \?/)
    }
  })
})

describe('records engine: queries are index-served or refused', () => {
  it('a where on a field no declared index leads with does not compile', async () => {
    const h = makeHarness()
    await seedMedia(h, 5)
    await expect(
      h.engine.query({ owner: OWNER, kind: 'media', where: { bytes: 3 }, limit: 5 }),
    ).rejects.toBeInstanceOf(UnindexedFilterError)
    await expect(
      h.engine.count({ owner: OWNER, kind: 'media', where: { nope: 'x' } }),
    ).rejects.toBeInstanceOf(UnindexedFilterError)
    await expect(
      h.engine.deleteWhere({ owner: OWNER, kind: 'media', where: { nope: 'x' } }),
    ).rejects.toBeInstanceOf(UnindexedFilterError)
  })

  it('deleteWhere with no predicate is refused (there is no "delete all")', async () => {
    const h = makeHarness()
    await seedMedia(h, 3)
    await expect(h.engine.deleteWhere({ owner: OWNER, kind: 'media' })).rejects.toBeInstanceOf(
      FilterRequiredError,
    )
    expect((await h.engine.count({ owner: OWNER, kind: 'media' })).count).toBe(3)
  })

  it('pages by device + time with a keyset cursor, ascending and descending, without offset', async () => {
    const h = makeHarness()
    await seedMedia(h, 30)
    const all: string[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page += 1) {
      const r = await h.engine.query({
        owner: OWNER,
        kind: 'media',
        deviceId: 1,
        limit: 4,
        ...(cursor === undefined ? {} : { cursor }),
      })
      all.push(...r.records.map((x) => x.id))
      if (r.nextCursor === null) break
      cursor = r.nextCursor
    }
    expect(all).toEqual(['m1', 'm4', 'm7', 'm10', 'm13', 'm16', 'm19', 'm22', 'm25', 'm28'])
    const desc = await h.engine.query({
      owner: OWNER,
      kind: 'media',
      deviceId: 1,
      desc: true,
      limit: 3,
    })
    expect(desc.records.map((x) => x.id)).toEqual(['m28', 'm25', 'm22'])
    const windowed = await h.engine.query({
      owner: OWNER,
      kind: 'media',
      atFrom: 1010,
      atTo: 1013,
      limit: 10,
    })
    expect(windowed.records.map((x) => x.at)).toEqual([1010, 1011, 1012])
    expect(h.statements.some((s) => / OFFSET /i.test(s.sql))).toBe(false)
  })

  it('pages a where in index order and a cursor from another query is refused', async () => {
    const h = makeHarness()
    await seedMedia(h, 30)
    const first = await h.engine.query({
      owner: OWNER,
      kind: 'media',
      where: { loc: 'L0' },
      limit: 5,
    })
    expect(first.records.map((r) => r.data['bytes'])).toEqual([1, 3, 5, 7, 9])
    expect(first.nextCursor).not.toBeNull()
    const second = await h.engine.query({
      owner: OWNER,
      kind: 'media',
      where: { loc: 'L0' },
      limit: 5,
      cursor: first.nextCursor ?? '',
    })
    expect(second.records.map((r) => r.data['bytes'])).toEqual([11, 13, 15, 17, 19])
    await expect(
      h.engine.query({
        owner: OWNER,
        kind: 'media',
        deviceId: 1,
        limit: 5,
        cursor: first.nextCursor ?? '',
      }),
    ).rejects.toBeInstanceOf(InvalidRecordError)
    const range = await h.engine.query({
      owner: OWNER,
      kind: 'media',
      where: { loc: 'L1', bytes: { gte: 10, lt: 16 } },
      limit: 10,
    })
    expect(range.records.map((r) => r.data['bytes'])).toEqual([10, 12, 14])
  })

  it('a unique expression index refuses a duplicate', async () => {
    const h = makeHarness()
    await seedMedia(h, 3)
    await expect(
      h.engine.put({
        owner: OWNER,
        kind: 'media',
        record: { id: 'other', deviceId: 1, at: 9, data: { loc: 'L9', bytes: 1, trackId: 't1' } },
      }),
    ).rejects.toBeInstanceOf(RecordUniqueViolationError)
  })

  it('counts, buckets and aggregates', async () => {
    const h = makeHarness()
    await seedMedia(h, 30)
    expect((await h.engine.count({ owner: OWNER, kind: 'media', deviceId: 2 })).count).toBe(10)
    expect(
      (await h.engine.count({ owner: OWNER, kind: 'media', where: { loc: 'L1' } })).count,
    ).toBe(15)
    const hist = await h.engine.histogram({
      owner: OWNER,
      kind: 'media',
      from: 1000,
      to: 1030,
      bucketMs: 10,
    })
    expect(hist.buckets).toEqual([
      { bucketStart: 1000, count: 10 },
      { bucketStart: 1010, count: 10 },
      { bucketStart: 1020, count: 10 },
    ])
    const sums = await h.engine.aggregate({
      owner: OWNER,
      kind: 'media',
      op: 'sum',
      field: 'bytes',
      groupBy: 'loc',
    })
    const byGroup = Object.fromEntries(sums.rows.map((r) => [String(r.group), r.value]))
    expect(byGroup).toEqual({ L0: 225, L1: 240 })
    await expect(
      h.engine.aggregate({
        owner: OWNER,
        kind: 'media',
        op: 'sum',
        field: 'trackId',
        groupBy: 'loc',
      }),
    ).rejects.toBeInstanceOf(UnindexedFilterError)
  })
})

describe('records engine: the plans of the statements it REALLY prepares (D447)', () => {
  it('device + time pages are a SEARCH of the built-in index, with no sort', async () => {
    const h = makeHarness()
    await seedMedia(h, 30)
    await h.engine.query({ owner: OWNER, kind: 'media', deviceId: 1, limit: 4 })
    const s = lastStatement(h, 'ORDER BY at')
    const plan = planOf(h.db, s).join(' | ')
    expect(plan).toContain('SEARCH records USING INDEX records_kind_device_at')
    expect(plan).not.toContain('TEMP B-TREE')
    expect(plan).not.toMatch(/\bSCAN records\b/)
  })

  it('a count and a histogram are served from a COVERING index and never read the table', async () => {
    const h = makeHarness()
    await seedMedia(h, 30)
    await h.engine.count({ owner: OWNER, kind: 'media', deviceId: 1, atFrom: 1000, atTo: 1100 })
    await h.engine.histogram({ owner: OWNER, kind: 'media', from: 1000, to: 1030, bucketMs: 10 })
    const count = lastStatement(h, 'COUNT(*) AS n')
    expect(planOf(h.db, count).join(' | ')).toContain('COVERING INDEX records_kind_device_at')
    expect(tableColumnReads(h.db, count)).toBe(0)
    const hist = lastStatement(h, 'GROUP BY b')
    expect(planOf(h.db, hist).join(' | ')).toContain('COVERING INDEX records_kind_at')
    expect(tableColumnReads(h.db, hist)).toBe(0)
  })

  it('a where is a SEARCH of the named partial expression index, paged with no sort', async () => {
    const h = makeHarness()
    await seedMedia(h, 30)
    await h.engine.query({ owner: OWNER, kind: 'media', where: { loc: 'L0' }, limit: 4 })
    const s = lastStatement(h, 'rx_')
    const plan = planOf(h.db, s).join(' | ')
    expect(plan).toMatch(/SEARCH records USING (COVERING )?INDEX rx_\d+_loc/)
    expect(plan).not.toContain('TEMP B-TREE')
  })

  it('the NEXT page (keyset cursor) is still a bounded index search with no sort, for time and for a where', async () => {
    const h = makeHarness()
    await seedMedia(h, 30)
    const timePage = await h.engine.query({ owner: OWNER, kind: 'media', deviceId: 1, limit: 3 })
    await h.engine.query({
      owner: OWNER,
      kind: 'media',
      deviceId: 1,
      limit: 3,
      cursor: timePage.nextCursor ?? '',
    })
    const time = planOf(h.db, lastStatement(h, '(at, rid) >')).join(' | ')
    expect(time).toContain('SEARCH records USING INDEX records_kind_device_at')
    expect(time).not.toContain('TEMP B-TREE')
    const wherePage = await h.engine.query({
      owner: OWNER,
      kind: 'media',
      where: { loc: 'L0' },
      limit: 3,
    })
    await h.engine.query({
      owner: OWNER,
      kind: 'media',
      where: { loc: 'L0' },
      limit: 3,
      cursor: wherePage.nextCursor ?? '',
    })
    const idx = planOf(h.db, lastStatement(h, ', rid) >')).join(' | ')
    expect(idx).toMatch(/SEARCH records USING (COVERING )?INDEX rx_\d+_loc/)
    expect(idx).not.toContain('TEMP B-TREE')
  })

  it('an aggregate over indexed fields never reads the table row - checked on OPCODES, because EXPLAIN QUERY PLAN says USING INDEX either way', async () => {
    const h = makeHarness()
    await seedMedia(h, 30)
    await h.engine.aggregate({
      owner: OWNER,
      kind: 'media',
      op: 'sum',
      field: 'bytes',
      groupBy: 'loc',
    })
    const s = lastStatement(h, 'SUM(')
    expect(planOf(h.db, s).join(' | ')).toMatch(/INDEX rx_\d+_loc/)
    expect(tableColumnReads(h.db, s)).toBe(0)
  })

  it('DISARM: the opcode check does see a table read when the aggregate field is NOT in the index', async () => {
    const h = makeHarness()
    await declare(h, { y: declaration() }) // creates the shared tables; this kind is kind_id 1
    h.db.exec(`CREATE INDEX rx_1_loc ON records(json_extract("data", '$.loc')) WHERE kind_id = 1`)
    h.db.exec(
      `INSERT INTO records(kind_id,id,device_id,at,updated_at,data) VALUES (1,'a',1,1,1,jsonb('{"loc":"a","bytes":3}'))`,
    )
    const reads = tableColumnReads(h.db, {
      sql: `SELECT SUM(json_extract("data", '$.bytes')) FROM records INDEXED BY rx_1_loc WHERE kind_id = 1 AND json_extract("data", '$.loc') = ?`,
      params: ['a'],
    })
    expect(reads).toBeGreaterThan(0)
  })
})

describe('records engine: declaration is additive and DDL only happens there', () => {
  it('creates the declared indexes at declaration, and a re-declaration is unchanged', async () => {
    const h = makeHarness()
    const first = await declare(h, { media: MEDIA })
    expect(first.kinds['media']).toMatchObject({
      state: 'created',
      createdIndexes: ['loc', 'track'],
    })
    const again = await declare(h, { media: MEDIA })
    expect(again.kinds['media']).toMatchObject({ state: 'unchanged', createdIndexes: [] })
    const names = h.db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE name LIKE 'rx_%'")
      .all()
      .map((r) => r.name)
    expect(names).toHaveLength(2)
  })

  it('writes never run DDL', async () => {
    const h = makeHarness()
    await seedMedia(h, 5)
    const before = h.statements.length
    await h.engine.put({
      owner: OWNER,
      kind: 'media',
      record: { id: 'z', deviceId: 1, at: 1, data: { loc: 'a', bytes: 1, trackId: 'zz' } },
    })
    await h.engine.patch({ owner: OWNER, kind: 'media', id: 'z', data: { bytes: 2 } })
    expect(h.statements.slice(before).some((s) => /CREATE|DROP|ALTER/i.test(s.sql))).toBe(false)
  })

  it('a changed index is refused; a new index name is accepted; a changed file is refused', async () => {
    const h = makeHarness()
    await declare(h, { media: MEDIA })
    await expect(
      declare(h, {
        media: declaration({
          ...MEDIA,
          indexes: [
            { name: 'loc', fields: ['loc'] },
            MEDIA.indexes[1] ?? { name: 'x', fields: ['y'] },
          ],
        }),
      }),
    ).rejects.toBeInstanceOf(DeclarationRefusedError)
    const added = await declare(h, {
      media: declaration({
        ...MEDIA,
        indexes: [...MEDIA.indexes, { name: 'loc2', fields: ['loc'] }],
      }),
    })
    expect(added.kinds['media']).toMatchObject({ state: 'updated', createdIndexes: ['loc2'] })
    await expect(
      declare(h, { media: declaration({ ...MEDIA, device: 'none' }) }),
    ).rejects.toBeInstanceOf(DeclarationRefusedError)
    await expect(
      declare(h, { elsewhere: declaration({ database: 'events' }) }),
    ).rejects.toBeInstanceOf(DeclarationRefusedError)
  })

  it('keeps its catalog across a restart (a new engine on the same file)', async () => {
    const h = makeHarness()
    await seedMedia(h, 3)
    const { RecordsEngine } = await import('../records/records-engine.js')
    const { silentLogger } = await import('./support/records-harness.js')
    const reopened = new RecordsEngine(h.db, { databaseId: 'settings', logger: silentLogger() })
    expect((await reopened.count({ owner: OWNER, kind: 'media' })).count).toBe(3)
  })
})

describe('records engine: retention', () => {
  it('a ttl kind gets expires_at from the engine, refuses a producer one, and the sweep removes it', async () => {
    const h = makeHarness()
    await declare(h, {
      t: declaration({ retention: { ttlMs: 1000, from: 'write' }, device: 'none', at: 'none' }),
    })
    await h.engine.put({ owner: OWNER, kind: 't', record: { id: 'a', data: {} } })
    expect((await h.engine.get({ owner: OWNER, kind: 't', id: 'a' }))?.expiresAt).toBe(1_001_000)
    await expect(
      h.engine.put({ owner: OWNER, kind: 't', record: { id: 'b', data: {}, expiresAt: 5 } }),
    ).rejects.toBeInstanceOf(InvalidRecordError)
    h.clock.now += 500
    expect((await h.engine.sweepExpired({})).deleted).toBe(0)
    h.clock.now += 600
    expect((await h.engine.sweepExpired({})).deleted).toBe(1)
    expect(await h.engine.get({ owner: OWNER, kind: 't', id: 'a' })).toBeNull()
  })

  it("a producer-set expiresAt works on a kind whose retention is the owner's", async () => {
    const h = makeHarness()
    await declare(h, {
      art: declaration({
        retention: { owner: 'x', reason: 'producer expiry' },
        device: 'none',
        at: 'none',
      }),
    })
    await h.engine.put({
      owner: OWNER,
      kind: 'art',
      record: { id: 'a', data: {}, expiresAt: 1_000_100 },
    })
    h.clock.now = 1_000_200
    expect((await h.engine.sweepExpired({})).deleted).toBe(1)
  })

  it('a maxRows ring keeps the newest rows by at (small ring: exact on every write)', async () => {
    const h = makeHarness()
    await declare(h, { ring: declaration({ retention: { maxRows: 5 }, device: 'none' }) })
    for (let i = 1; i <= 9; i += 1) {
      await h.engine.put({ owner: OWNER, kind: 'ring', record: { id: `r${i}`, at: i, data: {} } })
    }
    const kept = await h.engine.query({ owner: OWNER, kind: 'ring', limit: 100 })
    expect(kept.records.map((r) => r.id)).toEqual(['r5', 'r6', 'r7', 'r8', 'r9'])
  })

  it('maxRowsPerDevice trims each device on its own', async () => {
    const h = makeHarness()
    await declare(h, { ring: declaration({ retention: { maxRowsPerDevice: 2 } }) })
    for (let i = 1; i <= 4; i += 1) {
      for (const device of [1, 2]) {
        await h.engine.put({
          owner: OWNER,
          kind: 'ring',
          record: { id: `d${device}-${i}`, deviceId: device, at: i, data: {} },
        })
      }
    }
    expect((await h.engine.count({ owner: OWNER, kind: 'ring', deviceId: 1 })).count).toBe(2)
    expect((await h.engine.count({ owner: OWNER, kind: 'ring', deviceId: 2 })).count).toBe(2)
  })

  it('deleteWhere deletes in batches of 5000 and yields between them', async () => {
    const h = makeHarness()
    await declare(h, { big: declaration() })
    h.db.exec('BEGIN')
    const kindId = h.db
      .prepare<[], { kind_id: number }>("SELECT kind_id FROM _record_kinds WHERE kind = 'big'")
      .get()?.kind_id
    const insert = h.db.prepare(
      `INSERT INTO records(kind_id,id,device_id,at,updated_at,data) VALUES (${kindId},?,?,?,1,jsonb('{}'))`,
    )
    for (let i = 0; i < 12_000; i += 1) insert.run(`r${i}`, 1, i)
    h.db.exec('COMMIT')
    let yields = 0
    const tick = setInterval(() => (yields += 1), 0)
    const result = await h.engine.deleteWhere({
      owner: OWNER,
      kind: 'big',
      deviceId: 1,
      atBefore: 11_000,
    })
    clearInterval(tick)
    expect(result.deleted).toBe(11_000)
    expect(yields).toBeGreaterThan(0)
    expect((await h.engine.count({ owner: OWNER, kind: 'big' })).count).toBe(1_000)
  })

  it('deleteDevice removes the device from every kind declared deviceRemoval: delete, and only those', async () => {
    const h = makeHarness()
    await declare(h, {
      gone: declaration({ deviceRemoval: 'delete' }),
      stays: declaration({ deviceRemoval: 'none' }),
    })
    for (const kind of ['gone', 'stays']) {
      await h.engine.putMany({
        owner: OWNER,
        kind,
        records: [1, 2].map((d) => ({ id: `r${d}`, deviceId: d, at: 1, data: {} })),
      })
    }
    const result = await h.engine.deleteDevice({ owner: OWNER, deviceId: 1 })
    expect(result.deleted).toEqual({ gone: 1 })
    expect((await h.engine.count({ owner: OWNER, kind: 'stays' })).count).toBe(2)
    const other = await h.engine.deleteDevice({ owner: 'someone-else', deviceId: 2 })
    expect(other.deleted).toEqual({})
  })
})

describe('records engine: secret fields are markers bound to the row', () => {
  const SECRET = declaration({
    device: 'none',
    at: 'none',
    secretPaths: ['token', 'headers[].value'],
    secretArrayKeys: { headers: 'name' },
    retention: { none: 'config' },
    class: 'config',
  })
  const refOf = (id: string, path: string): string => recordSecretRef(OWNER, 'cfg', id, path)

  it("refuses a plaintext secret and a marker that is not the row's own", async () => {
    const h = makeHarness()
    await declare(h, { cfg: SECRET })
    await expect(
      h.engine.put({ owner: OWNER, kind: 'cfg', record: { id: 'a', data: { token: 'hunter2' } } }),
    ).rejects.toBeInstanceOf(PlaintextSecretError)
    await expect(
      h.engine.put({
        owner: OWNER,
        kind: 'cfg',
        record: { id: 'a', data: { token: makeSecretMarker(refOf('other-row', 'token')) } },
      }),
    ).rejects.toBeInstanceOf(ForeignSecretMarkerError)
    expect(await h.engine.get({ owner: OWNER, kind: 'cfg', id: 'a' })).toBeNull()
    // and the message never carries the value
    await h.engine
      .put({ owner: OWNER, kind: 'cfg', record: { id: 'a', data: { token: 'hunter2' } } })
      .catch((err: Error) => {
        expect(err.message).not.toContain('hunter2')
      })
  })

  it('stores the marker, redacts it on EVERY read, and keeps it when the token comes back', async () => {
    const h = makeHarness()
    await declare(h, { cfg: SECRET })
    const marker = makeSecretMarker(refOf('a', 'token'))
    const headerMarker = makeSecretMarker(refOf('a', 'headers[X-Api].value'))
    await h.engine.put({
      owner: OWNER,
      kind: 'cfg',
      record: {
        id: 'a',
        data: { token: marker, label: 'x', headers: [{ name: 'X-Api', value: headerMarker }] },
      },
    })
    const view = await h.engine.get({ owner: OWNER, kind: 'cfg', id: 'a' })
    expect(view?.data).toEqual({
      token: REDACTED_SECRET,
      label: 'x',
      headers: [{ name: 'X-Api', value: REDACTED_SECRET }],
    })
    const listed = await h.engine.query({ owner: OWNER, kind: 'cfg', limit: 10 })
    expect(JSON.stringify(listed)).not.toContain('secret://')
    // write the redacted view back: the stored markers are kept
    await h.engine.put({ owner: OWNER, kind: 'cfg', record: { id: 'a', data: view?.data ?? {} } })
    const refs = await h.engine.secretRefs({ owner: OWNER, kind: 'cfg', ids: ['a'] })
    expect(refs).toEqual({
      a: { token: refOf('a', 'token'), 'headers[X-Api].value': refOf('a', 'headers[X-Api].value') },
    })
  })

  it('a put that drops a secret field RELEASES its ref; delete returns every ref', async () => {
    const h = makeHarness()
    await declare(h, { cfg: SECRET })
    const marker = makeSecretMarker(refOf('a', 'token'))
    await h.engine.put({ owner: OWNER, kind: 'cfg', record: { id: 'a', data: { token: marker } } })
    const dropped = await h.engine.put({
      owner: OWNER,
      kind: 'cfg',
      record: { id: 'a', data: { label: 'no token' } },
    })
    expect(dropped.releasedRefs).toEqual([refOf('a', 'token')])
    await h.engine.put({
      owner: OWNER,
      kind: 'cfg',
      record: { id: 'b', data: { token: makeSecretMarker(refOf('b', 'token')) } },
    })
    const del = await h.engine.delete({ owner: OWNER, kind: 'cfg', id: 'b' })
    expect(del.secretRefs).toEqual([refOf('b', 'token')])
  })

  it('a patch refuses plaintext, ignores the token, and null removes the field and releases its ref', async () => {
    const h = makeHarness()
    await declare(h, { cfg: SECRET })
    const marker = makeSecretMarker(refOf('a', 'token'))
    await h.engine.put({
      owner: OWNER,
      kind: 'cfg',
      record: { id: 'a', data: { token: marker, label: 'x' } },
    })
    await expect(
      h.engine.patch({ owner: OWNER, kind: 'cfg', id: 'a', data: { token: 'plain' } }),
    ).rejects.toBeInstanceOf(PlaintextSecretError)
    await h.engine.patch({
      owner: OWNER,
      kind: 'cfg',
      id: 'a',
      data: { token: REDACTED_SECRET, label: 'y' },
    })
    expect(
      (await h.engine.secretRefs({ owner: OWNER, kind: 'cfg', ids: ['a'] }))['a'],
    ).toBeDefined()
    const removed = await h.engine.patch({
      owner: OWNER,
      kind: 'cfg',
      id: 'a',
      data: { token: null },
    })
    expect(removed.releasedRefs).toEqual([refOf('a', 'token')])
    expect(await h.engine.secretRefs({ owner: OWNER, kind: 'cfg', ids: ['a'] })).toEqual({})
  })

  it('a patch cannot give a secret kind an expiry (put already refuses it)', async () => {
    const h = makeHarness()
    await declare(h, { cfg: SECRET })
    await h.engine.put({ owner: OWNER, kind: 'cfg', record: { id: 'a', data: { label: 'x' } } })
    await expect(
      h.engine.patch({ owner: OWNER, kind: 'cfg', id: 'a', data: {}, expiresAt: 5 }),
    ).rejects.toBeInstanceOf(InvalidRecordError)
    await expect(
      h.engine.put({ owner: OWNER, kind: 'cfg', record: { id: 'a', data: {}, expiresAt: 5 } }),
    ).rejects.toBeInstanceOf(InvalidRecordError)
  })

  it('a patch restores the stored marker of an ARRAY element that comes back as the token', async () => {
    const h = makeHarness()
    await declare(h, { cfg: SECRET })
    const marker = makeSecretMarker(refOf('a', 'headers[X-Api].value'))
    await h.engine.put({
      owner: OWNER,
      kind: 'cfg',
      record: { id: 'a', data: { headers: [{ name: 'X-Api', value: marker }] } },
    })
    const patched = await h.engine.patch({
      owner: OWNER,
      kind: 'cfg',
      id: 'a',
      data: { headers: [{ name: 'X-Api', value: REDACTED_SECRET }] },
    })
    expect(patched.releasedRefs).toEqual([])
    expect((await h.engine.secretRefs({ owner: OWNER, kind: 'cfg', ids: ['a'] }))['a']).toEqual({
      'headers[X-Api].value': refOf('a', 'headers[X-Api].value'),
    })
  })

  it('listKinds with counts: false reads the catalog only (no COUNT per kind)', async () => {
    const h = makeHarness()
    await declare(h, { cfg: SECRET })
    const before = h.statements.length
    const kinds = await h.engine.listKinds({ counts: false })
    expect(kinds[0]).toMatchObject({ kind: 'cfg', rows: null, bytesEstimate: null })
    expect(h.statements.slice(before).some((s) => s.sql.includes('COUNT(*)'))).toBe(false)
    expect((await h.engine.listKinds({}))[0]?.rows).toBe(0)
  })

  it('refuses at declaration a secret kind with an engine ttl or row bound', async () => {
    const h = makeHarness()
    await expect(
      declare(h, { bad: declaration({ ...SECRET, retention: { ttlMs: 10, from: 'write' } }) }),
    ).rejects.toBeInstanceOf(DeclarationRefusedError)
  })
})
