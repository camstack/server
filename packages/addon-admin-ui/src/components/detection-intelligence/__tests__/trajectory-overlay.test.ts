import { describe, it, expect } from 'vitest'
import {
  buildTrajectoryOverlay,
  type TrajectoryFrame,
  type TrajectoryInput,
} from '../trajectory-overlay.js'

// A 100×100 frame keeps px == percent so expectations read cleanly; real
// frames are e.g. 640×360 (see getObjectEvents frameWidth/frameHeight).
const FRAME: TrajectoryFrame = { width: 100, height: 100 }

const mkInput = (
  x: number,
  y: number,
  bbox: { x: number; y: number; w: number; h: number } = { x, y, w: 10, h: 10 },
): TrajectoryInput => ({ x, y, bbox })

describe('buildTrajectoryOverlay', () => {
  it('returns empty overlay for no positions', () => {
    expect(buildTrajectoryOverlay([], FRAME)).toEqual({
      polyline: '',
      points: [],
      snapshots: [],
      start: null,
      end: null,
      peakBox: null,
    })
  })

  it('returns empty overlay when the frame is unknown (still loading)', () => {
    expect(buildTrajectoryOverlay([mkInput(10, 20)], null)).toEqual({
      polyline: '',
      points: [],
      snapshots: [],
      start: null,
      end: null,
      peakBox: null,
    })
  })

  it('returns empty overlay for a degenerate frame', () => {
    expect(buildTrajectoryOverlay([mkInput(10, 20)], { width: 0, height: 100 })).toEqual({
      polyline: '',
      points: [],
      snapshots: [],
      start: null,
      end: null,
      peakBox: null,
    })
  })

  it('normalizes native pixels against the frame dims (640×360)', () => {
    // centroid (320,180) is dead-centre of a 640×360 frame → (50,50).
    const overlay = buildTrajectoryOverlay([mkInput(320, 180, { x: 64, y: 36, w: 192, h: 144 })], {
      width: 640,
      height: 360,
    })
    expect(overlay.start).toEqual({ x: 50, y: 50 })
    expect(overlay.end).toEqual({ x: 50, y: 50 })
    expect(overlay.peakBox).toEqual({ x: 10, y: 10, w: 30, h: 40 })
    expect(overlay.points).toEqual([{ x: 50, y: 50 }])
  })

  it('handles a single point: start===end, no polyline, one point', () => {
    const overlay = buildTrajectoryOverlay([mkInput(25, 50, { x: 10, y: 20, w: 30, h: 40 })], FRAME)
    expect(overlay.start).toEqual({ x: 25, y: 50 })
    expect(overlay.end).toEqual({ x: 25, y: 50 })
    expect(overlay.start).toEqual(overlay.end)
    expect(overlay.polyline).toBe('')
    expect(overlay.points).toEqual([{ x: 25, y: 50 }])
    expect(overlay.peakBox).toEqual({ x: 10, y: 20, w: 30, h: 40 })
  })

  it('builds a 2-point polyline in 0..100 space with a dot per position', () => {
    const overlay = buildTrajectoryOverlay([mkInput(0, 0), mkInput(100, 100)], FRAME)
    expect(overlay.polyline).toBe('0,0 100,100')
    expect(overlay.points).toEqual([
      { x: 0, y: 0 },
      { x: 100, y: 100 },
    ])
    expect(overlay.start).toEqual({ x: 0, y: 0 })
    expect(overlay.end).toEqual({ x: 100, y: 100 })
  })

  it('downsamples 300 points to ≤120 coord pairs and preserves first + last', () => {
    const positions: TrajectoryInput[] = []
    for (let i = 0; i < 300; i++) {
      const t = i / 299
      positions.push(mkInput(t * 100, t * 100))
    }
    const overlay = buildTrajectoryOverlay(positions, FRAME)
    const pairs = overlay.polyline.split(' ')
    expect(pairs.length).toBeLessThanOrEqual(120)
    expect(overlay.points.length).toBe(pairs.length)
    expect(overlay.start).toEqual({ x: 0, y: 0 })
    expect(overlay.end).toEqual({ x: 100, y: 100 })
    expect(pairs[0]).toBe('0,0')
    expect(pairs[pairs.length - 1]).toBe('100,100')
  })

  it('respects a custom maxPoints and keeps first+last', () => {
    const positions: TrajectoryInput[] = []
    for (let i = 0; i < 50; i++) positions.push(mkInput((i / 49) * 100, (i / 49) * 100))
    const overlay = buildTrajectoryOverlay(positions, FRAME, { maxPoints: 10 })
    const pairs = overlay.polyline.split(' ')
    expect(pairs.length).toBe(10)
    expect(overlay.points.length).toBe(10)
    expect(pairs[0]).toBe('0,0')
    expect(pairs[pairs.length - 1]).toBe('100,100')
  })

  it('clamps out-of-range coords into [0,100]', () => {
    const overlay = buildTrajectoryOverlay(
      [mkInput(140, -20, { x: -50, y: 140, w: 10, h: 10 }), mkInput(50, 50)],
      FRAME,
    )
    expect(overlay.start).toEqual({ x: 100, y: 0 })
    expect(overlay.peakBox?.x).toBe(0)
    expect(overlay.peakBox?.y).toBe(100)
  })

  it('has no snapshot markers when none are supplied', () => {
    const overlay = buildTrajectoryOverlay([mkInput(50, 50)], FRAME)
    expect(overlay.snapshots).toEqual([])
  })

  it('scales snapshot checkpoints against the detection dims and keeps mediaKey', () => {
    // 640×360 detection frame: centroid (320,180) → (50,50), (160,90) → (25,25).
    const overlay = buildTrajectoryOverlay(
      [mkInput(320, 180), mkInput(160, 90)],
      { width: 640, height: 360 },
      {
        snapshots: [
          { x: 320, y: 180, mediaId: 11 },
          { x: 160, y: 90, mediaId: 12 },
        ],
      },
    )
    expect(overlay.snapshots).toEqual([
      { x: 50, y: 50, mediaId: 11 },
      { x: 25, y: 25, mediaId: 12 },
    ])
  })

  it('clamps out-of-range snapshot coords into [0,100]', () => {
    const overlay = buildTrajectoryOverlay([mkInput(50, 50)], FRAME, {
      snapshots: [{ x: 140, y: -20, mediaId: 13 }],
    })
    expect(overlay.snapshots).toEqual([{ x: 100, y: 0, mediaId: 13 }])
  })

  it('picks peakBox as the entry with the largest bbox area', () => {
    const overlay = buildTrajectoryOverlay(
      [
        mkInput(0, 0, { x: 0, y: 0, w: 10, h: 10 }),
        mkInput(50, 50, { x: 20, y: 30, w: 50, h: 60 }), // largest area
        mkInput(100, 100, { x: 40, y: 40, w: 20, h: 20 }),
      ],
      FRAME,
    )
    expect(overlay.peakBox).toEqual({ x: 20, y: 30, w: 50, h: 60 })
  })
})
