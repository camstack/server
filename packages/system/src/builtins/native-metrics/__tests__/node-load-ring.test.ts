/**
 * The retained per-node load ring.
 *
 * Four claims are load-bearing, and each one exists because the alternative is
 * a memory defect this repo has already paid for:
 *
 *  1. The per-node ring drops the OLDEST at the 181st — the operator's hour is
 *     a sliding window, not a growing array.
 *  2. The FLEET budget bites. A per-instance maximum with no budget for the
 *     fleet is exactly the RTP pre-roll rings (898 MB over 47 rings,
 *     `docs/architecture/load-ledger.md` #5), and 180 samples of a node whose
 *     process count exploded is unbounded memory under a bounded sample count.
 *  3. A node that stops emitting is evicted. Otherwise a decommissioned agent
 *     holds its partition for the life of the process.
 *  4. A read with `sinceMs` returns only what the caller lacks — the contract
 *     the admin UI relies on to seed a chart it is already drawing.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_SAMPLES_PER_NODE, NodeLoadRing, type LoadSample } from '../node-load-ring.js'

/** Stand-in for a process row. The ring must never look inside one. */
interface FakeProcess {
  readonly pid: number
}

/**
 * A clock earlier than every timestamp the tests use, so the idle-eviction
 * sweep is a no-op everywhere except the block that is testing it. Eviction
 * compares `now() - idleEvictionMs` against a partition's newest sample; a
 * clock far AHEAD of the samples would evict them all and quietly turn every
 * other assertion into a test of the sweep.
 */
const FAKE_NOW = 0

function processes(count: number, base = 0): readonly FakeProcess[] {
  return Array.from({ length: count }, (_unused, i) => ({ pid: base + i }))
}

function atMsOf(samples: readonly LoadSample<FakeProcess>[]): readonly number[] {
  return samples.map((s) => s.atMs)
}

describe('per-node capacity', () => {
  it('drops the OLDEST sample at the 181st, keeping a sliding hour', () => {
    const ring = new NodeLoadRing<FakeProcess>({ now: () => FAKE_NOW })
    for (let i = 0; i < DEFAULT_SAMPLES_PER_NODE + 1; i++) {
      ring.record('hub', 1_000 + i, processes(2))
    }

    const series = ring.read('hub')
    expect(series.retainedSamples).toBe(DEFAULT_SAMPLES_PER_NODE)
    expect(series.samples).toHaveLength(DEFAULT_SAMPLES_PER_NODE)
    // The very first sample is gone; the 181st is present.
    expect(series.oldestAtMs).toBe(1_001)
    expect(atMsOf(series.samples).at(0)).toBe(1_001)
    expect(atMsOf(series.samples).at(-1)).toBe(1_000 + DEFAULT_SAMPLES_PER_NODE)
  })

  it('refuses a replayed timestamp instead of doubling the point', () => {
    const ring = new NodeLoadRing<FakeProcess>({ now: () => FAKE_NOW })
    ring.record('hub', 5_000, processes(3))
    ring.record('hub', 5_000, processes(3))
    ring.record('hub', 4_000, processes(3))

    expect(ring.read('hub').retainedSamples).toBe(1)
    expect(ring.rowCount()).toBe(3)
  })

  it('keeps the payload verbatim and never reads a field of it', () => {
    const ring = new NodeLoadRing<Record<string, unknown>>({ now: () => FAKE_NOW })
    const payload = [{ pid: 1, deviceId: 102, somethingNobodyDeclaredYet: 'x' }]
    ring.record('hub', 1_000, payload)

    expect(ring.read('hub').samples[0]?.processes[0]).toEqual({
      pid: 1,
      deviceId: 102,
      somethingNobodyDeclaredYet: 'x',
    })
  })
})

