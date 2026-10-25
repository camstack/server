/**
 * The vector-index orphan scan.
 *
 * Every fixture here is built so the two outcomes it separates are VISIBLY
 * different numbers. A fixture whose "kept" and "reclaimed" are both zero
 * proves nothing — it passes with the implementation reverted, and this repo
 * has shipped three such tests in one week.
 */
import { describe, expect, it } from 'vitest'
import { makeSilentLogger } from '../../__tests__/test-helpers.js'
import {
  type EmbeddingOrphanScanDeps,
  type EmbeddingOrphanScanLimits,
  scanEmbeddingOrphans,
  type VectorOrphanScanPage,
} from '../embedding-orphan-scan.js'

const NOW = 1_700_000_000_000
const OLD = NOW - 48 * 60 * 60 * 1000

interface FakeRow {
  readonly id: string
  readonly ownerId: string | null
  readonly timestamp: number | null
}

/** An index of `rows`, paged the way the real backend pages: ordered, cursored. */
function makeIndex(rows: readonly FakeRow[]) {
  const live = new Set<string>()
  const held = new Map<string, FakeRow>(rows.map((r) => [r.id, r]))
  const calls = { reclaim: 0, probe: 0 }

  const scanPage = async (cursor: number, limit: number): Promise<VectorOrphanScanPage> => {
    const all = [...held.values()]
    const page = all.slice(cursor, cursor + limit)
    return {
      rows: page.map((r) => ({
        id: r.id,
        ownerId: r.ownerId,
        deviceId: 102,
        timestamp: r.timestamp,
      })),
      nextCursor: cursor + page.length >= all.length ? null : cursor + page.length,
    }
  }

  const deps: EmbeddingOrphanScanDeps = {
    scope: 'vector-index:object-clip-test',
    scanPage,
    liveOwnerIds: async (ids) => {
      calls.probe += 1
      return new Set(ids.filter((id) => live.has(id)))
    },
    reclaim: async (ids) => {
      calls.reclaim += 1
      const deleted: string[] = []
      for (const id of ids) {
        held.delete(id)
        deleted.push(id)
      }
      return { deleted, stillPresent: [] }
    },
    now: () => NOW,
    logger: makeSilentLogger(),
  }
  return { deps, live, held, calls }
}

const RECLAIM: EmbeddingOrphanScanLimits = {
  mode: 'reclaim',
  graceMs: 60 * 60 * 1000,
  pageSize: 2,
  maxRows: 1_000,
  maxReclaim: 1_000,
}

describe('scanEmbeddingOrphans — a row whose track still exists is never reclaimed', () => {
  it('keeps the live rows and reclaims only the dead ones, and the two counts differ', async () => {
    const index = makeIndex([
      { id: 't-live-1', ownerId: 't-live-1', timestamp: OLD },
      { id: 't-dead-1', ownerId: 't-dead-1', timestamp: OLD },
      { id: 't-live-2', ownerId: 't-live-2', timestamp: OLD },
      { id: 't-dead-2', ownerId: 't-dead-2', timestamp: OLD },
      { id: 't-live-3', ownerId: 't-live-3', timestamp: OLD },
    ])
    index.live.add('t-live-1')
    index.live.add('t-live-2')
    index.live.add('t-live-3')

    const report = await scanEmbeddingOrphans(index.deps, RECLAIM, 0)

    // The load-bearing assertion pair: BOTH non-zero, and different.
    expect(report.kept).toBe(3)
    expect(report.reclaimed).toBe(2)
    expect(report.examined).toBe(5)
    // And the survivors are exactly the live ones — a count alone could be
    // satisfied by reclaiming the wrong two.
    expect([...index.held.keys()].sort()).toEqual(['t-live-1', 't-live-2', 't-live-3'])
  })

  it('reclaims NOTHING when every track is live — the disarm counterpart', async () => {
    const index = makeIndex([
      { id: 'a', ownerId: 'a', timestamp: OLD },
      { id: 'b', ownerId: 'b', timestamp: OLD },
    ])
    index.live.add('a')
    index.live.add('b')

    const report = await scanEmbeddingOrphans(index.deps, RECLAIM, 0)

    expect(report.kept).toBe(2)
    expect(report.reclaimed).toBe(0)
    expect(index.held.size).toBe(2)
  })

  it('abandons the pass when the liveness probe throws, rather than reading it as "all dead"', async () => {
    const index = makeIndex([
      { id: 'a', ownerId: 'a', timestamp: OLD },
      { id: 'b', ownerId: 'b', timestamp: OLD },
    ])
    const deps: EmbeddingOrphanScanDeps = {
      ...index.deps,
      liveOwnerIds: async () => {
        throw new Error('track store unreachable')
      },
    }

    const report = await scanEmbeddingOrphans(deps, RECLAIM, 0)

    expect(report.stoppedBy).toBe('probe-failed')
    expect(report.reclaimed).toBe(0)
    expect(index.held.size).toBe(2)
  })

  it('never reclaims a row that names no track — counted as unresolvable', async () => {
    const index = makeIndex([
      { id: 'nameless', ownerId: null, timestamp: OLD },
      { id: 'dead', ownerId: 'dead', timestamp: OLD },
    ])

    const report = await scanEmbeddingOrphans(index.deps, RECLAIM, 0)

    expect(report.unresolvable).toBe(1)
    expect(report.reclaimed).toBe(1)
    expect(index.held.has('nameless')).toBe(true)
  })

  it('protects a row younger than the grace window even though its track is gone', async () => {
    const index = makeIndex([
      { id: 'fresh', ownerId: 'fresh', timestamp: NOW - 60_000 },
      { id: 'stale', ownerId: 'stale', timestamp: OLD },
    ])

    const report = await scanEmbeddingOrphans(index.deps, RECLAIM, 0)

    expect(report.withinGrace).toBe(1)
    expect(report.reclaimed).toBe(1)
    expect(index.held.has('fresh')).toBe(true)
  })

  it('reports a delete that did not land as NOT reclaimed', async () => {
    const index = makeIndex([{ id: 'dead', ownerId: 'dead', timestamp: OLD }])
    const deps: EmbeddingOrphanScanDeps = {
      ...index.deps,
      // The `vec0` shape this guards: the call returns and the row is still
      // there. Reporting it as reclaimed is the counter that reads as
      // verification.
      reclaim: async (ids) => ({ deleted: [], stillPresent: [...ids] }),
    }

    const report = await scanEmbeddingOrphans(deps, RECLAIM, 0)

    expect(report.orphans).toBe(1)
    expect(report.reclaimed).toBe(0)
    expect(report.notReclaimed).toBe(1)
  })

  it('report mode finds the orphans and deletes none of them', async () => {
    const index = makeIndex([
      { id: 'live', ownerId: 'live', timestamp: OLD },
      { id: 'dead', ownerId: 'dead', timestamp: OLD },
    ])
    index.live.add('live')

    const report = await scanEmbeddingOrphans(index.deps, { ...RECLAIM, mode: 'report' }, 0)

    expect(report.orphans).toBe(1)
    expect(report.kept).toBe(1)
    expect(report.reclaimed).toBe(0)
    expect(index.calls.reclaim).toBe(0)
    expect(index.held.size).toBe(2)
  })
})

