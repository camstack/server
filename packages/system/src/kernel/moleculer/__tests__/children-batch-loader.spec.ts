/**
 * A thousand devices asking the same question must not be a thousand calls.
 *
 * The boot census on the live hub, 2026-08-27, 120-second window, 1 017
 * devices:
 *
 *     DeviceRowStore.list < DeviceRowStore.listByParent < getChildren
 *     calls 1 024      rows 919
 *
 * Every assertion here is on HOW MANY CALLS WERE MADE, never on the rows that
 * came back. A per-parent loop and a coalesced batch return exactly the same
 * children — asserting on the answer would pass either way, which is how a
 * storm survives a green suite for months.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { ReconcileChildRow } from '../children-batch-loader.js'
import {
  createChildrenBatchLoader,
  parseChildRows,
  parseChildrenByParent,
} from '../children-batch-loader.js'

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

/** One child row per parent, so a mis-routed answer is visible in the value. */
function childOf(parentDeviceId: number): ReconcileChildRow {
  return {
    id: parentDeviceId * 10,
    stableId: `child-of-${parentDeviceId}`,
    name: `Child ${parentDeviceId}`,
    linkDeviceId: parentDeviceId,
  }
}

interface Harness {
  readonly batchCalls: readonly number[][]
  readonly oneCalls: readonly number[]
}

function makeHarness(opts: {
  readonly batchDelayTicks?: number
  readonly batchFails?: (attempt: number) => Error | null
  readonly known?: ReadonlySet<number>
}): Harness & {
  readonly load: (parentDeviceId: number) => Promise<readonly ReconcileChildRow[]>
} {
  const batchCalls: number[][] = []
  const oneCalls: number[] = []
  let attempt = 0
  const known = opts.known
  const loader = createChildrenBatchLoader({
    logger: makeLogger(),
    fetchBatch: async (parentDeviceIds) => {
      batchCalls.push([...parentDeviceIds])
      attempt += 1
      const failure = opts.batchFails?.(attempt) ?? null
      for (let i = 0; i < (opts.batchDelayTicks ?? 0); i++) await Promise.resolve()
      if (failure !== null) throw failure
      const out = new Map<number, readonly ReconcileChildRow[]>()
      // A parent with no children is ABSENT — never an invented empty row.
      for (const id of parentDeviceIds) {
        if (known === undefined || known.has(id)) out.set(id, [childOf(id)])
      }
      return out
    },
    fetchOne: async (parentDeviceId) => {
      oneCalls.push(parentDeviceId)
      if (known !== undefined && !known.has(parentDeviceId)) return []
      return [childOf(parentDeviceId)]
    },
  })
  return { batchCalls, oneCalls, load: (id) => loader.load(id) }
}

describe('children batch loader — the call count IS the fix', () => {
  it('answers a fleet-sized burst in ⌈n/256⌉ calls, not n', async () => {
    const h = makeHarness({})
    const parentIds = Array.from({ length: 1017 }, (_, i) => 600 + i)

    const answers = await Promise.all(parentIds.map((id) => h.load(id)))

    // 1 017 devices reconciling at boot. Before: 1 017 RPCs.
    expect(h.batchCalls.length).toBe(4)
    expect(h.batchCalls.map((c) => c.length)).toEqual([256, 256, 256, 249])
    expect(h.oneCalls.length).toBe(0)
    // Each waiter still got ITS parent's children, not the batch's first row.
    expect(answers.map((rows) => rows[0]?.stableId)).toEqual(
      parentIds.map((id) => `child-of-${id}`),
    )
  })

  it('never exceeds the cap the cap method declares', async () => {
    const h = makeHarness({})
    await Promise.all(Array.from({ length: 700 }, (_, i) => h.load(i + 1)))
    for (const call of h.batchCalls) expect(call.length).toBeLessThanOrEqual(256)
  })

  it('collapses arrivals that land while a call is in flight into the NEXT call', async () => {
    // The boot shape: reconciles do not arrive in one turn, they arrive
    // continuously while the previous answer is still on the wire. The loader
    // is self-clocking — one call in flight, everything that arrives meanwhile
    // rides the next one.
    const h = makeHarness({ batchDelayTicks: 4 })

    const first = [1, 2, 3].map((id) => h.load(id))
    // Let the flush timer fire and the batch get in flight.
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = [4, 5, 6, 7].map((id) => h.load(id))
    await Promise.all([...first, ...second])

    expect(h.batchCalls).toEqual([
      [1, 2, 3],
      [4, 5, 6, 7],
    ])
    expect(h.oneCalls.length).toBe(0)
  })

  it('is never WORSE than the per-device path it replaces', async () => {
    // Arrivals slower than a round-trip give batches of one — exactly today's
    // cost, and the floor this can never fall below.
    const h = makeHarness({})
    for (const id of [11, 12, 13]) await h.load(id)
    expect(h.batchCalls).toEqual([[11], [12], [13]])
  })

  it('asks about each parent ONCE even when two reconciles name the same one', async () => {
    const h = makeHarness({})
    const answers = await Promise.all([h.load(42), h.load(42), h.load(43)])
    expect(h.batchCalls).toEqual([[42, 43]])
    expect(answers[0]).toEqual(answers[1])
  })

  it('reads a parent ABSENT from the answer as "no children", not as an error', async () => {
    const h = makeHarness({ known: new Set([1]) })
    const answers = await Promise.all([h.load(1), h.load(2)])
    expect(answers[0]?.length).toBe(1)
    expect(answers[1]).toEqual([])
  })
})

