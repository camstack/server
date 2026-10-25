import { describe, expect, it } from 'vitest'
import { MAX_TILE_SUBJECTS_PER_FRAME, planTileCuts, type TileCandidate } from '../tile-cut-plan.js'

const FRAME = { width: 640, height: 360 }

const det = (
  x: number,
  y: number,
  width: number,
  height: number,
  score: number,
): TileCandidate => ({
  bbox: { x, y, width, height },
  score,
})

describe('planTileCuts', () => {
  it('normalises an analysis-frame box into the fraction of the scene both sides agree on', () => {
    expect(planTileCuts([det(64, 36, 128, 72, 0.9)], FRAME)).toEqual([
      { x: 0.1, y: 0.1, w: 0.2, h: 0.2 },
    ])
  })

  // The bound decides which tracks can later be enriched at native resolution,
  // so it must keep the boxes most likely to become confirmed tracks.
  it('orders by score and caps, so the bound drops the least likely subject', () => {
    const boxes = planTileCuts(
      [
        det(0, 0, 64, 36, 0.4),
        det(64, 0, 64, 36, 0.9),
        det(128, 0, 64, 36, 0.7),
        det(192, 0, 64, 36, 0.95),
        det(256, 0, 64, 36, 0.1),
      ],
      FRAME,
      2,
    )
    expect(boxes).toHaveLength(2)
    expect(boxes[0]?.x).toBeCloseTo(192 / 640) // 0.95
    expect(boxes[1]?.x).toBeCloseTo(64 / 640) // 0.90
  })

  it('defaults to the shipped per-frame cap', () => {
    const many = Array.from({ length: 12 }, (_, i) => det(i * 10, 0, 20, 20, i / 12))
    expect(planTileCuts(many, FRAME)).toHaveLength(MAX_TILE_SUBJECTS_PER_FRAME)
  })

  // The majority of frames. An empty plan is still SENT by the caller — it is
  // how a frame that detected nothing ends its hold, and that release is most
  // of the RAM this design gives back.
  it('a frame with no detections plans nothing (and costs nothing)', () => {
    expect(planTileCuts([], FRAME)).toEqual([])
  })

  it('drops a degenerate box rather than planning a zero-area container', () => {
    expect(planTileCuts([det(10, 10, 0, 50, 0.9)], FRAME)).toEqual([])
    expect(planTileCuts([det(10, 10, 50, -5, 0.9)], FRAME)).toEqual([])
  })

  it('drops a non-finite box rather than poisoning the worker’s geometry', () => {
    expect(planTileCuts([det(Number.NaN, 10, 50, 50, 0.9)], FRAME)).toEqual([])
    expect(planTileCuts([det(10, 10, Number.POSITIVE_INFINITY, 50, 0.9)], FRAME)).toEqual([])
  })

  it('a frame with no dimensions plans nothing rather than dividing by zero', () => {
    expect(planTileCuts([det(10, 10, 50, 50, 0.9)], { width: 0, height: 360 })).toEqual([])
  })

  it('does not mutate the caller’s detection array', () => {
    const input = [det(0, 0, 10, 10, 0.1), det(20, 0, 10, 10, 0.9)]
    const snapshot = [...input]
    planTileCuts(input, FRAME)
    expect(input).toEqual(snapshot)
  })
})
