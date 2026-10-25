/**
 * Named retrain collections — the ledger and its membership.
 *
 * Pins the operator decisions in docs/design/named-training-collections.md:
 * names are unique case-insensitively and never empty; a collection is a
 * named SET over the one retrain corpus (a frame can be in several), so its
 * count is its membership and deleting it removes the membership, not
 * someone else's frame.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import type { RecordKindHandle, RecordsAccess } from '@camstack/types'
import { analyticsLedgers, makeAnalyticsRecords } from '../../__tests__/fake-records.js'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import { RetrainCollectionStore } from '../retrain-collection-store.js'

/** `records` whose `query` round trips throw while `fault()` names a message; every other call passes through. */
function queryFaulting(
  base: Pick<RecordsAccess, 'kind' | 'transact'>,
  fault: () => string | null,
): Pick<RecordsAccess, 'kind' | 'transact'> {
  const wrap = <T>(h: RecordKindHandle<T>): RecordKindHandle<T> => ({
    name: h.name,
    get: (id) => h.get(id),
    getMany: (ids) => h.getMany(ids),
    getResolved: (id) => h.getResolved(id),
    put: (input, opts) => h.put(input, opts),
    putMany: (inputs) => h.putMany(inputs),
    patch: (id, partial, opts) => h.patch(id, partial, opts),
    delete: (id) => h.delete(id),
    deleteMany: (ids) => h.deleteMany(ids),
    query: async (q, opts) => {
      const message = fault()
      if (message !== null) throw new Error(message)
      return h.query(q, opts)
    },
    count: (q) => h.count(q),
    histogram: (q) => h.histogram(q),
    aggregate: (q) => h.aggregate(q),
    deleteWhere: (q) => h.deleteWhere(q),
    allocateId: () => h.allocateId(),
    txPut: (input, opts) => h.txPut(input, opts),
    txPatch: (id, partial, opts) => h.txPatch(id, partial, opts),
    txDelete: (id) => h.txDelete(id),
  })
  return {
    kind: (definition) => wrap(base.kind(definition)),
    transact: (ops) => base.transact(ops),
  }
}

interface Harness {
  readonly store: RetrainCollectionStore
  /** Make every following `query` round trip throw `message` (`null` = stop). */
  readonly failQueries: (message: string | null) => void
  readonly tick: () => void
}

async function makeHarness(): Promise<Harness> {
  const world = await makeAnalyticsRecords()
  let queryFault: string | null = null
  const ledgers = analyticsLedgers(queryFaulting(world.records, () => queryFault))
  let n = 0
  let now = 1_700_000_000_000
  const store = new RetrainCollectionStore({
    collectionLedger: ledgers.retrainCollections,
    membershipLedger: ledgers.retrainCollectionFrames,
    logger: makeSilentLogger(),
    now: () => now,
    newId: () => `col-${++n}`,
  })
  return {
    store,
    failQueries: (message) => {
      queryFault = message
    },
    tick: () => {
      now += 1000
    },
  }
}

