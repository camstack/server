/**
 * `DurableLedger` — the extracted primitive, asserted in isolation.
 *
 * The donor's own suite (`notification-center/__tests__/liveness-ledger.spec.ts`,
 * 18 assertions) is the real regression net for the extraction and is left
 * untouched: it runs against `NcLivenessLedger`, which is now a thin owner over
 * this class. What is pinned HERE is the contract the other consumers rely on
 * and that the donor's suite does not exercise — write-through, `pruneExcept`,
 * `forget`, and the fact that the mirror is never widened by a fallible read.
 *
 * Every negative below is proved against a CONTROL that must hold, so no
 * assertion can pass vacuously.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { defineRecordKinds, type InMemoryRecords, makeInMemoryRecords } from '@camstack/types'
import { makeSilentLogger } from '../../pipeline-analytics/__tests__/test-helpers.js'
import { DurableLedger, type DurableLedgerSpec } from '../durable-ledger.js'
import { DurableLedgerBodySchema } from '../durable-record-body.js'

const T0 = 1_700_000_000_000

interface Row {
  readonly key: string
  readonly deviceId: number
  readonly level: number
  readonly updatedAt: number
}

const COLLECTION = 'test:durable-rows'

/** The kind a spec ledger persists to: an in-memory records world declares it. */
const testKinds = defineRecordKinds({
  'durable-rows': {
    schema: DurableLedgerBodySchema,
    class: 'ledger',
    database: 'settings',
    writeTrigger: 'a spec writes a row through the ledger under test',
    device: 'optional',
    at: 'none',
    retention: { none: 'spec rows live for the length of the test' },
  },
})

/** A fresh records world with the test kind declared (applied before the first operation). */
function freshWorld(): InMemoryRecords {
  const world = makeInMemoryRecords('spec')
  void world.records.declare(testKinds)
  return world
}

function spec(overrides: Partial<DurableLedgerSpec<Row>> = {}): DurableLedgerSpec<Row> {
  return {
    collection: COLLECTION,
    columns: [
      { name: 'key', type: 'TEXT', primaryKey: true, notNull: true },
      { name: 'deviceId', type: 'INTEGER', notNull: true },
      { name: 'level', type: 'INTEGER', notNull: true },
      { name: 'updatedAt', type: 'INTEGER', notNull: true },
    ],
    writeMode: 'write-behind',
    keyOf: (row) => row.key,
    toValue: (row) => ({
      deviceId: row.deviceId,
      level: row.level,
      updatedAt: row.updatedAt,
    }),
    fromRecord: (key, data) => {
      const level = Number(data['level'])
      const deviceId = Number(data['deviceId'])
      const updatedAt = Number(data['updatedAt'])
      if (!Number.isFinite(level) || !Number.isFinite(deviceId)) return null
      return { key, deviceId, level, updatedAt }
    },
    // The FACT is the level. `updatedAt` moves on every write and is not part
    // of it — a structural compare would call every repeat a flip.
    equalFact: (held, incoming) => held.level === incoming.level,
    deviceIdOf: (row) => row.deviceId,
    ...overrides,
  }
}

function row(key: string, level: number, at = T0): Row {
  return { key, deviceId: 102, level, updatedAt: at }
}

function freshLedger(
  world: InMemoryRecords,
  overrides: Partial<DurableLedgerSpec<Row>> = {},
): DurableLedger<Row> {
  return new DurableLedger<Row>({
    spec: spec(overrides),
    kind: world.records.kind(testKinds['durable-rows']),
    logger: makeSilentLogger(),
  })
}

describe('DurableLedger verdicts', () => {
  let world: InMemoryRecords
  let ledger: DurableLedger<Row>

  beforeEach(() => {
    world = freshWorld()
    ledger = freshLedger(world)
  })

  it('SEEDS a key it has never held, and DISCARDS a repeat of the same fact', () => {
    expect(ledger.observe(row('a', 1))).toBe('seeded')
    expect(ledger.observe(row('a', 1, T0 + 5_000))).toBe('no-flip')
    // CONTROL: a genuine change is still a flip, so `no-flip` above is not
    // "this ledger never flips".
    expect(ledger.observe(row('a', 2, T0 + 6_000))).toBe('flip')
  })

  it('a no-flip leaves the held row untouched — the row means "last CHANGED"', () => {
    ledger.observe(row('a', 1, T0))
    ledger.observe(row('a', 1, T0 + 60_000))
    expect(ledger.get('a')?.updatedAt).toBe(T0)
  })

  it('keys are independent — one key flipping says nothing about another', () => {
    ledger.observe(row('a', 1))
    expect(ledger.observe(row('b', 1))).toBe('seeded')
    expect(ledger.observe(row('a', 1))).toBe('no-flip')
  })

  it('refuses observe() when the owner declared no equalFact — mechanics never guess the fact', () => {
    const noFact = freshLedger(world, { equalFact: undefined })
    expect(() => noFact.observe(row('a', 1))).toThrow(/equalFact/)
  })
})

