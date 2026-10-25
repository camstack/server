import { describe, expect, it } from 'vitest'
import {
  NC_LABEL_INSIDE_MAX_HEIGHT_FRACTION,
  type NcLabelBox,
  labelPlateSize,
  layoutBoxLabels,
} from '../notification-label-layout.js'

const W = 640
const H = 360
const FONT = 14
/** 'person 91%' at 14 px: 98 × 19. */
const PLATE = labelPlateSize('person 91%', FONT)

function box(over: Partial<NcLabelBox> & Pick<NcLabelBox, 'x' | 'y' | 'w' | 'h'>): NcLabelBox {
  return { role: 'other', label: 'person 91%', ...over }
}

describe('layoutBoxLabels', () => {
  it('puts the label ABOVE the box, outside it, when there is room', () => {
    const out = layoutBoxLabels({
      width: W,
      height: H,
      fontSize: FONT,
      boxes: [box({ x: 100, y: 100, w: 160, h: 200, role: 'subject' })],
    })
    expect(out.placements[0]).toEqual({
      x: 100,
      y: 100 - PLATE.h,
      w: PLATE.w,
      h: PLATE.h,
      where: 'above',
    })
    expect(out.placed).toBe(1)
    expect(out.dropped).toBe(0)
  })

  it('puts it BELOW the box when the top of the image clips it', () => {
    const out = layoutBoxLabels({
      width: W,
      height: H,
      fontSize: FONT,
      boxes: [box({ x: 100, y: 5, w: 160, h: 60 })],
    })
    expect(out.placements[0]?.where).toBe('below')
    expect(out.placements[0]?.y).toBe(65)
  })

  it('goes INSIDE the top edge only for a box the label covers a small part of', () => {
    // Box fills the image height: no room above or below.
    const tall = layoutBoxLabels({
      width: W,
      height: H,
      fontSize: FONT,
      boxes: [box({ x: 100, y: 0, w: 200, h: H })],
    })
    expect(tall.placements[0]).toEqual({
      x: 100,
      y: 0,
      w: PLATE.w,
      h: PLATE.h,
      where: 'inside',
    })
    // Same, but the label would cover more than the threshold of its height.
    const shortH = Math.floor(PLATE.h / NC_LABEL_INSIDE_MAX_HEIGHT_FRACTION) - 1
    const short = layoutBoxLabels({
      width: W,
      height: shortH,
      fontSize: FONT,
      boxes: [box({ x: 100, y: 0, w: 200, h: shortH })],
    })
    expect(short.placements[0]).toBeNull()
  })

  it('drops the label of a TINY box rather than cover it', () => {
    // Touches the top, and the bottom of the image: nowhere outside; 30 px tall.
    const out = layoutBoxLabels({
      width: W,
      height: 30,
      fontSize: FONT,
      boxes: [box({ x: 10, y: 0, w: 40, h: 30 })],
    })
    expect(out.placements[0]).toBeNull()
    expect(out.placed).toBe(0)
    expect(out.dropped).toBe(1)
  })

  it('drops a label that would land on ANOTHER box', () => {
    // Box A at the top (no room above); box B directly beneath it, so "below" lands on B;
    // A is too short for inside.
    const out = layoutBoxLabels({
      width: W,
      height: H,
      fontSize: FONT,
      boxes: [
        box({ x: 100, y: 0, w: 160, h: 40, role: 'subject' }),
        box({ x: 90, y: 45, w: 200, h: 200, label: 'car 60%', score: 0.6 }),
      ],
    })
    expect(out.placements[0]).toBeNull()
    // B's own label goes below it (above it would land on A).
    expect(out.placements[1]?.where).toBe('below')
    expect(out).toMatchObject({ placed: 1, dropped: 1 })
  })

  it('the SUBJECT label wins the spot a neighbour also wants; neighbours then go by score', () => {
    // Two boxes side by side at y=100 whose "above" plates would collide; the
    // neighbour is listed FIRST and scores higher — the subject still wins.
    const out = layoutBoxLabels({
      width: W,
      height: 140,
      fontSize: FONT,
      boxes: [
        box({ x: 150, y: 100, w: 40, h: 40, label: 'dog 99%', score: 0.99 }),
        box({ x: 100, y: 100, w: 40, h: 40, role: 'subject' }),
        box({ x: 400, y: 100, w: 40, h: 40, label: 'cat 50%', score: 0.5 }),
        box({ x: 420, y: 100, w: 40, h: 40, label: 'cat 90%', score: 0.9 }),
      ],
    })
    expect(out.placements[1]?.where).toBe('above')
    expect(out.placements[0]).toBeNull()
    // Of the two colliding cats, the higher score keeps its label.
    expect(out.placements[3]?.where).toBe('above')
    expect(out.placements[2]).toBeNull()
  })

  it('never shrinks the font to make a label fit — a plate wider than the image is dropped', () => {
    const out = layoutBoxLabels({
      width: 60,
      height: H,
      fontSize: FONT,
      boxes: [box({ x: 0, y: 100, w: 60, h: 100 })],
    })
    expect(out.placements[0]).toBeNull()
  })

  it('an empty label is neither placed nor dropped', () => {
    const out = layoutBoxLabels({
      width: W,
      height: H,
      fontSize: FONT,
      boxes: [box({ x: 100, y: 100, w: 50, h: 50, label: '' })],
    })
    expect(out).toMatchObject({ placements: [null], placed: 0, dropped: 0 })
  })
})
