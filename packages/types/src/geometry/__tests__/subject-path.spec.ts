import { describe, expect, it } from 'vitest'
import {
  SUBJECT_PATH_MAX_POINTS,
  buildSubjectPath,
  isDrawableSubjectPath,
  projectSubjectPath,
  subjectPathSampleFromBox,
  subjectPathSvgPoints,
} from '../subject-path.js'

const at = (x: number, y: number, timestamp?: number) => ({
  x,
  y,
  w: 0.1,
  h: 0.1,
  ...(timestamp !== undefined ? { timestamp } : {}),
})

describe('buildSubjectPath', () => {
  it('is empty — not drawable — for no samples and for one', () => {
    expect(buildSubjectPath([]).nodes).toEqual([])
    expect(isDrawableSubjectPath(buildSubjectPath([at(0.5, 0.5)]))).toBe(false)
  })

  it('draws the centres oldest → newest', () => {
    const path = buildSubjectPath([at(0.1, 0.1, 1), at(0.5, 0.5, 2), at(0.9, 0.2, 3)])
    expect(path.nodes.map((n) => [n.x, n.y])).toEqual([
      [0.1, 0.1],
      [0.5, 0.5],
      [0.9, 0.2],
    ])
    expect(isDrawableSubjectPath(path)).toBe(true)
  })

  it('stops at the instant of the frame it is drawn on', () => {
    const path = buildSubjectPath([at(0.1, 0.1, 1), at(0.5, 0.5, 2), at(0.9, 0.2, 3)], {
      untilTimestamp: 2,
    })
    expect(path.nodes.map((n) => n.x)).toEqual([0.1, 0.5])
  })

  it('never uses a full-frame placeholder box as a point, and counts it', () => {
    const path = buildSubjectPath([
      at(0.1, 0.1, 1),
      { x: 0.5, y: 0.5, w: 0.99, h: 0.95, timestamp: 2 },
      at(0.3, 0.3, 3),
    ])
    expect(path.nodes.map((n) => n.x)).toEqual([0.1, 0.3])
    expect(path.unlocalized).toBe(1)
  })

  it('collapses a dwell into one node and still ends on the last sample', () => {
    const path = buildSubjectPath([
      at(0.2, 0.2, 1),
      at(0.2, 0.2, 2),
      at(0.2, 0.2, 3),
      at(0.6, 0.6, 4),
      at(0.6, 0.6, 5),
      at(0.602, 0.602, 6),
    ])
    expect(path.nodes[0]).toMatchObject({ x: 0.2, samples: 3, firstTs: 1, lastTs: 3 })
    const end = path.nodes[path.nodes.length - 1]
    expect(end).toMatchObject({ x: 0.602, y: 0.602 })
  })

  it('downsamples a long track keeping first and last', () => {
    const samples = Array.from({ length: 400 }, (_, i) => at(i / 399, 0.5, i))
    const path = buildSubjectPath(samples)
    expect(path.nodes.length).toBeLessThanOrEqual(SUBJECT_PATH_MAX_POINTS)
    expect(path.nodes[0]?.x).toBe(0)
    expect(path.nodes[path.nodes.length - 1]?.x).toBe(1)
  })

  it('clamps out-of-frame centres and skips non-finite samples', () => {
    const path = buildSubjectPath([at(-0.2, 1.4, 1), at(Number.NaN, 0.5, 2), at(0.5, 0.5, 3)])
    expect(path.nodes.map((n) => [n.x, n.y])).toEqual([
      [0, 1],
      [0.5, 0.5],
    ])
  })

  it('takes the centre of a box', () => {
    expect(subjectPathSampleFromBox({ x: 0.2, y: 0.4, w: 0.2, h: 0.2 }, 7)).toEqual({
      x: 0.30000000000000004,
      y: 0.5,
      w: 0.2,
      h: 0.2,
      timestamp: 7,
    })
  })
})

describe('projectSubjectPath', () => {
  const full = { x: 0, y: 0, w: 1, h: 1 }

  it('is the path itself over the whole frame', () => {
    const pts = [
      { x: 0.1, y: 0.1 },
      { x: 0.9, y: 0.9 },
    ]
    expect(projectSubjectPath(pts, full)).toEqual([pts])
  })

  it('draws nothing for fewer than two points', () => {
    expect(projectSubjectPath([{ x: 0.5, y: 0.5 }], full)).toEqual([])
  })

  it('maps into a crop and clips what falls outside it', () => {
    // Crop = the right half. The path runs from the left edge across to 0.75.
    const runs = projectSubjectPath(
      [
        { x: 0.25, y: 0.5 },
        { x: 0.75, y: 0.5 },
      ],
      { x: 0.5, y: 0, w: 0.5, h: 1 },
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]).toEqual([
      { x: 0, y: 0.5 },
      { x: 0.5, y: 0.5 },
    ])
  })

  it('splits a path that leaves the crop and comes back into two runs', () => {
    const runs = projectSubjectPath(
      [
        { x: 0.3, y: 0.3 },
        { x: 0.4, y: 0.3 },
        { x: 0.9, y: 0.9 },
        { x: 0.4, y: 0.4 },
        { x: 0.3, y: 0.4 },
      ],
      { x: 0.25, y: 0.25, w: 0.25, h: 0.25 },
    )
    expect(runs).toHaveLength(2)
  })

  it('draws nothing when the whole path is outside the crop', () => {
    expect(
      projectSubjectPath(
        [
          { x: 0.1, y: 0.1 },
          { x: 0.2, y: 0.1 },
        ],
        { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
      ),
    ).toEqual([])
  })

  it('formats a run as SVG points in pixels', () => {
    expect(
      subjectPathSvgPoints(
        [
          { x: 0, y: 0.5 },
          { x: 0.5, y: 1 },
        ],
        200,
        100,
      ),
    ).toBe('0,50 100,100')
  })
})
