import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { fragmentsInWindow, fragmentsWithinBudget, type MfraIndex, parseMfra } from '../mfra-index'

/**
 * fragmentsWithinBudget — a byte budget converted into a SET of fragments,
 * read from `tfra` offsets alone (D170 / segments-60s Task 1). This is the
 * primitive Task 3 (60 s segments) depends on: "how many consecutive GOPs fit
 * in N bytes" answered from the index, never the payload.
 *
 * First battery runs against the REAL fixture already pinned by
 * `gop-range-read.spec.ts`: two fragments — frag1 [1370, 87665) = 86 295 B,
 * frag2 [87665, 88547) = 882 B, mfraOffset = 88547. Real bytes, not a mock
 * that could agree with a wrong implementation.
 */

const FIXTURE = path.join(__dirname, '../../stream-broker/recorded/__tests__/fixtures/sample.m4s')

function fixtureIndex(): MfraIndex {
  const bytes = readFileSync(FIXTURE)
  // The mfra tail comfortably fits in the last 2048 bytes (file is 88 676 B).
  const tail = bytes.subarray(bytes.length - 2048)
  return parseMfra(tail, bytes.length)
}

const FRAG1 = { start: 1370, end: 87665 } // 86 295 B
const FRAG2 = { start: 87665, end: 88547 } // 882 B
const MFRA_OFFSET = 88547

describe('fragmentsWithinBudget — real fixture (two fragments)', () => {
  it('a generous budget returns every fragment from the anchor to the segment end', () => {
    const plan = fragmentsWithinBudget(fixtureIndex(), 0, 1_000_000)
    expect(plan.fragments).toHaveLength(2)
    expect(plan.start).toBe(FRAG1.start)
    expect(plan.end).toBe(MFRA_OFFSET)
    expect(plan.reachesSegmentEnd).toBe(true)
    expect(plan.oversizeFragment).toBe(false)
  })

  it('a budget that fits fragment 1 but not both stops after fragment 1', () => {
    // frag1 alone = 86 295 B; frag1+frag2 = 87 177 B.
    const plan = fragmentsWithinBudget(fixtureIndex(), 0, 87_000)
    expect(plan.fragments).toHaveLength(1)
    expect(plan.start).toBe(FRAG1.start)
    expect(plan.end).toBe(FRAG1.end)
    expect(plan.reachesSegmentEnd).toBe(false)
    expect(plan.oversizeFragment).toBe(false)
  })

  it('NEVER an empty set: a budget smaller than fragment 1 alone still returns fragment 1', () => {
    const plan = fragmentsWithinBudget(fixtureIndex(), 0, 500)
    expect(plan.fragments).toHaveLength(1)
    expect(plan.fragments[0]).toEqual({ start: FRAG1.start, end: FRAG1.end, sampleIndex: 0 })
    expect(plan.start).toBe(FRAG1.start)
    expect(plan.end).toBe(FRAG1.end)
    expect(plan.oversizeFragment).toBe(true)
    expect(plan.reachesSegmentEnd).toBe(false)
  })

  it('anchoring at the second fragment starts there, not at the segment start', () => {
    // offsetTicks = 352 260 (the fixture's second tfra entry, 3914 ms @ 90 kHz).
    const plan = fragmentsWithinBudget(fixtureIndex(), 352_260, 1_000_000)
    expect(plan.fragments).toHaveLength(1)
    expect(plan.fragments[0]).toEqual({ start: FRAG2.start, end: FRAG2.end, sampleIndex: 1 })
    expect(plan.reachesSegmentEnd).toBe(true)
    expect(plan.oversizeFragment).toBe(false)
  })

  it('the LAST fragment oversize is still returned whole, never dropped', () => {
    const plan = fragmentsWithinBudget(fixtureIndex(), 352_260, 100)
    expect(plan.fragments).toHaveLength(1)
    expect(plan.fragments[0]).toEqual({ start: FRAG2.start, end: FRAG2.end, sampleIndex: 1 })
    expect(plan.oversizeFragment).toBe(true)
    // It IS the last fragment, so the plan still reaches the segment end even
    // though it exceeded budget to get there.
    expect(plan.reachesSegmentEnd).toBe(true)
  })

  it('an anchor before the segment start clamps onto the first fragment', () => {
    const plan = fragmentsWithinBudget(fixtureIndex(), -1, 1_000_000)
    expect(plan.fragments[0]?.sampleIndex).toBe(0)
  })
})

