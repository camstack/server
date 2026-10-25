import { describe, it, expect } from 'vitest'
import type { LogEntry, LogLevel } from '@camstack/types'
import { LogRingBuffer } from '../../logging/log-ring-buffer.js'
import { PartitionedLogBuffer } from '../../logging/partitioned-log-buffer.js'

/**
 * The total-entry cap and the level-aware sweep that enforces it.
 *
 * The invariant these tests exist to protect: a total cap must NEVER cost a `warn`
 * or an `error`. Meeting a memory budget by discarding the lines that explain an
 * incident, to keep lines about frame timings, is the wrong trade — so the cap is
 * soft and the sweep only touches entries at or below `pruneLevel`.
 */

let seq = 0
function entry(level: LogLevel, addonId?: string): LogEntry {
  seq += 1
  return {
    // Distinct, increasing timestamps so "oldest first" is well-defined.
    timestamp: new Date(1_785_060_000_000 + seq),
    level,
    message: `m${String(seq)}`,
    ...(addonId === undefined ? {} : { tags: { addonId } }),
  }
}

function levelsIn(buf: PartitionedLogBuffer): Record<LogLevel, number> {
  const counts: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 }
  for (const e of buf.getAll()) counts[e.level] += 1
  return counts
}

describe('LogRingBuffer.pruneOldestAtOrBelow', () => {
  it('removes only entries at or below the threshold', () => {
    const buf = new LogRingBuffer(10)
    buf.push(entry('debug'))
    buf.push(entry('info'))
    buf.push(entry('warn'))
    buf.push(entry('error'))
    buf.push(entry('debug'))

    const removed = buf.pruneOldestAtOrBelow('debug', 10)

    expect(removed).toBe(2)
    expect(
      buf
        .getAll()
        .map((e) => e.level)
        .toSorted(),
    ).toEqual(['error', 'info', 'warn'])
  })

  it('includes info when the threshold is info, and still spares warn/error', () => {
    const buf = new LogRingBuffer(10)
    buf.push(entry('debug'))
    buf.push(entry('info'))
    buf.push(entry('warn'))
    buf.push(entry('error'))

    expect(buf.pruneOldestAtOrBelow('info', 10)).toBe(2)
    expect(
      buf
        .getAll()
        .map((e) => e.level)
        .toSorted(),
    ).toEqual(['error', 'warn'])
  })

  it('honours the max and takes the OLDEST first', () => {
    const buf = new LogRingBuffer(10)
    const first = entry('debug')
    const second = entry('debug')
    const third = entry('debug')
    buf.push(first)
    buf.push(second)
    buf.push(third)

    expect(buf.pruneOldestAtOrBelow('debug', 1)).toBe(1)
    // Recent context is what an operator is looking at, so the survivors are the
    // newest two.
    expect(buf.getAll().map((e) => e.message)).toEqual([third.message, second.message])
  })

  it('preserves newest-first order and push semantics after a prune', () => {
    const buf = new LogRingBuffer(4)
    buf.push(entry('debug'))
    const keptA = entry('warn')
    const keptB = entry('error')
    buf.push(keptA)
    buf.push(keptB)
    buf.pruneOldestAtOrBelow('debug', 10)

    // A prune re-seeds the ring; a broken head/count would show up as a wrong
    // order here, or as a lost entry on the next push.
    const next = entry('info')
    buf.push(next)
    expect(buf.getAll().map((e) => e.message)).toEqual([next.message, keptB.message, keptA.message])
    expect(buf.size()).toBe(3)
  })

  it('is a no-op when nothing is prunable, or when max is 0', () => {
    const buf = new LogRingBuffer(10)
    buf.push(entry('error'))
    buf.push(entry('warn'))
    expect(buf.pruneOldestAtOrBelow('debug', 10)).toBe(0)
    expect(buf.size()).toBe(2)

    const other = new LogRingBuffer(10)
    other.push(entry('debug'))
    expect(other.pruneOldestAtOrBelow('debug', 0)).toBe(0)
    expect(other.size()).toBe(1)
  })
})

