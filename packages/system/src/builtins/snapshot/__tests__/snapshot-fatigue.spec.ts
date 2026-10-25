import { describe, expect, it } from 'vitest'
import { NativeSnapshotFatigue } from '../snapshot-fatigue.js'

/**
 * A camera that cannot answer a snapshot is not helped by being asked
 * again two seconds later. "Camera retro casa" (Hikvision, weak link)
 * answered HTTP 503 to 68 native snapshot dials in one hour on 2026-09-05,
 * every one of them a fresh ISAPI request on a camera already struggling to
 * keep its streams up. The rest window grows with the streak and resets on
 * the first frame that lands.
 */
describe('NativeSnapshotFatigue', () => {
  it('rests nobody until a dial has failed', () => {
    const f = new NativeSnapshotFatigue()
    expect(f.restingUntil(101, 1_000)).toBeNull()
  })

  it('one failure earns the base rest; each consecutive failure doubles it, up to the cap', () => {
    const f = new NativeSnapshotFatigue({ baseMs: 10_000, maxMs: 60_000 })
    expect(f.recordFailure(101, 0)).toEqual({ streak: 1, restMs: 10_000 })
    expect(f.restingUntil(101, 5_000)).toBe(10_000)
    expect(f.restingUntil(101, 10_000)).toBeNull()
    expect(f.recordFailure(101, 10_000)).toEqual({ streak: 2, restMs: 20_000 })
    expect(f.recordFailure(101, 30_000)).toEqual({ streak: 3, restMs: 40_000 })
    expect(f.recordFailure(101, 70_000)).toEqual({ streak: 4, restMs: 60_000 })
    expect(f.recordFailure(101, 130_000)).toEqual({ streak: 5, restMs: 60_000 })
  })

  it('a frame that lands ends the rest and the streak', () => {
    const f = new NativeSnapshotFatigue({ baseMs: 10_000, maxMs: 60_000 })
    f.recordFailure(101, 0)
    f.recordFailure(101, 10_000)
    f.recordSuccess(101)
    expect(f.restingUntil(101, 11_000)).toBeNull()
    expect(f.recordFailure(101, 12_000)).toEqual({ streak: 1, restMs: 10_000 })
  })

  it('keeps cameras apart and forgets a removed one', () => {
    const f = new NativeSnapshotFatigue()
    f.recordFailure(101, 0)
    expect(f.restingUntil(102, 1_000)).toBeNull()
    f.forget(101)
    expect(f.restingUntil(101, 1_000)).toBeNull()
  })
})
