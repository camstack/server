import { describe, expect, it } from 'vitest'
import { ClosedRowMediaGate } from '../closed-row-media-gate.js'

describe('ClosedRowMediaGate', () => {
  it('writes when there is NO closed record — an absent answer is never a close', () => {
    const gate = new ClosedRowMediaGate()
    const verdict = gate.evaluate('t1', undefined, 1_000)
    expect(verdict.refuse).toBe(false)
    expect(verdict.log).toBe(false)
  })

  it('refuses a row the store closed, and says how long ago it closed', () => {
    const gate = new ClosedRowMediaGate()
    const verdict = gate.evaluate('t1', 1_000, 265_000)
    expect(verdict.refuse).toBe(true)
    expect(verdict.log).toBe(true)
    expect(verdict.closedAgeMs).toBe(264_000)
    expect(verdict.suppressed).toBe(0)
  })

  it('logs a track ONCE per window and counts what it suppressed — a 10 fps refusal is not 10 lines', () => {
    const gate = new ClosedRowMediaGate({ logMinGapMs: 60_000 })
    expect(gate.evaluate('t1', 1_000, 10_000).log).toBe(true)
    for (let i = 1; i <= 5; i += 1) {
      const verdict = gate.evaluate('t1', 1_000, 10_000 + i * 100)
      expect(verdict.refuse).toBe(true)
      expect(verdict.log).toBe(false)
    }
    const next = gate.evaluate('t1', 1_000, 80_000)
    expect(next.log).toBe(true)
    expect(next.suppressed).toBe(5)
  })

  it('samples per TRACK — one noisy id never mutes another', () => {
    const gate = new ClosedRowMediaGate({ logMinGapMs: 60_000 })
    expect(gate.evaluate('t1', 1_000, 10_000).log).toBe(true)
    expect(gate.evaluate('t1', 1_000, 10_100).log).toBe(false)
    expect(gate.evaluate('t2', 1_000, 10_100).log).toBe(true)
  })

  it('bounds its sampling memory — the eviction only ever costs an extra LINE, never a write', () => {
    const gate = new ClosedRowMediaGate({ logMinGapMs: 60_000, maxTracked: 2 })
    gate.evaluate('a', 1_000, 10_000)
    gate.evaluate('b', 1_000, 10_000)
    gate.evaluate('c', 1_000, 10_000)
    // `a` was evicted, so it logs again immediately — and it still REFUSES.
    const verdict = gate.evaluate('a', 1_000, 10_100)
    expect(verdict.refuse).toBe(true)
    expect(verdict.log).toBe(true)
  })
})
