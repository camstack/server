import { describe, it, expect } from 'vitest'
import { DEFAULT_MAX_TOTAL_LOG_ENTRIES, PartitionedLogBuffer } from '../partitioned-log-buffer.js'
import type { LogEntry, LogLevel } from '@camstack/types'

function entry(addonId: string | undefined, message: string, extra?: Partial<LogEntry>): LogEntry {
  return {
    timestamp: new Date(),
    level: 'info' as LogLevel,
    message,
    ...(extra?.level !== undefined ? { level: extra.level } : {}),
    ...(addonId !== undefined ? { tags: { addonId, ...extra?.tags } } : { tags: extra?.tags }),
    ...(extra?.meta !== undefined ? { meta: extra.meta } : {}),
  }
}

describe('PartitionedLogBuffer', () => {
  it('a chatty addon evicts only its OWN bucket, not a quiet addon', () => {
    const buf = new PartitionedLogBuffer(3) // tiny per-addon cap
    buf.push(entry('quiet', 'q1'))
    // 'chatty' overflows its 3-cap bucket many times over
    for (let i = 0; i < 20; i++) buf.push(entry('chatty', `c${i}`))

    const quiet = buf.query({ tags: { addonId: 'quiet' } })
    expect(quiet.map((e) => e.message)).toEqual(['q1']) // survived despite chatty churn

    const chatty = buf.query({ tags: { addonId: 'chatty' } })
    expect(chatty).toHaveLength(3) // only its own bucket evicted
    expect(chatty.map((e) => e.message)).toEqual(['c19', 'c18', 'c17'])
  })

  it('normalises @version and ::sub suffixes into the same bucket as the bare id', () => {
    const buf = new PartitionedLogBuffer(10)
    buf.push(entry('ha', 'bare'))
    buf.push(entry('ha@0.1.0', 'worker'))
    buf.push(entry('ha::native-device-ops', 'subservice'))

    const all = buf.query({ tags: { addonId: 'ha' } })
    expect(all.map((e) => e.message).toSorted()).toEqual(['bare', 'subservice', 'worker'])
  })

  it('a deviceId-only filter scans ALL buckets (addon-agnostic), newest-first + limited', () => {
    const buf = new PartitionedLogBuffer(10)
    buf.push(entry('ha', 'child-a', { tags: { addonId: 'ha', deviceId: 877 } }))
    buf.push(entry('pipeline', 'noise', { tags: { addonId: 'pipeline', deviceId: 7 } }))
    buf.push(entry('ha', 'child-b', { tags: { addonId: 'ha', deviceId: 877 } }))

    const dev877 = buf.query({ tags: { deviceId: 877 } })
    expect(dev877.map((e) => e.message)).toEqual(['child-b', 'child-a']) // newest-first, only 877
  })

  it('clear by addonId only wipes that bucket', () => {
    const buf = new PartitionedLogBuffer(10)
    buf.push(entry('ha', 'keep'))
    buf.push(entry('pipeline', 'drop'))
    const removed = buf.clear({ tags: { addonId: 'pipeline' } })
    expect(removed).toBe(1)
    expect(buf.query({ tags: { addonId: 'ha' } }).map((e) => e.message)).toEqual(['keep'])
    expect(buf.query({ tags: { addonId: 'pipeline' } })).toHaveLength(0)
  })
})

/**
 * Aggregate bounds. The per-addon ring is a HARD bound per bucket, but it
 * scales with the number of buckets and buckets used to be created and never
 * removed — so hub-main, which ingests from every local runner AND every agent,
 * had no aggregate bound at all.
 */
describe('PartitionedLogBuffer — the aggregate stops growing', () => {
  /** A realistic hub roster: ~37 runner processes plus the in-process builtins. */
  const ROSTER = 60

  it('a DEFAULT buffer is bounded in aggregate, not just per bucket', () => {
    const buf = new PartitionedLogBuffer() // defaults only — this is the shipped configuration
    for (let a = 0; a < ROSTER; a++) {
      for (let i = 0; i < 5000; i++) buf.push(entry(`addon-${a}`, `m${i}`, { level: 'debug' }))
    }
    // Unbounded would be ROSTER x 5000 = 300_000 entries (~92MB at a measured
    // ~306 B/entry). The assertion is that the total is HELD, whatever the
    // configured number happens to be.
    expect(buf.size()).toBeLessThan(ROSTER * 5000)
    expect(buf.size()).toBeLessThanOrEqual(DEFAULT_MAX_TOTAL_LOG_ENTRIES)
  })

  it('a dead addon’s bucket is not immortal — unprunable levels included', () => {
    // `info` is ABOVE the default prune level, so the debug sweep can never
    // touch these. Before bucket eviction this bucket survived forever.
    const buf = new PartitionedLogBuffer(50, { maxTotalEntries: 500, maxBuckets: 4 })
    for (let i = 0; i < 50; i++) buf.push(entry('dead-addon', `d${i}`))
    expect(buf.query({ tags: { addonId: 'dead-addon' } })).toHaveLength(50)

    // The addon is gone; other addons keep logging.
    for (let a = 0; a < 10; a++) {
      for (let i = 0; i < 50; i++) buf.push(entry(`live-${a}`, `m${i}`))
    }
    expect(buf.query({ tags: { addonId: 'dead-addon' } })).toHaveLength(0)
    expect(buf.bucketCount()).toBeLessThanOrEqual(4)
  })

  it('evicts the LEAST-RECENTLY-WRITTEN bucket, so an active addon is never the victim', () => {
    const buf = new PartitionedLogBuffer(10, { maxBuckets: 3 })
    buf.push(entry('idle', 'i1'))
    buf.push(entry('busy', 'b1'))
    buf.push(entry('other', 'o1'))
    // `busy` writes again — now `idle` is the oldest write, `busy` the newest.
    buf.push(entry('busy', 'b2'))
    // A fourth bucket forces one eviction.
    buf.push(entry('newcomer', 'n1'))

    expect(buf.query({ tags: { addonId: 'idle' } })).toHaveLength(0)
    expect(buf.query({ tags: { addonId: 'busy' } })).toHaveLength(2)
    expect(buf.query({ tags: { addonId: 'newcomer' } })).toHaveLength(1)
    expect(buf.bucketCount()).toBe(3)
  })

  it('an emptied bucket is removed, not left behind as an empty ring forever', () => {
    const buf = new PartitionedLogBuffer(10)
    buf.push(entry('gone', 'g1'))
    expect(buf.bucketCount()).toBe(1)
    buf.clear({ tags: { addonId: 'gone' } })
    expect(buf.bucketCount()).toBe(0)
    expect(buf.size()).toBe(0)
  })

  it('the aggregate bound never costs an error line while a debug line is available', () => {
    const buf = new PartitionedLogBuffer(50, { maxTotalEntries: 60, maxBuckets: 8 })
    buf.push(entry('incident', 'the line that explains it', { level: 'error' }))
    for (let i = 0; i < 200; i++) buf.push(entry('chatty', `noise${i}`, { level: 'debug' }))
    expect(buf.query({ tags: { addonId: 'incident' } }).map((e) => e.message)).toEqual([
      'the line that explains it',
    ])
  })
})
