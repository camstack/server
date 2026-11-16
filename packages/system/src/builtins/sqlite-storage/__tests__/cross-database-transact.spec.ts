/**
 * A `transact` is ONE transaction, and a transaction is one file (D851). Ops
 * that resolve to two files are refused whole — before anything is written —
 * with a typed error; ops inside one file stay atomic.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CrossDatabaseTransactError } from '../placement-errors.js'
import { ledgerDeclaration, makeHarness, type Harness } from './support/owned-files-harness.js'

// Booting the events worker thread (tsx loader + SQLite open) is a real cost
// that scales with machine load, not with what these tests assert. It is paid
// once, in beforeAll under the hook budget, so no test races a 5 s wall clock.
const BOOT_TIMEOUT_MS = 60_000
type Router = Awaited<ReturnType<Harness['router']>>
let harness: Harness
let router: Router
beforeAll(async () => {
  harness = makeHarness()
  router = await harness.router()
  await router.declareCollection(ledgerDeclaration('xdb:config'))
  await router.declareCollection(ledgerDeclaration('xdb:ledger', 'events'))
  await router.declareCollection(ledgerDeclaration('xdb:a', 'events'))
  await router.declareCollection(ledgerDeclaration('xdb:b', 'events'))
}, BOOT_TIMEOUT_MS)
afterAll(async () => {
  await harness.stopAll(router)
  harness.cleanup()
}, BOOT_TIMEOUT_MS)

describe('transact across files', () => {
  it('refuses ops that span two files and writes nothing', async () => {
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
  })

  it('a guard in one file and ops in another is also refused', async () => {
    await expect(
      router.transact({
        guard: { collection: 'xdb:config', key: 'k', column: 'atMs', equals: 1 },
        ops: [{ op: 'insertMany', collection: 'xdb:ledger', records: [{ id: 'l1', data: {} }] }],
      }),
    ).rejects.toBeInstanceOf(CrossDatabaseTransactError)
  })

  it('ops inside one non-settings file run as one transaction through its worker', async () => {
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
  })
})