describe('RetrainCollectionStore', () => {
  let h: Harness

  beforeEach(async () => {
    h = await makeHarness()
  })

  it('creates a collection and lists it', async () => {
    const created = await h.store.create({ name: '  packages porch  ' })
    expect(created).toEqual({
      kind: 'created',
      collection: {
        id: 'col-1',
        name: 'packages porch',
        createdAt: 1_700_000_000_000,
        frameCount: 0,
      },
    })
    expect(await h.store.list()).toEqual([
      { id: 'col-1', name: 'packages porch', createdAt: 1_700_000_000_000, frameCount: 0 },
    ])
  })

  it('refuses an empty name and writes nothing', async () => {
    expect(await h.store.create({ name: '   ' })).toEqual({ kind: 'refused', reason: 'empty-name' })
    expect(await h.store.list()).toEqual([])
  })

  it('refuses a duplicate name (case-insensitive)', async () => {
    expect((await h.store.create({ name: 'Cars' })).kind).toBe('created')
    expect(await h.store.create({ name: 'cars' })).toEqual({
      kind: 'refused',
      reason: 'duplicate-name',
    })
    expect((await h.store.list()).length).toBe(1)
  })

  it('renames, refusing an empty, a taken or an unknown name — and allows a case change', async () => {
    await h.store.create({ name: 'Cars' })
    h.tick()
    await h.store.create({ name: 'Night' })
    expect(await h.store.rename({ id: 'col-1', name: 'night' })).toEqual({
      kind: 'refused',
      reason: 'duplicate-name',
    })
    expect(await h.store.rename({ id: 'col-1', name: ' ' })).toEqual({
      kind: 'refused',
      reason: 'empty-name',
    })
    expect(await h.store.rename({ id: 'nope', name: 'x' })).toEqual({
      kind: 'refused',
      reason: 'unknown-collection',
    })
    expect(await h.store.rename({ id: 'col-1', name: 'CARS' })).toMatchObject({
      kind: 'renamed',
      collection: { id: 'col-1', name: 'CARS' },
    })
    expect(await h.store.rename({ id: 'col-1', name: 'False-positive cars' })).toMatchObject({
      kind: 'renamed',
    })
    expect((await h.store.list()).map((c) => c.name)).toEqual(['Night', 'False-positive cars'])
  })

  it('membership: a frame joins once, counts per collection, and a frame can be in several', async () => {
    await h.store.create({ name: 'a' })
    await h.store.create({ name: 'b' })
    expect(await h.store.addFrame({ collectionId: 'col-1', frameId: 'f1', deviceId: 101 })).toBe(
      true,
    )
    expect(await h.store.addFrame({ collectionId: 'col-1', frameId: 'f1', deviceId: 101 })).toBe(
      false,
    )
    await h.store.addFrame({ collectionId: 'col-1', frameId: 'f2', deviceId: 101 })
    await h.store.addFrame({ collectionId: 'col-2', frameId: 'f1', deviceId: 101 })

    expect(await h.store.listFrameIds('col-1')).toEqual(['f1', 'f2'])
    const counts = new Map((await h.store.list()).map((c) => [c.id, c.frameCount]))
    expect(counts.get('col-1')).toBe(2)
    expect(counts.get('col-2')).toBe(1)
    const of = await h.store.collectionsOf(['f1', 'f2', 'f3'])
    expect(of.get('f1')).toEqual(['col-1', 'col-2'])
    expect(of.get('f2')).toEqual(['col-1'])
    expect(of.has('f3')).toBe(false)
  })

  it('removing a frame removes only that membership', async () => {
    await h.store.create({ name: 'a' })
    await h.store.addFrame({ collectionId: 'col-1', frameId: 'f1', deviceId: 101 })
    expect(await h.store.removeFrame({ collectionId: 'col-1', frameId: 'f1' })).toBe(true)
    expect(await h.store.removeFrame({ collectionId: 'col-1', frameId: 'f1' })).toBe(false)
    expect(await h.store.listFrameIds('col-1')).toEqual([])
  })

  it('delete removes the collection and its memberships, and reports the members', async () => {
    await h.store.create({ name: 'a' })
    await h.store.create({ name: 'b' })
    await h.store.addFrame({ collectionId: 'col-1', frameId: 'f1', deviceId: 101 })
    await h.store.addFrame({ collectionId: 'col-2', frameId: 'f1', deviceId: 101 })

    expect(await h.store.delete('col-1')).toEqual({ deleted: true, memberFrameIds: ['f1'] })
    expect(await h.store.delete('col-1')).toEqual({ deleted: false, memberFrameIds: [] })
    expect((await h.store.list()).map((c) => c.id)).toEqual(['col-2'])
    expect((await h.store.collectionsOf(['f1'])).get('f1')).toEqual(['col-2'])
    // The name is free again.
    expect((await h.store.create({ name: 'A' })).kind).toBe('created')
  })

  it('a failed membership read FAILS the delete rather than reporting no members', async () => {
    await h.store.create({ name: 'a' })
    await h.store.addFrame({ collectionId: 'col-1', frameId: 'f1', deviceId: 101 })
    h.failQueries('store down')
    await expect(h.store.delete('col-1')).rejects.toThrow('store down')
    h.failQueries(null)
    expect((await h.store.list()).map((c) => c.id)).toEqual(['col-1'])
  })
})
