import { afterEach, describe, expect, it } from 'vitest'
import { computeListboxCoords, listboxAnchorStyle } from '../listbox-position'

const GAP = 4

function triggerAt(top: number, height = 36): Element {
  const el = document.createElement('div')
  const rect: DOMRect = {
    top,
    bottom: top + height,
    left: 20,
    right: 220,
    width: 200,
    height,
    x: 20,
    y: top,
    toJSON: () => ({}),
  }
  el.getBoundingClientRect = () => rect
  return el
}

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', {
    value: width,
    configurable: true,
  })
  Object.defineProperty(window, 'innerHeight', {
    value: height,
    configurable: true,
  })
}

afterEach(() => setViewport(1024, 768))

describe('computeListboxCoords', () => {
  it('anchors an above-list by its bottom edge, GAP px over the trigger', () => {
    setViewport(1024, 800)
    const coords = computeListboxCoords(triggerAt(700))
    expect(coords.placement).toBe('above')
    if (coords.placement !== 'above') return
    expect(coords.bottom).toBe(800 - 700 + GAP)
    expect(listboxAnchorStyle(coords)).toEqual({
      bottom: 104,
      left: coords.left,
    })
  })

  it('keeps a below-list pinned by its top edge', () => {
    setViewport(1024, 800)
    const coords = computeListboxCoords(triggerAt(100))
    expect(coords.placement).toBe('below')
    if (coords.placement !== 'below') return
    expect(coords.top).toBe(136 + GAP)
    expect(listboxAnchorStyle(coords)).toEqual({ top: 140, left: coords.left })
  })
})
