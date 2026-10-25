import { describe, expect, it, vi } from 'vitest'
import {
  SQLITE_ENGINE_STORM_WALL_SHARE,
  SQLITE_PROFILE_REPORT_FLOOR_MS,
  SQLITE_SLOW_CALL_MS,
  SqliteOpProfiler,
  sqliteEngineStorm,
} from '../query-profiler.js'

interface LoggedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error'
  readonly message: string
  readonly meta: Record<string, unknown>
  readonly tags: Record<string, unknown>
}

function recorder(): { lines: LoggedLine[]; logger: import('@camstack/types').IScopedLogger } {
  const lines: LoggedLine[] = []
  const push =
    (level: LoggedLine['level']) =>
    (
      message: string,
      extras?: { meta?: Record<string, unknown>; tags?: Record<string, unknown> },
    ) => {
      lines.push({ level, message, meta: extras?.meta ?? {}, tags: extras?.tags ?? {} })
    }
  const logger: import('@camstack/types').IScopedLogger = {
    debug: push('debug'),
    info: push('info'),
    warn: push('warn'),
    error: push('error'),
    child: () => logger,
    withTags: () => logger,
  }
  return { lines, logger }
}

const TRACKS = 'pipeline-analytics:tracks'

describe('SqliteOpProfiler', () => {
  it('names the operation, collection, duration and rows of a slow call at WARN', () => {
    const { lines, logger } = recorder()
    const p = new SqliteOpProfiler({ logger })

    p.record({
      op: 'query',
      collection: 'pipeline-analytics:media',
      durationMs: 4200,
      rows: 19_999,
    })

    const warns = lines.filter((l) => l.level === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]?.meta).toMatchObject({
      op: 'query',
      collection: 'pipeline-analytics:media',
      durationMs: 4200,
      rows: 19_999,
    })
  })

  it('stays silent for a call under the slow threshold', () => {
    const { lines, logger } = recorder()
    const p = new SqliteOpProfiler({ logger })

    p.record({
      op: 'get',
      collection: 'addon-settings',
      durationMs: SQLITE_SLOW_CALL_MS - 1,
      rows: 1,
    })

    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(0)
  })

  it('carries the deviceId tag when the caller supplied one', () => {
    const { lines, logger } = recorder()
    const p = new SqliteOpProfiler({ logger })

    p.record({
      op: 'query',
      collection: 'pipeline-analytics:tracks',
      durationMs: 9000,
      rows: 12,
      deviceId: 102,
    })

    expect(lines.find((l) => l.level === 'warn')?.tags).toEqual({ deviceId: 102 })
  })

  it('aggregates many fast calls so death-by-a-thousand-cuts is still visible', () => {
    const { logger } = recorder()
    const p = new SqliteOpProfiler({ logger })

    for (let i = 0; i < 500; i++) {
      p.record({ op: 'query', collection: 'pipeline-analytics:media', durationMs: 40, rows: 200 })
    }
    for (let i = 0; i < 10; i++) {
      p.record({ op: 'get', collection: 'addon-settings', durationMs: 1, rows: 1 })
    }

    const stats = p.drain()
    expect(stats[0]).toMatchObject({
      op: 'query',
      collection: 'pipeline-analytics:media',
      calls: 500,
      totalMs: 20_000,
      maxMs: 40,
      rows: 100_000,
    })
    expect(stats[1]?.collection).toBe('addon-settings')
  })

  it('drain resets the window so the next report is not cumulative', () => {
    const { logger } = recorder()
    const p = new SqliteOpProfiler({ logger })

    p.record({ op: 'count', collection: 'alerts', durationMs: 5, rows: 1 })
    expect(p.drain()).toHaveLength(1)
    expect(p.drain()).toHaveLength(0)
  })

  it('reports the busiest operations and the share of the window they consumed', () => {
    const { lines, logger } = recorder()
    let clock = 0
    const p = new SqliteOpProfiler({ logger, now: () => clock })

    clock = 0
    p.record({ op: 'query', collection: 'pipeline-analytics:media', durationMs: 30_000, rows: 5 })
    clock = 60_000
    p.report()

    const info = lines.find((l) => l.level === 'info')
    expect(info?.meta).toMatchObject({ busyMs: 30_000, windowMs: 60_000, busyPct: 50 })
    const top = info?.meta['top']
    expect(Array.isArray(top)).toBe(true)
    expect((top as readonly unknown[])[0]).toMatchObject({
      op: 'query',
      collection: 'pipeline-analytics:media',
      calls: 1,
      totalMs: 30_000,
    })
  })

  it('says nothing when the engine was essentially idle', () => {
    const { lines, logger } = recorder()
    let clock = 0
    const p = new SqliteOpProfiler({ logger, now: () => clock })

    p.record({
      op: 'get',
      collection: 'addon-settings',
      durationMs: SQLITE_PROFILE_REPORT_FLOOR_MS - 1,
      rows: 1,
    })
    clock = 60_000
    p.report()

    expect(lines).toHaveLength(0)
  })

  it('measure() times the synchronous call and returns its value untouched', () => {
    const { logger } = recorder()
    let clock = 0
    const p = new SqliteOpProfiler({ logger, now: () => clock })

    const out = p.measure({ op: 'query', collection: 'alerts' }, () => {
      clock += 250
      return ['a', 'b', 'c']
    })

    expect(out).toEqual(['a', 'b', 'c'])
    expect(p.drain()[0]).toMatchObject({ totalMs: 250, calls: 1, rows: 3 })
  })

  it('measure() records the elapsed time even when the statement throws', () => {
    const { logger } = recorder()
    let clock = 0
    const p = new SqliteOpProfiler({ logger, now: () => clock })

    expect(() =>
      p.measure({ op: 'query', collection: 'alerts' }, () => {
        clock += 700
        throw new Error('database is locked')
      }),
    ).toThrow('database is locked')

    expect(p.drain()[0]).toMatchObject({
      op: 'query',
      collection: 'alerts',
      totalMs: 700,
      calls: 1,
    })
  })

  it('start() reports on a timer and stop() releases it', () => {
    vi.useFakeTimers()
    try {
      const { lines, logger } = recorder()
      const p = new SqliteOpProfiler({ logger, reportIntervalMs: 1_000 })
      p.start()
      p.record({ op: 'query', collection: 'alerts', durationMs: 5_000, rows: 1 })
      vi.advanceTimersByTime(1_000)
      expect(lines.filter((l) => l.level === 'info')).toHaveLength(1)
      p.stop()
      p.record({ op: 'query', collection: 'alerts', durationMs: 5_000, rows: 1 })
      vi.advanceTimersByTime(5_000)
      expect(lines.filter((l) => l.level === 'info')).toHaveLength(1)
    } finally {
      vi.useRealTimers()
    }
  })

  // ── Statement shape and query plan (2026-08-25) ────────────────────────
  //
  // `(op, collection)` names a table, not a call site. The stall of that day
  // reported `query pipeline-analytics:tracks — max 1615 ms` while eleven
  // distinct reads in one addon are spelled exactly that way.

  it('splits one collection into one aggregate row per STATEMENT SHAPE', () => {
    const { lines, logger } = recorder()
    const p = new SqliteOpProfiler({ logger, reportFloorMs: 0, topN: 10 })
    const scan =
      'SELECT "id" FROM "pipeline-analytics:tracks" WHERE "lastSeen" BETWEEN ? AND ? ORDER BY "lastSeen" ASC LIMIT ?'
    const indexed =
      'SELECT "id" FROM "pipeline-analytics:tracks" WHERE "deviceId" = ? ORDER BY "lastSeen" DESC LIMIT ?'

    p.record({ op: 'query', collection: TRACKS, durationMs: 900, rows: 501, sql: scan })
    p.record({ op: 'query', collection: TRACKS, durationMs: 3, rows: 20, sql: indexed })

    const stats = p.drain()
    expect(stats).toHaveLength(2)
    // Busiest first: the scan is the one that must be named.
    expect(stats[0]?.shape).toContain('WHERE "lastSeen" BETWEEN ? AND ?')
    expect(stats[1]?.shape).toContain('WHERE "deviceId" = ?')
    expect(lines).toHaveLength(0)
  })

  it('carries the owner through drain — the reason the key has that part at all', () => {
    const { logger } = recorder()
    const p = new SqliteOpProfiler({ logger })
    p.record({
      op: 'query',
      collection: 'addon-settings',
      durationMs: 5,
      rows: 1,
      owner: 'recorder',
    })
    expect(p.drain()[0]?.owner).toBe('recorder')
  })

  it('attaches the query plan to a slow call', () => {
    const { lines, logger } = recorder()
    const p = new SqliteOpProfiler({
      logger,
      explain: () => ['SCAN pipeline-analytics:tracks', 'USE TEMP B-TREE FOR ORDER BY'],
    })

    p.record({
      op: 'query',
      collection: TRACKS,
      durationMs: 1_101,
      rows: 501,
      sql: 'SELECT "id" FROM "pipeline-analytics:tracks" WHERE "lastSeen" BETWEEN ? AND ? LIMIT ?',
      params: [0, 9_007_199_254_740_991, 501],
    })

    const warn = lines.find((l) => l.level === 'warn')
    expect(warn?.meta['plan']).toEqual([
      'SCAN pipeline-analytics:tracks',
      'USE TEMP B-TREE FOR ORDER BY',
    ])
    expect(warn?.meta['shape']).toContain('WHERE "lastSeen" BETWEEN ? AND ?')
  })

  it('explains a shape ONCE per window — a plan printed forty times is a log nobody reads', () => {
    const { lines, logger } = recorder()
    let explains = 0
    const p = new SqliteOpProfiler({
      logger,
      explain: () => {
        explains += 1
        return ['SCAN pipeline-analytics:tracks']
      },
    })
    const sql = 'SELECT "id" FROM "pipeline-analytics:tracks" WHERE "lastSeen" BETWEEN ? AND ?'
    for (let i = 0; i < 5; i++) {
      p.record({ op: 'query', collection: TRACKS, durationMs: 1_200, rows: 501, sql, params: [] })
    }

    expect(lines.filter((l) => l.level === 'warn')).toHaveLength(5)
    expect(explains).toBe(1)
    // A new window asks again: the plan can change when the stats do.
    p.drain()
    p.record({ op: 'query', collection: TRACKS, durationMs: 1_200, rows: 501, sql, params: [] })
    expect(explains).toBe(2)
  })

  it('passes the BOUND VALUES to the explainer — an unbound plan is not the plan that ran', () => {
    const { logger } = recorder()
    const seen: unknown[][] = []
    const p = new SqliteOpProfiler({
      logger,
      explain: (_sql, params) => {
        seen.push([...params])
        return ['SEARCH x']
      },
    })
    p.record({
      op: 'query',
      collection: TRACKS,
      durationMs: 1_200,
      rows: 1,
      sql: 'SELECT "id" FROM "pipeline-analytics:tracks" WHERE "id" IN (?, ?)',
      params: ['a', 'b'],
    })
    expect(seen).toEqual([['a', 'b']])
  })

  it('still WARNs when no explainer was injected', () => {
    const { lines, logger } = recorder()
    const p = new SqliteOpProfiler({ logger })
    p.record({
      op: 'query',
      collection: TRACKS,
      durationMs: 1_200,
      rows: 501,
      sql: 'SELECT "id" FROM "pipeline-analytics:tracks" WHERE "lastSeen" > ?',
    })
    const warn = lines.find((l) => l.level === 'warn')
    expect(warn).toBeDefined()
    expect(warn?.meta['plan']).toBeUndefined()
  })

  // ── Engine storm (2026-08-31 OFFSET census) ────────────────────────────
  //
  // Cap-usage rate cannot name this: a healthy recorder already talks to
  // `settings-store` at ~2k/min, and 500 piled-up censuses looked like
  // ~1.9k/min. The tell is one SHAPE holding the event loop. Individual
  // pages were ~40 ms — under the slow-call WARN — so the aggregate report
  // was the only line, and it was INFO. Loki does not alert on info.

  it('names a storm when one shape holds half the window, even though no call was slow', () => {
    const { lines, logger } = recorder()
    let clock = 0
    const p = new SqliteOpProfiler({ logger, now: () => clock })
    const sql =
      'SELECT "id" FROM "pipeline-analytics:media" WHERE "timestamp" BETWEEN ? AND ? ORDER BY "timestamp" ASC LIMIT ? OFFSET ?'

    for (let i = 0; i < 1_000; i++) {
      p.record({
        op: 'query',
        collection: 'pipeline-analytics:media',
        durationMs: 40,
        rows: 200,
        sql,
      })
    }
    clock = 60_000
    p.report()

    expect(lines.filter((l) => l.message === 'sqlite statement held the event loop')).toHaveLength(
      0,
    )
    const storm = lines.find((l) => l.message === 'sqlite engine storm')
    expect(storm?.level).toBe('warn')
    expect(storm?.meta).toMatchObject({
      busyPct: 67,
      wallPct: 67,
      op: 'query',
      collection: 'pipeline-analytics:media',
      calls: 1_000,
    })
    expect(String(storm?.meta['shape'] ?? '')).toContain('OFFSET ?')
  })

  it('does not cry storm for a bounded census (20 s of a 60 s window)', () => {
    const { lines, logger } = recorder()
    let clock = 0
    const p = new SqliteOpProfiler({ logger, now: () => clock })
    for (let i = 0; i < 500; i++) {
      p.record({
        op: 'query',
        collection: 'pipeline-analytics:media',
        durationMs: 40,
        rows: 200,
      })
    }
    clock = 60_000
    p.report()

    expect(lines.filter((l) => l.message === 'sqlite engine storm')).toHaveLength(0)
    expect(lines.find((l) => l.message === 'sqlite engine busy')?.level).toBe('info')
  })

  it('sqliteEngineStorm is the share of WINDOW wall, not of busy time', () => {
    const top = {
      op: 'query',
      collection: 'pipeline-analytics:media',
      calls: 1_071,
      totalMs: 53_220,
      maxMs: 80,
      rows: 214_200,
      shape: 'SELECT … OFFSET ?',
    }
    expect(sqliteEngineStorm([top], 60_000)).toEqual(top)
    expect(sqliteEngineStorm([top], 60_000)?.totalMs).toBeGreaterThanOrEqual(
      SQLITE_ENGINE_STORM_WALL_SHARE * 60_000,
    )
    expect(sqliteEngineStorm([{ ...top, totalMs: 20_000 }], 60_000)).toBeNull()
    expect(sqliteEngineStorm([], 60_000)).toBeNull()
  })
})