describe('DurableLedger durability', () => {
  it('a fact accepted before a restart is reloaded — the restart flips NOTHING', async () => {
    const world = freshWorld()
    const before = freshLedger(world)
    before.observe(row('a', 1))
    before.observe(row('b', 7))
    await Promise.resolve()

    // A fresh instance over the SAME store IS the restart.
    const after = freshLedger(world)
    expect((await after.load()).length).toBe(2)
    expect(after.observe(row('a', 1, T0 + 60_000))).toBe('no-flip')
    expect(after.observe(row('b', 7, T0 + 60_000))).toBe('no-flip')
    // CONTROL: a real change after the restart still gets through.
    expect(after.observe(row('a', 2, T0 + 61_000))).toBe('flip')
  })

  it('D49: a load that FAILS keeps the memory it has and never widens the gate', async () => {
    const world = freshWorld()
    const broken = freshLedger(world)
    broken.observe(row('a', 1))
    world.failReads(true)
    expect((await broken.load()).length).toBe(1)
    expect(broken.get('a')?.level).toBe(1)
    // The failure direction: the held fact still discards its repeat.
    expect(broken.observe(row('a', 1))).toBe('no-flip')
  })

  it('an EMPTY ledger seeds rather than flips — a cold read costs a silence, not a storm', async () => {
    const world = freshWorld()
    const cold = freshLedger(world)
    expect((await cold.load()).length).toBe(0)
    expect(cold.observe(row('a', 1))).toBe('seeded')
  })

  it('a malformed stored row is SKIPPED — it can never become a phantom flip', async () => {
    const world = freshWorld()
    const ledger = freshLedger(world)
    world.seed('durable-rows', {
      id: 'a',
      data: { deviceId: 102, level: 'perhaps', updatedAt: T0 },
    })
    // CONTROL: a well-formed row alongside it DOES load.
    world.seed('durable-rows', { id: 'b', data: { deviceId: 102, level: 3, updatedAt: T0 } })
    expect((await ledger.load()).length).toBe(1)
    expect(ledger.observe(row('a', 1))).toBe('seeded')
    expect(ledger.observe(row('b', 3))).toBe('no-flip')
  })

  it('a persist that fails never changes the verdict the caller already got', async () => {
    const world = freshWorld()
    world.failWrites(true)
    const ledger = freshLedger(world)
    expect(ledger.observe(row('a', 1))).toBe('seeded')
    await Promise.resolve()
    expect(ledger.observe(row('a', 1))).toBe('no-flip')
  })
})

describe('DurableLedger write modes', () => {
  it('write-through leaves NO phantom in RAM when the store refuses', async () => {
    const world = freshWorld()
    world.failWrites(true)
    const ledger = freshLedger(world, { writeMode: 'write-through' })
    await expect(ledger.put(row('a', 1))).rejects.toThrow('records engine unreachable')
    expect(ledger.get('a')).toBeUndefined()
  })

  it('write-behind keeps the mirror even when the store refuses', async () => {
    const world = freshWorld()
    world.failWrites(true)
    const ledger = freshLedger(world)
    await ledger.put(row('a', 1))
    expect(ledger.get('a')?.level).toBe(1)
  })

  it('write-through persists before it mirrors, and the row survives a restart', async () => {
    const world = freshWorld()
    const before = freshLedger(world, { writeMode: 'write-through' })
    await before.put(row('a', 4))
    const after = freshLedger(world, { writeMode: 'write-through' })
    expect(await after.load()).toEqual([{ key: 'a', deviceId: 102, level: 4, updatedAt: T0 }])
  })
})

describe('DurableLedger pruning', () => {
  it('pruneExcept drops exactly the keys outside the active set, mirror and store', async () => {
    const world = freshWorld()
    const ledger = freshLedger(world)
    await ledger.put(row('a', 1))
    await ledger.put(row('b', 2))
    await ledger.put(row('c', 3))

    expect(await ledger.pruneExcept(new Set(['a', 'c']))).toBe(1)
    expect(ledger.snapshot().map((r) => r.key)).toEqual(['a', 'c'])

    const reloaded = freshLedger(world)
    expect((await reloaded.load()).map((r) => r.key).toSorted()).toEqual(['a', 'c'])
  })

  it('forget drops one key and it stays gone across a reload', async () => {
    const world = freshWorld()
    const ledger = freshLedger(world)
    await ledger.put(row('a', 1))
    await ledger.put(row('b', 2))
    await ledger.forget('a')
    expect(ledger.has('a')).toBe(false)

    const reloaded = freshLedger(world)
    expect((await reloaded.load()).map((r) => r.key)).toEqual(['b'])
  })
})
