/**
 * Unit tests for the WeightSliderStack pure helpers — the share-normalisation
 * and lock-aware redistribution that keep the sliders summing to 100% while a
 * LOCKED share stays fixed and is never re-scaled.
 *
 * Model (conserved-to-100): dragging slider `i` to `v` moves ONLY `i` + the
 * unlocked, non-dragged sliders. The locked sliders hold a fixed slice of the
 * 100% budget; the dragged slider + the unlocked others share whatever budget
 * the locks leave (`100 - lockedSum`). A locked share is NEVER touched and the
 * total is ALWAYS conserved at 100 — so a later `sharesFromNodes` normalise
 * cannot shrink a locked node (the operator "lock doesn't hold" bug).
 */
import { describe, expect, it } from 'vitest'
import {
  redistribute,
  roundShares,
  sharesFromNodes,
  type WeightSliderNode,
} from '../placement-board/WeightSliderStack'

function node(id: string, weight: number): WeightSliderNode {
  return { id, name: id, weight }
}

const sum = (shares: Readonly<Record<string, number>>): number =>
  Object.values(shares).reduce((a, b) => a + b, 0)

describe('sharesFromNodes', () => {
  it('normalises absolute weights to shares summing to 100', () => {
    const shares = sharesFromNodes([node('a', 60), node('b', 30), node('c', 10)])
    expect(shares).toEqual({ a: 60, b: 30, c: 10 })
    expect(sum(shares)).toBeCloseTo(100)
  })

  it('splits equally when every weight is zero', () => {
    const shares = sharesFromNodes([node('a', 0), node('b', 0)])
    expect(shares.a).toBeCloseTo(50)
    expect(shares.b).toBeCloseTo(50)
  })

  it('handles a single node as 100%', () => {
    expect(sharesFromNodes([node('a', 7)])).toEqual({ a: 100 })
  })
})