describe('scanEmbeddingOrphans — the walk reaches the WHOLE index', () => {
  /**
   * The regression this exists for: enumeration used to go through a KNN whose
   * `k` sqlite-vec clamps to 4,096, so an index of 22,128 rows was examined
   * 4,096 rows at a time and reported as if it had been walked. Here the index
   * is deliberately far larger than one page.
   */
  it('pages past its page size and examines every row', async () => {
    const rows: FakeRow[] = []
    for (let i = 0; i < 25; i++) {
      rows.push({ id: `row-${String(i).padStart(3, '0')}`, ownerId: `t-${i}`, timestamp: OLD })
    }
    const index = makeIndex(rows)
    // Half live, so `kept` and `reclaimed` are both non-zero at the end.
    for (let i = 0; i < 25; i += 2) index.live.add(`t-${i}`)

    const report = await scanEmbeddingOrphans(index.deps, { ...RECLAIM, pageSize: 4 }, 0)

    expect(report.examined).toBe(25)
    expect(report.kept).toBe(13)
    expect(report.reclaimed).toBe(12)
    expect(report.stoppedBy).toBe('exhausted')
    // Walked to the end ⇒ the next run starts at the top.
    expect(report.nextCursor).toBe(0)
  })

  it('stops at the row ceiling and resumes there next run', async () => {
    const rows: FakeRow[] = []
    for (let i = 0; i < 20; i++) {
      rows.push({ id: `row-${String(i).padStart(3, '0')}`, ownerId: `t-${i}`, timestamp: OLD })
    }
    const index = makeIndex(rows)
    for (const r of rows) index.live.add(r.ownerId ?? '')

    const first = await scanEmbeddingOrphans(index.deps, { ...RECLAIM, pageSize: 4, maxRows: 8 }, 0)
    expect(first.examined).toBe(8)
    expect(first.stoppedBy).toBe('row-ceiling')
    expect(first.nextCursor).toBe(8)

    const second = await scanEmbeddingOrphans(
      index.deps,
      { ...RECLAIM, pageSize: 4, maxRows: 8 },
      first.nextCursor,
    )
    expect(second.examined).toBe(8)
    expect(second.kept).toBe(8)
  })

  it('stops at the reclaim ceiling instead of emptying the index in one pass', async () => {
    const rows: FakeRow[] = []
    for (let i = 0; i < 12; i++) {
      rows.push({ id: `row-${String(i).padStart(3, '0')}`, ownerId: `t-${i}`, timestamp: OLD })
    }
    const index = makeIndex(rows)

    const report = await scanEmbeddingOrphans(
      index.deps,
      { ...RECLAIM, pageSize: 4, maxReclaim: 5 },
      0,
    )

    expect(report.stoppedBy).toBe('reclaim-ceiling')
    expect(report.reclaimed).toBe(5)
    expect(index.held.size).toBe(7)
  })
})
