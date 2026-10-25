import { describe, expect, it } from 'vitest'
import { estimateLabelWidth, LABEL_HEIGHT_PX, placeLabel } from '../lib/retrain-label-place.js'

const FRAME = { left: 0, top: 40, width: 390, height: 260 }
const W = estimateLabelWidth('person')

describe('placeLabel', () => {
  it('keeps the tag left-anchored above a box with room', () => {
    const box = { left: 20, top: 120, width: 80, height: 100 }
    expect(placeLabel(box, W, FRAME)).toEqual({ anchor: 'left', row: 'above' })
  })

  it('flips to the right edge when the tag would overflow the frame on the right', () => {
    const box = { left: 360, top: 120, width: 28, height: 90 }
    expect(placeLabel(box, W, FRAME).anchor).toBe('right')
  })

  it('flips only when the flipped tag overflows less', () => {
    // A narrow box at the left of a narrow frame: flipping would clip on the left instead.
    const tiny = { left: 4, top: 120, width: 6, height: 40 }
    expect(placeLabel(tiny, 100, { ...FRAME, width: 90 }).anchor).toBe('left')
  })

  it('moves inside the box when there is no room above it', () => {
    const box = { left: 20, top: FRAME.top + LABEL_HEIGHT_PX - 1, width: 80, height: 100 }
    expect(placeLabel(box, W, FRAME).row).toBe('inside')
    expect(placeLabel({ ...box, top: FRAME.top + LABEL_HEIGHT_PX }, W, FRAME).row).toBe('above')
  })

  it('grows the estimate with the text', () => {
    expect(estimateLabelWidth('traffic light')).toBeGreaterThan(estimateLabelWidth('cat'))
  })
})
