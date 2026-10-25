import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CapUsageRegistry } from '../moleculer/cap-usage-registry'

describe('CapUsageRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('records calls and exposes them in the graph', () => {
    const reg = new CapUsageRegistry({ retentionSeconds: 300 })
    const t0 = 1_700_000_000_000
    vi.setSystemTime(t0)

    reg.recordCall({
      callerAddonId: 'A',
      providerAddonId: 'B',
      capName: 'foo',
      methodName: 'doThing',
      atMs: t0,
    })
    reg.recordCall({
      callerAddonId: 'A',
      providerAddonId: 'B',
      capName: 'foo',
      methodName: 'doThing',
      atMs: t0 + 1_000,
    })
    reg.recordCall({
      callerAddonId: 'A',
      providerAddonId: 'B',
      capName: 'foo',
      methodName: 'doOther',
      atMs: t0 + 2_000,
    })

    const graph = reg.getGraph({ windowSeconds: 60, nowMs: t0 + 2_500 })
    expect(graph).toHaveLength(1)
    expect(graph[0]!.callerAddonId).toBe('A')
    expect(graph[0]!.providerAddonId).toBe('B')
    expect(graph[0]!.capName).toBe('foo')
    // 3 calls in last 60s → 3 calls/min.
    expect(graph[0]!.callsPerMin).toBeCloseTo(3, 5)
    expect(graph[0]!.lastCallAtMs).toBe(t0 + 2_000)
  })

  it('drops entries older than the requested window', () => {
    const reg = new CapUsageRegistry({ retentionSeconds: 300 })
    const t0 = 1_700_000_000_000
    reg.recordCall({
      callerAddonId: 'A',
      providerAddonId: 'B',
      capName: 'foo',
      methodName: 'x',
      atMs: t0,
    })
    // Query at t0 + 120s with a 60s window — the call is older than the window.
    const graph = reg.getGraph({ windowSeconds: 60, nowMs: t0 + 120_000 })
    expect(graph).toHaveLength(0)
  })

  it('aggregates across method names within (caller, provider, cap)', () => {
    const reg = new CapUsageRegistry({ retentionSeconds: 300 })
    const t0 = 1_700_000_000_000
    reg.recordCall({
      callerAddonId: 'A',
      providerAddonId: 'B',
      capName: 'foo',
      methodName: 'm1',
      atMs: t0,
    })
    reg.recordCall({
      callerAddonId: 'A',
      providerAddonId: 'B',
      capName: 'foo',
      methodName: 'm2',
      atMs: t0 + 1000,
    })
    const graph = reg.getGraph({ windowSeconds: 60, nowMs: t0 + 1500 })
    expect(graph).toHaveLength(1)
    expect(graph[0]!.callsPerMin).toBeCloseTo(2, 5)
  })

  it('catches errors from misuse and never throws into the caller', () => {
    const reg = new CapUsageRegistry({ retentionSeconds: 60 })
    // Negative timestamps and empty strings must not blow up.
    expect(() =>
      reg.recordCall({
        callerAddonId: '',
        providerAddonId: '',
        capName: '',
        methodName: '',
        atMs: -1,
      }),
    ).not.toThrow()
  })
})

/**
 * The ring must AGE, or `windowSeconds` is a lie.
 *
 * `recordCall` indexes buckets modulo the ring length and NOTHING ever zeroes
 * them. A bucket written at second S is still readable at S + 300k for every k,
 * because `(nowSec - i) % 300` lands on it again. The `lastCallAtMs` guard hides
 * this only while a triple is fully idle — one fresh call re-arms the whole
 * stale ring and the counter reports traffic that stopped ten minutes ago.
 *
 * That is worse than the silence this instrument was built to end: an
 * over-counted edge sends the next investigation at the wrong addon.
 */