describe('fleet budget', () => {
  it('bites on a node that multiplies its processes, and the culprit pays', () => {
    // 100 rows total. A quiet node holds 2 rows/sample; the runaway holds 40.
    const ring = new NodeLoadRing<FakeProcess>({
      maxTotalProcessRows: 100,
      now: () => FAKE_NOW,
    })
    for (let i = 0; i < 5; i++) ring.record('quiet', 1_000 + i, processes(2))
    for (let i = 0; i < 20; i++) ring.record('runaway', 1_000 + i, processes(40))

    expect(ring.rowCount()).toBeLessThanOrEqual(100)
    // The quiet node kept its whole window — it did not create the pressure.
    expect(ring.read('quiet').retainedSamples).toBe(5)
    // The runaway is trimmed to what the budget affords, oldest first.
    const runaway = ring.read('runaway')
    expect(runaway.retainedSamples).toBeLessThan(20)
    expect(runaway.oldestAtMs).toBeGreaterThan(1_000)
    // And it is bounded, not merely smaller.
    expect(runaway.retainedSamples * 40).toBeLessThanOrEqual(100)
  })

  it('bounds the total even when the per-node sample cap is never reached', () => {
    const ring = new NodeLoadRing<FakeProcess>({
      samplesPerNode: 180,
      maxTotalProcessRows: 500,
      now: () => FAKE_NOW,
    })
    // 30 samples x 1000 rows = 30 000 rows would be retained under the sample
    // cap alone. The fleet budget is the only thing that stops it.
    for (let i = 0; i < 30; i++) ring.record('hub', 1_000 + i, processes(1_000))
    expect(ring.rowCount()).toBeLessThanOrEqual(500)
  })

  it('caps the number of partitions, evicting least-recently-written first', () => {
    const ring = new NodeLoadRing<FakeProcess>({ maxNodes: 2, now: () => FAKE_NOW })
    ring.record('a', 1_000, processes(1))
    ring.record('b', 1_001, processes(1))
    ring.record('c', 1_002, processes(1))

    expect(ring.nodeIds()).toEqual(['b', 'c'])
    expect(ring.read('a').retainedSamples).toBe(0)
  })
})

describe('idle eviction', () => {
  it('drops a node that stopped emitting for the whole retention window', () => {
    let now = 1_000_000
    const ring = new NodeLoadRing<FakeProcess>({ idleEvictionMs: 3_600_000, now: () => now })
    ring.record('gone', now, processes(5))
    ring.record('alive', now, processes(5))
    expect(ring.rowCount()).toBe(10)

    // `alive` keeps emitting; `gone` never speaks again. An hour and a
    // millisecond after its last word, its partition is not the operator's
    // hour any more — every point in it has aged out of the question.
    now += 1_800_000
    ring.record('alive', now, processes(5))
    now += 1_800_001
    ring.record('alive', now, processes(5))

    expect(ring.nodeIds()).toEqual(['alive'])
    expect(ring.read('gone').retainedSamples).toBe(0)
    // The row accounting follows the eviction — a total that only ever grows
    // would make the fleet budget fire on a near-empty ring.
    expect(ring.rowCount()).toBe(15)
  })

  it('keeps a merely quiet node inside the window', () => {
    let now = 1_000_000
    const ring = new NodeLoadRing<FakeProcess>({ idleEvictionMs: 3_600_000, now: () => now })
    ring.record('quiet', now, processes(5))

    now += 3_599_000
    expect(ring.read('quiet').retainedSamples).toBe(1)
  })
})

describe('read(sinceMs)', () => {
  it('returns only what the caller does not already have', () => {
    const ring = new NodeLoadRing<FakeProcess>({ now: () => FAKE_NOW })
    for (const at of [1_000, 2_000, 3_000, 4_000]) ring.record('hub', at, processes(1))

    // The caller holds up to 2_000. `sinceMs` is EXCLUSIVE, so 2_000 itself
    // must NOT come back — that is the point that would be drawn twice.
    expect(atMsOf(ring.read('hub', 2_000).samples)).toEqual([3_000, 4_000])
    expect(atMsOf(ring.read('hub', 4_000).samples)).toEqual([])
    expect(atMsOf(ring.read('hub').samples)).toEqual([1_000, 2_000, 3_000, 4_000])
  })

  it('reports the retained depth regardless of the filter', () => {
    const ring = new NodeLoadRing<FakeProcess>({ now: () => FAKE_NOW })
    for (const at of [1_000, 2_000, 3_000]) ring.record('hub', at, processes(1))

    const series = ring.read('hub', 2_500)
    expect(series.samples).toHaveLength(1)
    expect(series.retainedSamples).toBe(3)
    expect(series.oldestAtMs).toBe(1_000)
    expect(series.capacity).toBe(DEFAULT_SAMPLES_PER_NODE)
  })

  it('answers empty — not an error — for a node nobody has recorded', () => {
    const ring = new NodeLoadRing<FakeProcess>({ now: () => FAKE_NOW })
    const series = ring.read('never-heard-of-it')
    expect(series.samples).toEqual([])
    expect(series.retainedSamples).toBe(0)
    expect(series.oldestAtMs).toBeNull()
  })
})
