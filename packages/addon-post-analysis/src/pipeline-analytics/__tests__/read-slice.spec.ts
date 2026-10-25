/**
 * `readSliceOnce` — the fix for a cache miss that could never be satisfied.
 *
 * The case that matters is the EMPTY one: the readers this replaced tested
 * `cached.length > 0`, so a camera that legitimately has no zones and a camera
 * whose slice had not loaded looked identical, and the former re-fetched on
 * every call forever. The `does not refresh` test below is the discriminating
 * one — the old code fails it.
 */

import type { SliceHandle } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { readSliceOnce } from '../read-slice.js'

interface ZonesSlice {
  readonly zones: readonly string[]
}

interface FakeHandle {
  readonly handle: SliceHandle<ZonesSlice>
  readonly refreshCount: () => number
}

/**
 * A slice handle whose `refresh()` is counted, and which optionally starts
 * unloaded and becomes `onRefresh` once refreshed.
 */
function makeHandle(initial: ZonesSlice | undefined, onRefresh?: ZonesSlice): FakeHandle {
  let value = initial
  let refreshes = 0
  const handle: SliceHandle<ZonesSlice> = {
    get value() {
      return value
    },
    refresh: async () => {
      refreshes += 1
      if (onRefresh !== undefined) value = onRefresh
    },
    subscribe: () => () => undefined,
    set: async () => undefined,
    patch: async () => undefined,
  }
  return { handle, refreshCount: () => refreshes }
}

describe('readSliceOnce', () => {
  it('does not refresh a slice that is loaded but EMPTY', async () => {
    // The discriminating case. `cached.length > 0` treats this as a miss and
    // pays a round-trip on every call; 15 of 16 cameras live here.
    const { handle, refreshCount } = makeHandle({ zones: [] })

    const first = await readSliceOnce(handle)
    const second = await readSliceOnce(handle)
    const third = await readSliceOnce(handle)

    expect(first).toEqual({ zones: [] })
    expect(second).toEqual({ zones: [] })
    expect(third).toEqual({ zones: [] })
    expect(refreshCount()).toBe(0)
  })

  it('does not refresh a slice that is loaded and non-empty', async () => {
    const { handle, refreshCount } = makeHandle({ zones: ['front'] })
    expect(await readSliceOnce(handle)).toEqual({ zones: ['front'] })
    expect(refreshCount()).toBe(0)
  })

  it('refreshes exactly once when the slice has never loaded', async () => {
    const { handle, refreshCount } = makeHandle(undefined, { zones: ['back'] })
    expect(await readSliceOnce(handle)).toEqual({ zones: ['back'] })
    expect(refreshCount()).toBe(1)
  })

  it('stops refreshing once a refresh has loaded the slice', async () => {
    const { handle, refreshCount } = makeHandle(undefined, { zones: [] })
    await readSliceOnce(handle)
    await readSliceOnce(handle)
    await readSliceOnce(handle)
    // One fetch total, even though what it loaded was empty.
    expect(refreshCount()).toBe(1)
  })

  it('returns undefined when the slice never loads, without throwing', async () => {
    const { handle, refreshCount } = makeHandle(undefined)
    expect(await readSliceOnce(handle)).toBeUndefined()
    expect(refreshCount()).toBe(1)
  })

  it('swallows a failing refresh — a zone read never fails its caller', async () => {
    let refreshes = 0
    const handle: SliceHandle<ZonesSlice> = {
      value: undefined,
      refresh: async () => {
        refreshes += 1
        throw new Error('hub unreachable')
      },
      subscribe: () => () => undefined,
      set: async () => undefined,
      patch: async () => undefined,
    }
    await expect(readSliceOnce(handle)).resolves.toBeUndefined()
    expect(refreshes).toBe(1)
  })
})