describe('fragmentsWithinBudget — synthetic index (three fragments)', () => {
  // Three fragments of 1000, 2000 and 500 bytes; mfraOffset caps the last one.
  const index: MfraIndex = {
    trackId: 1,
    mfraOffset: 3_500,
    samples: [
      { timeTicks: 0, moofOffset: 0 },
      { timeTicks: 1_000, moofOffset: 1_000 },
      { timeTicks: 2_000, moofOffset: 3_000 },
    ],
  }

  it('stops adding fragments the instant the next one would overflow the budget', () => {
    // frag0=1000B, frag0+frag1=3000B, frag0+frag1+frag2=3500B.
    const plan = fragmentsWithinBudget(index, 0, 3_400)
    expect(plan.fragments.map((f) => f.sampleIndex)).toEqual([0, 1])
    expect(plan.end).toBe(3_000)
    expect(plan.reachesSegmentEnd).toBe(false)
    expect(plan.oversizeFragment).toBe(false)
  })

  it('a budget covering everything returns all three fragments in order', () => {
    const plan = fragmentsWithinBudget(index, 0, 3_500)
    expect(plan.fragments.map((f) => f.sampleIndex)).toEqual([0, 1, 2])
    expect(plan.start).toBe(0)
    expect(plan.end).toBe(3_500)
    expect(plan.reachesSegmentEnd).toBe(true)
  })

  it('anchoring mid-file never walks backward to include earlier fragments', () => {
    const plan = fragmentsWithinBudget(index, 1_000, 10_000)
    expect(plan.fragments.map((f) => f.sampleIndex)).toEqual([1, 2])
    expect(plan.start).toBe(1_000)
  })
})

/**
 * fragmentsInWindow — the replay's window primitive: convert a TIME range
 * (not a byte budget) into the set of consecutive fragments that covers it.
 * `maxBytes` is a safety ceiling here, not the stop condition — the loop
 * stops when the NEXT fragment's own start time already reaches `toTicks`,
 * because at that point the fragments already collected cover the window.
 *
 * Same real fixture as `fragmentsWithinBudget` above: frag1 [1370, 87665)
 * covers ticks [0, 352260) (0-3914 ms @ 90 kHz), frag2 [87665, 88547) covers
 * ticks [352260, segment end) (3914-4000 ms).
 */
describe('fragmentsInWindow — real fixture (two fragments)', () => {
  it('a window fully inside fragment 1 returns ONLY fragment 1 — fragment 2 is never fetched', () => {
    // Window [200ms, 1200ms) -> ticks [18000, 108000). Fragment 2 starts at
    // tick 352260 (3914 ms), well past the window end.
    const plan = fragmentsInWindow(fixtureIndex(), 18_000, 108_000, 1_000_000)
    expect(plan.fragments).toHaveLength(1)
    expect(plan.fragments[0]).toEqual({ start: FRAG1.start, end: FRAG1.end, sampleIndex: 0 })
    expect(plan.reachesWindowEnd).toBe(true) // fragment 1 alone already covers past 1200ms
    expect(plan.reachesSegmentEnd).toBe(false)
  })

  it('a window spanning both fragments includes both, in one contiguous range', () => {
    // Window [200ms, 3999ms) -> ticks [18000, 359910). Fragment 2 starts at
    // 352260, before the window end, so it must be included too.
    const plan = fragmentsInWindow(fixtureIndex(), 18_000, 359_910, 1_000_000)
    expect(plan.fragments.map((f) => f.sampleIndex)).toEqual([0, 1])
    expect(plan.start).toBe(FRAG1.start)
    expect(plan.end).toBe(MFRA_OFFSET)
    expect(plan.reachesWindowEnd).toBe(true)
    expect(plan.reachesSegmentEnd).toBe(true)
  })

  it('a window reaching past the segment end still stops at the segment — reachesWindowEnd is honest', () => {
    // toTicks far beyond anything the segment has: the walk runs off the end
    // of the index, not off satisfying the window.
    const plan = fragmentsInWindow(fixtureIndex(), 18_000, 10_000_000, 1_000_000)
    expect(plan.fragments.map((f) => f.sampleIndex)).toEqual([0, 1])
    expect(plan.reachesSegmentEnd).toBe(true)
    // The segment ran out before the requested end did — still true because
    // there is nothing more to serve, not because the window was satisfied
    // by more data existing beyond it.
    expect(plan.reachesWindowEnd).toBe(true)
  })

  it('a safety byte cap smaller than both fragments truncates BEFORE the window is covered, and says so', () => {
    // frag1 alone = 86 295 B; a cap that fits frag1 but not frag1+frag2.
    const plan = fragmentsInWindow(fixtureIndex(), 18_000, 359_910, 87_000)
    expect(plan.fragments).toHaveLength(1)
    expect(plan.reachesWindowEnd).toBe(false) // truncated, not satisfied
    expect(plan.reachesSegmentEnd).toBe(false)
  })

  it('NEVER an empty set: a cap smaller than fragment 1 alone still returns fragment 1', () => {
    const plan = fragmentsInWindow(fixtureIndex(), 18_000, 108_000, 500)
    expect(plan.fragments).toHaveLength(1)
    expect(plan.oversizeFragment).toBe(true)
  })

  it('anchoring at the second fragment starts there, not at the segment start', () => {
    const plan = fragmentsInWindow(fixtureIndex(), 352_260, 400_000, 1_000_000)
    expect(plan.fragments).toHaveLength(1)
    expect(plan.fragments[0]).toEqual({ start: FRAG2.start, end: FRAG2.end, sampleIndex: 1 })
    expect(plan.reachesSegmentEnd).toBe(true)
    expect(plan.reachesWindowEnd).toBe(true)
  })
})
