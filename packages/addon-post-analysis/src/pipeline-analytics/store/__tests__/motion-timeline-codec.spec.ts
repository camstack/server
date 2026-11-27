import { describe, expect, it } from 'vitest'
import { decodeMotionTimeline, encodeMotionTimeline } from '../motion-timeline-codec.js'

const box = (i: number) => ({ x: 300 + i, y: 170 - i, w: 20 + i, h: 9 + i })

describe('motion-timeline-codec', () => {
  it('round-trips samples', () => {
    const samples = [
      { t: 0, boxes: [box(0)] },
      { t: 1_000, boxes: [] },
      { t: 2_000, boxes: [box(1), box(2)] },
    ]
    expect(decodeMotionTimeline(encodeMotionTimeline(samples))).toEqual(samples)
  })

  it('a full 6-box sample stays within 80 bytes (71 measured)', () => {
    const one = encodeMotionTimeline([{ t: 1_500_000, boxes: [0, 1, 2, 3, 4, 5].map(box) }])
    expect(one.length - 'mt1:'.length).toBeLessThanOrEqual(80)
  })

  it('absent, foreign or truncated values read null, never []', () => {
    expect(decodeMotionTimeline(undefined)).toBeNull()
    expect(decodeMotionTimeline(null)).toBeNull()
    expect(decodeMotionTimeline('garbage')).toBeNull()
    expect(decodeMotionTimeline('mt1:')).toBeNull()
    const good = encodeMotionTimeline([{ t: 5, boxes: [box(0)] }])
    expect(decodeMotionTimeline(good.slice(0, good.length - 8))).toBeNull()
  })
})