describe('PartitionedLogBuffer — total cap', () => {
  it('is unbounded by default, so behaviour is unchanged unless opted in', () => {
    const buf = new PartitionedLogBuffer(100)
    for (let i = 0; i < 250; i++) buf.push(entry('debug', `addon-${String(i % 5)}`))
    // 5 buckets × 50 each, all under the per-addon ring of 100. No sweep.
    expect(buf.size()).toBe(250)
  })

  it('prunes down below the cap once exceeded', () => {
    const buf = new PartitionedLogBuffer(1000, { maxTotalEntries: 100 })
    for (let i = 0; i < 300; i++) buf.push(entry('debug', 'chatty'))

    // Pruning targets 90% of the cap, leaving headroom so the next push does not
    // immediately sweep again.
    expect(buf.size()).toBeLessThanOrEqual(100)
    expect(buf.size()).toBeGreaterThan(0)
  })

  it('NEVER discards warn or error to meet the cap', () => {
    const buf = new PartitionedLogBuffer(1000, { maxTotalEntries: 50 })
    for (let i = 0; i < 200; i++) buf.push(entry('debug', 'chatty'))
    for (let i = 0; i < 10; i++) buf.push(entry('error', 'chatty'))
    for (let i = 0; i < 10; i++) buf.push(entry('warn', 'chatty'))
    for (let i = 0; i < 200; i++) buf.push(entry('debug', 'chatty'))

    const counts = levelsIn(buf)
    // The whole point. 20 important lines survive 400 debug lines of pressure.
    expect(counts.error).toBe(10)
    expect(counts.warn).toBe(10)
  })

  it('stays ABOVE the cap rather than evicting important entries', () => {
    // 80 unprunable entries against a cap of 20: the cap cannot be met without
    // discarding errors, so it is not met. Documented, deliberate behaviour — the
    // per-addon ring is the hard bound that still holds.
    const buf = new PartitionedLogBuffer(1000, { maxTotalEntries: 20 })
    for (let i = 0; i < 80; i++) buf.push(entry('error', 'noisy'))

    expect(buf.size()).toBe(80)
    expect(levelsIn(buf).error).toBe(80)
  })

  it('respects a raised pruneLevel', () => {
    const buf = new PartitionedLogBuffer(1000, { maxTotalEntries: 40, pruneLevel: 'info' })
    for (let i = 0; i < 100; i++) buf.push(entry('info', 'chatty'))
    for (let i = 0; i < 5; i++) buf.push(entry('warn', 'chatty'))

    const counts = levelsIn(buf)
    expect(counts.warn).toBe(5)
    expect(counts.info).toBeLessThan(100)
  })

  it('takes from the LARGEST bucket, leaving a quiet addon its history', () => {
    const buf = new PartitionedLogBuffer(1000, { maxTotalEntries: 60 })
    // One quiet addon with 5 lines, one chatty addon with 200.
    for (let i = 0; i < 5; i++) buf.push(entry('debug', 'quiet'))
    for (let i = 0; i < 200; i++) buf.push(entry('debug', 'chatty'))

    const quiet = buf.query({ tags: { addonId: 'quiet' } })
    // The noisy addon created the pressure, so it pays for it — the same principle
    // that motivated partitioning in the first place.
    expect(quiet).toHaveLength(5)
  })

  it('keeps `size()` honest across clear()', () => {
    // A running total that only ever grew would drift until the cap fired
    // constantly on a near-empty buffer.
    const buf = new PartitionedLogBuffer(1000, { maxTotalEntries: 1000 })
    for (let i = 0; i < 30; i++) buf.push(entry('debug', 'a'))
    for (let i = 0; i < 30; i++) buf.push(entry('debug', 'b'))
    expect(buf.size()).toBe(60)

    const removed = buf.clear({ tags: { addonId: 'a' } })
    expect(removed).toBe(30)
    expect(buf.size()).toBe(30)

    expect(buf.clear()).toBe(30)
    expect(buf.size()).toBe(0)
  })

  it('keeps `size()` honest when a per-addon ring is already full', () => {
    // A full ring evicts as it accepts, so the delta is 0 — assuming +1 per push
    // would inflate the total and trigger phantom sweeps.
    const buf = new PartitionedLogBuffer(10, { maxTotalEntries: 1000 })
    for (let i = 0; i < 50; i++) buf.push(entry('debug', 'a'))
    expect(buf.size()).toBe(10)
    expect(buf.getAll()).toHaveLength(10)
  })
})