describe('children batch loader — degrading against a hub that predates the method', () => {
  it('falls back to per-parent getChildren, and stops re-asking for the process lifetime', async () => {
    const h = makeHarness({
      batchFails: () =>
        new Error('NOT_FOUND: No procedure found on path "deviceManager.getChildrenBatch"'),
    })

    const first = await Promise.all([h.load(1), h.load(2), h.load(3)])
    // Every waiter is ANSWERED — a reconcile is never denied its children.
    expect(first.map((rows) => rows[0]?.stableId)).toEqual([
      'child-of-1',
      'child-of-2',
      'child-of-3',
    ])
    expect(h.batchCalls.length).toBe(1)
    expect(h.oneCalls).toEqual([1, 2, 3])

    // The latch: re-probing a method this hub will never have, once per batch
    // for a whole boot, is the storm this exists to remove.
    await Promise.all([h.load(4), h.load(5)])
    expect(h.batchCalls.length).toBe(1)
    expect(h.oneCalls).toEqual([1, 2, 3, 4, 5])
  })

  it('treats a TRANSIENT failure as transient — the next batch still tries the batch', async () => {
    const h = makeHarness({
      batchFails: (attempt) => (attempt === 1 ? new Error('broker is busy') : null),
    })

    await Promise.all([h.load(1), h.load(2)])
    expect(h.oneCalls).toEqual([1, 2])

    const second = await Promise.all([h.load(3), h.load(4)])
    expect(h.batchCalls.length).toBe(2)
    expect(h.oneCalls).toEqual([1, 2])
    expect(second.map((rows) => rows[0]?.stableId)).toEqual(['child-of-3', 'child-of-4'])
  })
})

describe('children batch loader — narrowing an untyped answer', () => {
  it('reads the fields the prune step needs, and keeps a null link null', () => {
    expect(parseChildRows([{ id: 9, stableId: 's', name: 'n', linkDeviceId: null }])).toEqual([
      { id: 9, stableId: 's', name: 'n', linkDeviceId: null },
    ])
  })

  it('refuses a row missing an identity field rather than half-parsing one', () => {
    // The prune step DELETES. A row it cannot fully identify is not a row it
    // may act on.
    expect(parseChildRows([{ id: 9, stableId: 's' }])).toBeNull()
    expect(parseChildRows(undefined)).toBeNull()
  })

  it('keys a batch answer by parent id, and accepts an empty answer as "nothing to prune"', () => {
    const parsed = parseChildrenByParent({ '101': [{ id: 1, stableId: 's', name: 'n' }] })
    expect([...(parsed ?? new Map()).keys()]).toEqual([101])
    expect(parseChildrenByParent({})?.size).toBe(0)
    expect(parseChildrenByParent([])).toBeNull()
    expect(parseChildrenByParent(null)).toBeNull()
  })
})