describe('redistribute', () => {
  const ids = ['a', 'b', 'c']

  // ── Operator acceptance criteria (two concrete examples) ──────────────────

  it('OPERATOR EXAMPLE 1: A→60, B and C both unlocked → B=20, C=20', () => {
    // The two unlocked others equally split 100 - 60 = 40.
    const next = redistribute({ a: 33.3, b: 33.3, c: 33.3 }, 'a', 60, new Set(), ids)
    expect(next.a).toBe(60)
    expect(next.b).toBeCloseTo(20)
    expect(next.c).toBeCloseTo(20)
    expect(sum(next)).toBeCloseTo(100)
  })

  it('OPERATOR EXAMPLE 2: A→60, B LOCKED at 10, C unlocked → C=30, B stays 10, total conserved at 100', () => {
    // The locked node holds a fixed 10 of the 100 budget. The dragged slider
    // (60) + the sole unlocked other (C) share the remaining 100 - 10 = 90, so
    // C = 90 - 60 = 30. B stays byte-for-byte 10 and the total stays 100 — a
    // later normalise can never shrink the locked B.
    const next = redistribute({ a: 33.3, b: 10, c: 56.7 }, 'a', 60, new Set(['b']), ids)
    expect(next.a).toBe(60)
    expect(next.b).toBe(10) // locked, byte-for-byte untouched
    expect(next.c).toBeCloseTo(30) // = (100 - lockedSum) - 60 = 90 - 60
    expect(sum(next)).toBeCloseTo(100)
  })

  // ── Lock integrity (the recurring operator bug) ───────────────────────────

  it('leaves a locked node byte-for-byte unchanged when another slider is dragged', () => {
    const prev = { a: 41.7, b: 33.3, c: 25 }
    const next = redistribute(prev, 'b', 80, new Set(['a']), ids)
    // A is locked: exact same float instance value, not even off by rounding.
    expect(next.a).toBe(prev.a)
    expect(sum(next)).toBeCloseTo(100)
  })

  it('bounds the drag to the non-locked headroom — the moved slider cannot exceed 100 - lockedSum', () => {
    // A dragged to 95 with B locked at 10: the dragged slider + unlocked others
    // may only occupy 100 - 10 = 90, so A is clamped DOWN to 90 (bounded by the
    // available non-locked headroom), C absorbs 0, B stays pinned at 10.
    const next = redistribute({ a: 30, b: 10, c: 60 }, 'a', 95, new Set(['b']), ids)
    expect(next.a).toBe(90) // bounded by headroom (100 - lockedSum)
    expect(next.b).toBe(10) // locked
    expect(next.c).toBeCloseTo(0)
    expect(sum(next)).toBeCloseTo(100)
  })

  it('when EVERY other node is locked, the drag is pinned to the headroom (cannot move)', () => {
    // b and c both locked (30 + 20 = 50). The dragged slider a has no unlocked
    // other to absorb a change, so it can only sit at 100 - 50 = 50 — the drag
    // is fully bounded by the non-locked headroom.
    const next = redistribute({ a: 50, b: 30, c: 20 }, 'a', 90, new Set(['b', 'c']), ids)
    expect(next.a).toBe(50) // pinned to headroom, cannot rise to 90
    expect(next.b).toBe(30) // locked
    expect(next.c).toBe(20) // locked
    expect(sum(next)).toBeCloseTo(100)
  })

  // ── Additional coverage ───────────────────────────────────────────────────

  it('raising one node splits the remainder EQUALLY across the other unlocked nodes', () => {
    // Prior shares b:40/c:20 must NOT bias the split — both absorb
    // (100 - 70) / 2 = 15 regardless of their previous share.
    const next = redistribute({ a: 40, b: 40, c: 20 }, 'a', 70, new Set(), ids)
    expect(next.a).toBe(70)
    expect(next.b).toBeCloseTo(15)
    expect(next.c).toBeCloseTo(15)
    expect(sum(next)).toBeCloseTo(100)
  })

  it('the moved value is clamped only to the [0,100] range when there are no locks', () => {
    const high = redistribute({ a: 40, b: 30, c: 30 }, 'a', 150, new Set(), ids)
    expect(high.a).toBe(100)
    expect(high.b).toBeCloseTo(0)
    expect(high.c).toBeCloseTo(0)

    const low = redistribute({ a: 40, b: 30, c: 30 }, 'a', -20, new Set(), ids)
    expect(low.a).toBe(0)
    expect(low.b).toBeCloseTo(50)
    expect(low.c).toBeCloseTo(50)
  })

  it('with two unlocked others, the remainder splits equally between them', () => {
    // b and c both unlocked, currently very unequal (10 vs 70) — after the
    // drag they must land on the SAME value, not proportional to 10/70.
    const next = redistribute({ a: 20, b: 10, c: 70 }, 'a', 50, new Set(), ids)
    expect(next.a).toBe(50)
    expect(next.b).toBeCloseTo(25)
    expect(next.c).toBeCloseTo(25)
    expect(sum(next)).toBeCloseTo(100)
  })

  it('splits equally among others when they were all zero too', () => {
    const next = redistribute({ a: 100, b: 0, c: 0 }, 'a', 40, new Set(), ids)
    expect(next.a).toBe(40)
    expect(next.b).toBeCloseTo(30)
    expect(next.c).toBeCloseTo(30)
  })
})

describe('roundShares', () => {
  const ids = ['a', 'b', 'c']

  it('rounds already-integer shares unchanged and keeps the total at 100', () => {
    const rounded = roundShares({ a: 70, b: 15, c: 15 }, ids, new Set())
    expect(rounded).toEqual({ a: 70, b: 15, c: 15 })
    expect(sum(rounded)).toBe(100)
  })

  it('forces the committed integer weights to sum to EXACTLY 100', () => {
    // Thirds round to 33/33/33 = 99; the leftover unit must be assigned so the
    // total is a clean 100 (largest fractional part wins).
    const rounded = roundShares({ a: 33.4, b: 33.3, c: 33.3 }, ids, new Set())
    expect(sum(rounded)).toBe(100)
    expect(rounded.a).toBe(34) // largest fractional remainder gets the +1
    expect(rounded.b).toBe(33)
    expect(rounded.c).toBe(33)
  })

  it('never dumps the rounding remainder onto a LOCKED slider', () => {
    // a is locked at exactly 34. b/c are 33.33 each. The leftover unit to reach
    // 100 must land on an unlocked slider (b or c), never on the locked a.
    const rounded = roundShares({ a: 34, b: 33.33, c: 33.33 }, ids, new Set(['a']))
    expect(rounded.a).toBe(34) // locked — untouched, never nudged by remainder
    expect(sum(rounded)).toBe(100)
    expect(rounded.b + rounded.c).toBe(66)
  })
})