describe('CapUsageRegistry ring ageing', () => {
  const t0 = 1_700_000_000_000
  const rec = (atMs: number) => ({
    callerAddonId: 'A',
    providerAddonId: 'B',
    capName: 'foo',
    methodName: 'm',
    atMs,
  })

  it('does not resurrect a bucket the ring has lapped past', () => {
    const reg = new CapUsageRegistry({ retentionSeconds: 300 })
    // 1000 calls in one second, five minutes ago.
    for (let i = 0; i < 1000; i++) reg.recordCall(rec(t0))
    // One call exactly one full ring pass later — it lands on the SAME bucket
    // index, which was never cleared. Also clears the `lastCallAtMs` guard.
    const now = t0 + 300_000
    reg.recordCall(rec(now))

    const graph = reg.getGraph({ windowSeconds: 60, nowMs: now + 500 })
    expect(graph).toHaveLength(1)
    // One call in the last 60 s → 1/min. Not 1001.
    expect(graph[0]!.callsPerMin).toBeCloseTo(1, 5)
  })

  it('counts only the seconds inside the requested window', () => {
    const reg = new CapUsageRegistry({ retentionSeconds: 300 })
    // One call per second for 120 s.
    for (let s = 0; s < 120; s++) reg.recordCall(rec(t0 + s * 1000))
    const now = t0 + 119_500
    // A 60 s window covers seconds t0+60 … t0+119 → 60 calls → 60/min.
    expect(reg.getGraph({ windowSeconds: 60, nowMs: now })[0]!.callsPerMin).toBeCloseTo(60, 5)
    // A 120 s window covers all 120 → 120 calls over 120 s → still 60/min.
    expect(reg.getGraph({ windowSeconds: 120, nowMs: now })[0]!.callsPerMin).toBeCloseTo(60, 5)
  })

  it('does not read the buckets between the last write and now', () => {
    // The clear-forward in `recordCall` stops at the second it writes, so the
    // buckets for the seconds SINCE the last call still hold the previous ring
    // pass. Reading from `nowSec` downwards counts them.
    //
    // Shape: a burst early in a pass, a long quiet gap that does NOT reach far
    // enough to clear the burst's bucket, then a query taken a few seconds
    // after the last call — the query window lands on the burst's index again.
    const reg = new CapUsageRegistry({ retentionSeconds: 300 })
    const base = 1_700_000_000_000 // second S; S % 300 === 200
    for (let i = 0; i < 7; i++) reg.recordCall(rec(base + 5_000)) // second S+5
    reg.recordCall(rec(base + 299_000)) // second S+299 — clears S+6 … S+299 only

    // Now at second S+305. Bucket index for S+305 is the same as for S+5.
    const graph = reg.getGraph({ windowSeconds: 60, nowMs: base + 305_400 })
    expect(graph).toHaveLength(1)
    // One call inside the last 60 s (the one at S+299). Not eight.
    expect(graph[0]!.callsPerMin).toBeCloseTo(1, 5)
  })

  it('a full-retention window does not sum the previous ring pass', () => {
    const reg = new CapUsageRegistry({ retentionSeconds: 300 })
    for (let i = 0; i < 50; i++) reg.recordCall(rec(t0))
    // 400 s later — more than one full ring pass.
    const now = t0 + 400_000
    reg.recordCall(rec(now))
    const graph = reg.getGraph({ windowSeconds: 300, nowMs: now + 500 })
    expect(graph).toHaveLength(1)
    // 1 call in 300 s → 0.2/min. The 50 lapped ones must not reappear.
    expect(graph[0]!.callsPerMin).toBeCloseTo(0.2, 5)
  })
})

/**
 * Cardinality is bounded, because this map lives on hub-main.
 *
 * The class docblock claimed ~200 KB "at ~10 active triples". The live hub runs
 * 64 addons over 1019 devices; the triple space is caller × provider × cap and
 * nothing capped it. An observation registry that grows without limit on the
 * process whose event loop is the cluster's only queue (D181) is a memory leak
 * with a diagnostic label on it.
 */
describe('CapUsageRegistry cardinality bound', () => {
  const t0 = 1_700_000_000_000

  it('reclaims triples whose whole ring has aged out instead of growing', () => {
    const reg = new CapUsageRegistry({ retentionSeconds: 60, maxTriples: 100 })
    for (let i = 0; i < 100; i++) {
      reg.recordCall({
        callerAddonId: `caller-${i}`,
        providerAddonId: 'B',
        capName: 'foo',
        methodName: 'm',
        atMs: t0,
      })
    }
    expect(reg.getStats().triples).toBe(100)

    // Long after every one of those rings has expired, a new triple must be
    // admitted — the dead ones are reclaimed, not counted forever.
    const later = t0 + 120_000
    reg.recordCall({
      callerAddonId: 'fresh',
      providerAddonId: 'B',
      capName: 'foo',
      methodName: 'm',
      atMs: later,
    })
    const graph = reg.getGraph({ windowSeconds: 60, nowMs: later + 500 })
    expect(graph).toHaveLength(1)
    expect(graph[0]!.callerAddonId).toBe('fresh')
    expect(reg.getStats().triples).toBe(1)
    expect(reg.getStats().droppedTriples).toBe(0)
  })

  it('refuses a new triple over the cap rather than growing, and SAYS it did', () => {
    const reg = new CapUsageRegistry({ retentionSeconds: 60, maxTriples: 10 })
    for (let i = 0; i < 25; i++) {
      reg.recordCall({
        callerAddonId: `caller-${i}`,
        providerAddonId: 'B',
        capName: 'foo',
        methodName: 'm',
        atMs: t0,
      })
    }
    const stats = reg.getStats()
    expect(stats.triples).toBe(10)
    expect(stats.droppedTriples).toBe(15)
    // An existing triple keeps counting — the cap costs new EDGES, never
    // accuracy on the ones already being watched.
    reg.recordCall({
      callerAddonId: 'caller-0',
      providerAddonId: 'B',
      capName: 'foo',
      methodName: 'm',
      atMs: t0 + 1000,
    })
    const edge = reg
      .getGraph({ windowSeconds: 60, nowMs: t0 + 1500 })
      .find((e) => e.callerAddonId === 'caller-0')
    expect(edge!.callsPerMin).toBeCloseTo(2, 5)
  })
})
