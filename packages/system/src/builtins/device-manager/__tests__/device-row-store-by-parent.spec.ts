/**
 * A question about a WHOLE LEVEL of the device tree must be one query.
 *
 * The boot census on the live hub, 2026-08-27, 120-second window:
 *
 *     DeviceRowStore.list < DeviceRowStore.listByParent < getChildren
 *     calls 1 024      rows 919
 *
 * One query per device, for 919 rows in total — the same N+1 `getMany` was
 * written to remove for primary-key lookups, on the `parentDeviceId` index
 * instead. `collectDescendants` walked container trees the same way, one query
 * per NODE.
 *
 * Every assertion here is on what the store ASKED THE BACKEND FOR, never on
 * the rows it returned. A per-parent loop and a `whereIn` return exactly the
 * same devices, so asserting on the answer would pass either way — which is
 * precisely the defect.
 */

import type { IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { DeviceRowBackend } from '../device-row-store.js'
import { DeviceRowStore, deviceRowBackendOf } from '../device-row-store.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

interface QueryCall {
  readonly where?: Record<string, unknown>
  readonly whereIn?: Record<string, unknown>
}

function recordingBackend(inner: DeviceRowBackend): {
  backend: DeviceRowBackend
  queries: QueryCall[]
} {
  const queries: QueryCall[] = []
  const backend: DeviceRowBackend = {
    ...inner,
    query: (input) => {
      queries.push({
        ...(input.filter?.where !== undefined ? { where: input.filter.where } : {}),
        ...(input.filter?.whereIn !== undefined ? { whereIn: input.filter.whereIn } : {}),
      })
      return inner.query(input)
    },
  }
  return { backend, queries }
}

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

/** 1 and 2 are containers; 10/11 hang off 1, 20 off 2, 30 is top-level. */
const FIXTURE: readonly { readonly id: number; readonly parentDeviceId: number | null }[] = [
  { id: 1, parentDeviceId: null },
  { id: 2, parentDeviceId: null },
  { id: 10, parentDeviceId: 1 },
  { id: 11, parentDeviceId: 1 },
  { id: 20, parentDeviceId: 2 },
  { id: 30, parentDeviceId: null },
]

async function makeStore(): Promise<{ store: DeviceRowStore; queries: QueryCall[] }> {
  const api = await makeSettingsStoreApi()
  const { backend, queries } = recordingBackend(deviceRowBackendOf(api.api))
  const store = new DeviceRowStore(backend, makeLogger())
  for (const { id, parentDeviceId } of FIXTURE) {
    await store.upsert(
      {
        id,
        addonId: 'addon-a',
        stableId: `s-${id}`,
        type: 'camera',
        name: `dev-${id}`,
        location: null,
        disabled: false,
        parentDeviceId,
      },
      { registered: true },
    )
  }
  queries.length = 0
  return { store, queries }
}

describe('DeviceRowStore.listByParentMany — one query, however many parents', () => {
  it('asks ONCE with a whereIn — not one indexed lookup per parent', async () => {
    const { store, queries } = await makeStore()

    const byParent = await store.listByParentMany([1, 2])

    expect(queries, 'two parents must cost ONE read, not two').toHaveLength(1)
    expect(queries[0]?.whereIn).toEqual({ parentDeviceId: [1, 2] })
    expect(queries[0]?.where, 'a per-parent `where` is the N+1 this replaces').toBeUndefined()
    expect([...(byParent.get(1) ?? [])].map((r) => r.meta.id)).toEqual([10, 11])
    expect([...(byParent.get(2) ?? [])].map((r) => r.meta.id)).toEqual([20])
  })

  it('answers exactly what a per-parent loop would have answered', async () => {
    const { store } = await makeStore()

    const batched = await store.listByParentMany([1, 2, 30])
    const looped = new Map<number, readonly number[]>()
    for (const parent of [1, 2, 30]) {
      const rows = await store.listByParent(parent)
      if (rows.length > 0)
        looped.set(
          parent,
          rows.map((r) => r.meta.id),
        )
    }

    expect(new Map([...batched].map(([k, v]) => [k, v.map((r) => r.meta.id)]))).toEqual(looped)
  })

  it('an EMPTY parent set reads nothing at all — never "everything"', async () => {
    const { store, queries } = await makeStore()

    const byParent = await store.listByParentMany([])

    expect(byParent.size).toBe(0)
    expect(queries, 'a request for no parents is a request, not an omission').toHaveLength(0)
  })

  it('a parent with no children is ABSENT from the map, never an empty row', async () => {
    const { store } = await makeStore()

    const byParent = await store.listByParentMany([1, 30, 4242])

    expect(byParent.has(1)).toBe(true)
    expect(byParent.has(30), 'a childless device must not be fabricated a bucket').toBe(false)
    expect(byParent.has(4242), 'a parent the fleet does not know must be absent').toBe(false)
  })

  it('deduplicates the parent set — a repeated id is one whereIn member', async () => {
    const { store, queries } = await makeStore()

    await store.listByParentMany([1, 1, 2, 1])

    expect(queries[0]?.whereIn).toEqual({ parentDeviceId: [1, 2] })
  })
})
