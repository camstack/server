/**
 * A `transact` is ONE transaction, and a transaction is one file (D851). Ops
 * that resolve to two files are refused whole — before anything is written —
 * with a typed error; ops inside one file stay atomic.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { CrossDatabaseTransactError } from '../placement-errors.js'
import { ledgerDeclaration, makeHarness, type Harness } from './support/owned-files-harness.js'

let harness: Harness | null = null
afterEach(() => {
  harness?.cleanup()
  harness = null
})

describe('transact across files', () => {
  it('refuses ops that span two files and writes nothing', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('xdb:config'))
    await router.declareCollection(ledgerDeclaration('xdb:ledger', 'events'))

    const attempt = router.transact({
      ops: [
        { op: 'insertMany', collection: 'xdb:config', records: [{ id: 'c1', data: { atMs: 1 } }] },
        { op: 'insertMany', collection: 'xdb:ledger', records: [{ id: 'l1', data: { atMs: 1 } }] },
      ],
    })
    await expect(attempt).rejects.toBeInstanceOf(CrossDatabaseTransactError)
    await expect(attempt).rejects.toThrow(/settings, events|events, settings/)
    expect(await router.count({ collection: 'xdb:config' })).toBe(0)
    expect(await router.count({ collection: 'xdb:ledger' })).toBe(0)
    await harness.stopAll(router)
  })

  it('a guard in one file and ops in another is also refused', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('xdb:config'))
    await router.declareCollection(ledgerDeclaration('xdb:ledger', 'events'))
    await expect(
      router.transact({
        guard: { collection: 'xdb:config', key: 'k', column: 'atMs', equals: 1 },
        ops: [{ op: 'insertMany', collection: 'xdb:ledger', records: [{ id: 'l1', data: {} }] }],
      }),
    ).rejects.toBeInstanceOf(CrossDatabaseTransactError)
    await harness.stopAll(router)
  })

  it('ops inside one non-settings file run as one transaction through its worker', async () => {
    harness = makeHarness()
    const router = await harness.router()
    await router.declareCollection(ledgerDeclaration('xdb:a', 'events'))
    await router.declareCollection(ledgerDeclaration('xdb:b', 'events'))
    const result = await router.transact({
      ops: [
        { op: 'insertMany', collection: 'xdb:a', records: [{ id: 'a1', data: { atMs: 1 } }] },
        { op: 'insertMany', collection: 'xdb:b', records: [{ id: 'b1', data: { atMs: 2 } }] },
      ],
    })
    expect(result.applied).toBe(true)
    expect(await router.count({ collection: 'xdb:a' })).toBe(1)
    expect(await router.count({ collection: 'xdb:b' })).toBe(1)

    // A throw inside the file rolls the whole call back.
    await expect(
      router.transact({
        ops: [
          { op: 'insertMany', collection: 'xdb:a', records: [{ id: 'a2', data: { atMs: 3 } }] },
          { op: 'insertMany', collection: 'xdb:b', records: [{ id: 'b1', data: { atMs: 4 } }] },
        ],
      }),
    ).rejects.toThrow()
    expect(await router.count({ collection: 'xdb:a' })).toBe(1)
    await harness.stopAll(router)
  })
})
