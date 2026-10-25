/**
 * The drain must tolerate a row it will not delete — D59's blocker, tested.
 *
 * The old loop stopped on "a non-empty page deleted nothing", so a single
 * undeletable track halted retention for that whole device and let everything
 * behind it accumulate. That is why D59 concluded a per-track pin could not be
 * built. These tests pin the replacement AND its termination.
 */
import { describe, expect, it } from 'vitest'
import { drainTracksBefore, type TrackDrainDeps } from '../track-drain.js'

/** A fake store: `undeletable` ids are returned by every query and never go. */
function store(input: { ids: readonly string[]; undeletable?: readonly string[] }): {
  deps: TrackDrainDeps
  remaining: () => readonly string[]
  queries: () => number
} {
  const undeletable = new Set(input.undeletable ?? [])
  let rows = [...input.ids]
  let queries = 0
  const deps: TrackDrainDeps = {
    listIdsBefore: async (offset, limit) => {
      queries += 1
      return rows.slice(offset, offset + limit)
    },
    cascade: async (ids) => {
      const doomed = ids.filter((id) => !undeletable.has(id))
      rows = rows.filter((id) => !doomed.includes(id))
      return { deleted: doomed.length }
    },
    stopped: () => false,
  }
  return { deps, remaining: () => rows, queries: () => queries }
}

describe('drainTracksBefore', () => {
  it('drains a clean set completely', async () => {
    const s = store({ ids: ['a', 'b', 'c', 'd', 'e'] })
    const r = await drainTracksBefore(s.deps, 2)
    expect(r.deleted).toBe(5)
    expect(r.skipped).toBe(0)
    expect(s.remaining()).toEqual([])
  })

  it('steps OVER an undeletable row and keeps draining behind it', async () => {
    // The whole point. 'pinned' is returned by every query and never deleted.
    // The old loop saw a non-empty page that deleted nothing and stopped,
    // leaving c/d/e behind the pin forever.
    const s = store({ ids: ['pinned', 'c', 'd', 'e'], undeletable: ['pinned'] })
    const r = await drainTracksBefore(s.deps, 1)
    expect(r.deleted).toBe(3)
    expect(r.skipped).toBe(1)
    expect(s.remaining()).toEqual(['pinned'])
  })

  it('terminates when EVERY row is undeletable', async () => {
    const s = store({ ids: ['p1', 'p2', 'p3'], undeletable: ['p1', 'p2', 'p3'] })
    const r = await drainTracksBefore(s.deps, 2)
    expect(r.deleted).toBe(0)
    expect(r.skipped).toBe(3)
    expect(s.remaining()).toEqual(['p1', 'p2', 'p3'])
    // Bounded: it cannot have spun. 3 rows at page 2 → 2 pages, then empty.
    expect(r.pages).toBeLessThanOrEqual(3)
  })

  it('handles undeletable rows interleaved with deletable ones', async () => {
    const ids = ['a', 'p1', 'b', 'p2', 'c', 'd']
    const s = store({ ids, undeletable: ['p1', 'p2'] })
    const r = await drainTracksBefore(s.deps, 2)
    expect(r.deleted).toBe(4)
    expect(r.skipped).toBe(2)
    expect(s.remaining()).toEqual(['p1', 'p2'])
  })

  it('a pinned row at the HEAD does not hide the tail', async () => {
    // Ordering is oldest-first, so a pin on the oldest track is the worst case:
    // it sits in front of everything the sweep is there to remove.
    const ids = ['pinned', ...Array.from({ length: 50 }, (_v, i) => `t-${i}`)]
    const s = store({ ids, undeletable: ['pinned'] })
    const r = await drainTracksBefore(s.deps, 10)
    expect(r.deleted).toBe(50)
    expect(s.remaining()).toEqual(['pinned'])
  })

  it('stops immediately when the addon is shutting down', async () => {
    const s = store({ ids: ['a', 'b'] })
    const r = await drainTracksBefore({ ...s.deps, stopped: () => true }, 10)
    expect(r.deleted).toBe(0)
    expect(r.pages).toBe(0)
    expect(s.queries()).toBe(0)
  })
})
