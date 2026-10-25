/**
 * The census is the instrument every attribution in this work rests on, so it
 * is tested for the two ways an instrument lies: pointing at ITSELF (the stack
 * cut is wrong and every read is attributed to the wrapper), and counting
 * while nobody asked (the arm window does not close).
 */

import { describe, expect, it, vi } from 'vitest'
import {
  CENSUS_MAX_WINDOW_MS,
  censusApi,
  censusStoreClient,
  compactFrame,
  StoreReadCensus,
  siteFromStack,
} from '../read-census.js'

interface FakeClock {
  now: () => number
  advance: (ms: number) => void
}

function fakeClock(start = 1_000): FakeClock {
  let t = start
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    },
  }
}

/**
 * The shape `censusStoreClient` actually wraps.
 *
 * The generated client is a **tRPC proxy**, and every intermediate node of a
 * tRPC proxy is a CALLABLE — `typeof client.query === 'function'`, not
 * `'object'`. The first version of the wrapper tested for `'object'` and
 * therefore passed the whole store client straight through: it deployed to the
 * live hub, ran for three minutes and reported ZERO `query` and ZERO `count`
 * call sites, on a table the engine was recording thousands of calls against.
 * The fake is callable for exactly that reason — a plain object fake is a fake
 * that agrees with the bug.
 */
function fakeStoreClient(rows: readonly unknown[]) {
  const node = <T>(impl: (..._args: unknown[]) => Promise<T>) =>
    Object.assign(() => undefined, { query: impl, mutate: impl })
  return {
    query: node(async () => rows),
    count: node(async () => rows.length),
    set: node(async () => undefined),
  }
}

describe('compactFrame', () => {
  it('reduces a named V8 frame to Function@line', () => {
    expect(
      compactFrame('    at TrackStore.countStaging (file:///data/addons/x/dist/index.mjs:1563:24)'),
    ).toBe('TrackStore.countStaging@1563')
  })

  it('keeps an anonymous frame as @line rather than dropping it', () => {
    expect(compactFrame('    at file:///data/addons/x/dist/index.mjs:4482:11')).toBe('@4482')
  })
})

describe('siteFromStack', () => {
  it('keeps three frames, innermost first', () => {
    const stack = [
      'Error',
      '    at a (f.mjs:1:1)',
      '    at b (f.mjs:2:1)',
      '    at c (f.mjs:3:1)',
      '    at d (f.mjs:4:1)',
    ].join('\n')
    expect(siteFromStack(stack)).toBe('a@1 < b@2 < c@3')
  })
})

describe('StoreReadCensus', () => {
  it('counts nothing until armed, and nothing after the window closes', () => {
    const clock = fakeClock()
    const census = new StoreReadCensus(clock.now)
    const read = (): void => {
      census.record('query', census.siteOf(read), [1, 2])
    }

    read()
    expect(census.rows()).toHaveLength(0)

    census.arm(60_000)
    read()
    expect(census.rows()).toHaveLength(1)

    clock.advance(60_001)
    read()
    expect(census.rows()[0]?.calls).toBe(1)
  })

  it('clamps an oversized arm to the maximum window', () => {
    const clock = fakeClock()
    const census = new StoreReadCensus(clock.now)
    census.arm(CENSUS_MAX_WINDOW_MS * 10)
    clock.advance(CENSUS_MAX_WINDOW_MS + 1)
    expect(census.armed).toBe(false)
  })

  it('re-arming clears the previous window', () => {
    const clock = fakeClock()
    const census = new StoreReadCensus(clock.now)
    census.arm(60_000)
    census.record('query', 'somewhere', [1])
    census.arm(60_000)
    expect(census.rows()).toHaveLength(0)
  })

  it('elapsedMs stops at the end of the window, so a rate stays divisible', () => {
    const clock = fakeClock()
    const census = new StoreReadCensus(clock.now)
    census.arm(60_000)
    clock.advance(90_000)
    expect(census.elapsedMs()).toBe(60_000)
  })
})

describe('censusStoreClient', () => {
  it('attributes the read to the CALLER, never to the census wrapper', async () => {
    const census = new StoreReadCensus()
    census.arm(60_000)
    const client = censusStoreClient(fakeStoreClient([{ id: 'a' }, { id: 'b' }]), census)

    async function sweepStagingRetention(): Promise<void> {
      await client.query.query()
    }
    await sweepStagingRetention()

    const rows = census.rows()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.op).toBe('query')
    expect(rows[0]?.rows).toBe(2)
    // The instrument must not point at itself: no frame of `read-census` may
    // appear, and the caller must.
    expect(rows[0]?.site).toContain('sweepStagingRetention')
    expect(rows[0]?.site).not.toContain('censusStoreClient')
    expect(rows[0]?.site).not.toContain('StoreReadCensus.record')
  })

  it('counts a `count` procedure by the number it returned', async () => {
    const census = new StoreReadCensus()
    census.arm(60_000)
    const client = censusStoreClient(fakeStoreClient([1, 2, 3]), census)
    await client.count.query()
    expect(census.rows()[0]).toMatchObject({ op: 'count', calls: 1, rows: 3 })
  })

  it('passes writes through uncounted and unaltered', async () => {
    const census = new StoreReadCensus()
    census.arm(60_000)
    const mutate = vi.fn(async (_input: { collection: string }) => undefined)
    const client = censusStoreClient<{ set: { mutate: typeof mutate } }>(
      { set: { mutate } },
      census,
    )
    await client.set.mutate({ collection: 'x' })
    expect(mutate).toHaveBeenCalledWith({ collection: 'x' })
    expect(census.rows()).toHaveLength(0)
  })
})

describe('censusStoreClient — the site is taken before the await', () => {
  it('names the caller even when the caller AWAITS the read', async () => {
    // The regression this exists for: capturing the stack after the wrapped
    // promise resolved reported `Proxy.<anonymous> < processTicksAndRejections`
    // — the census describing itself — for every caller that awaits, which is
    // nearly all of them. A caller that RETURNS the promise happened to keep
    // working, which is why one test passed while the instrument was blind.
    const census = new StoreReadCensus()
    census.arm(60_000)
    const client = censusStoreClient(fakeStoreClient([{ id: 'a' }]), census)

    async function sweepRetention(): Promise<void> {
      await client.query.query()
    }
    await sweepRetention()

    expect(census.rows()[0]?.site).toContain('sweepRetention')
    expect(census.rows()[0]?.site).not.toContain('processTicksAndRejections')
  })
})

describe('censusApi', () => {
  it('censuses settingsStore reached through the api object, and memoises it', async () => {
    const census = new StoreReadCensus()
    census.arm(60_000)
    const api = censusApi(
      { settingsStore: fakeStoreClient([1, 2]), other: { untouched: true } },
      census,
    )

    expect(api.settingsStore).toBe(api.settingsStore)
    expect(api.other).toEqual({ untouched: true })

    async function listByOwner(): Promise<void> {
      await api.settingsStore.query.query()
    }
    await listByOwner()

    expect(census.rows()[0]?.site).toContain('listByOwner')
  })
})
