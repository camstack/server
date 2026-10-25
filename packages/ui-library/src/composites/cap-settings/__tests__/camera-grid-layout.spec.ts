import { describe, expect, it } from 'vitest'
import {
  clampNormalizedRect,
  moveNormalizedRect,
  parseGridView,
  resizeNormalizedRect,
} from '../camera-grid-layout.js'

const FULL = { x: 0, y: 0, width: 1, height: 1 }

describe('parseGridView', () => {
  const OFFERS = [
    { profile: 'high', offered: true, missingSources: [], canvas: '1920x1080', published: true },
    { profile: 'mid', offered: false, missingSources: [101], canvas: '', published: false },
    { profile: 'low', offered: false, missingSources: [611, 101], canvas: '', published: false },
  ]

  it('reads a grid the CAP answered with — the view itself, no envelope', () => {
    const view = parseGridView({
      instanceId: 'i1',
      deviceId: 900,
      name: 'Front',
      fps: 10,
      cells: [{ deviceId: 611, source: FULL, cell: FULL }],
      profiles: OFFERS,
    })
    expect(view).toEqual({
      instanceId: 'i1',
      deviceId: 900,
      name: 'Front',
      fps: 10,
      cells: [{ deviceId: 611, source: FULL, cell: FULL }],
      profiles: OFFERS,
    })
  })

  it('distinguishes ANSWERED-with-nothing from UNREADABLE', () => {
    // `null` is the camera saying "I am not a grid". Anything else is a reply
    // this page could not read — and the two must not render the same, or "not
    // yet known" looks exactly like "not installed" (D315).
    expect(parseGridView(null)).toBeNull()
    expect(parseGridView(undefined)).toBe('unreadable')
    expect(parseGridView({})).toBe('unreadable')
    expect(parseGridView({ instanceId: 'i1' })).toBe('unreadable')
  })

  it('refuses a reply with no profile report — a grid that says nothing offers nothing', () => {
    expect(
      parseGridView({
        instanceId: 'i1',
        deviceId: 900,
        name: 'x',
        fps: 10,
        cells: [],
      }),
    ).toBe('unreadable')
  })

  it('refuses a cell whose rectangle is out of the unit square', () => {
    expect(
      parseGridView({
        instanceId: 'i1',
        deviceId: 900,
        name: 'x',
        fps: 10,
        cells: [{ deviceId: 611, source: { x: 0.8, y: 0, width: 0.5, height: 1 }, cell: FULL }],
        profiles: OFFERS,
      }),
    ).toBe('unreadable')
  })
})

describe('clampNormalizedRect', () => {
  it('keeps a rectangle inside the unit square instead of letting it clip silently', () => {
    expect(clampNormalizedRect({ x: -0.2, y: 0.9, width: 0.5, height: 0.5 })).toEqual({
      x: 0,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    })
  })

  it('shrinks a rectangle that is larger than the square it lives in', () => {
    expect(clampNormalizedRect({ x: 0, y: 0, width: 2, height: 3 })).toEqual(FULL)
  })

  it('never produces a zero-area rectangle — ffmpeg would refuse the crop', () => {
    const tiny = clampNormalizedRect({ x: 0.5, y: 0.5, width: 0, height: -1 })
    expect(tiny.width).toBeGreaterThan(0)
    expect(tiny.height).toBeGreaterThan(0)
  })
})

describe('moveNormalizedRect / resizeNormalizedRect', () => {
  it('moves by a normalized delta and stays in bounds', () => {
    expect(moveNormalizedRect({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 }, 0.5, 0)).toEqual({
      x: 0.5,
      y: 0.5,
      width: 0.5,
      height: 0.5,
    })
    expect(moveNormalizedRect({ x: 0, y: 0, width: 0.5, height: 0.5 }, 0.25, 0.25)).toEqual({
      x: 0.25,
      y: 0.25,
      width: 0.5,
      height: 0.5,
    })
  })

  it('resizes from the bottom-right corner, keeping the origin', () => {
    expect(
      resizeNormalizedRect({ x: 0.25, y: 0.25, width: 0.25, height: 0.25 }, 0.25, 0.5),
    ).toEqual({ x: 0.25, y: 0.25, width: 0.5, height: 0.75 })
  })
})

describe('publishing a profile', () => {
  it('reads a profile an older hub says nothing about as PUBLISHED', () => {
    // Such a hub publishes whatever it offers, so absence must render the way
    // it behaves — anything else would show a grid as half switched off.
    const view = parseGridView({
      instanceId: 'i1',
      deviceId: 900,
      name: 'Front',
      fps: 10,
      cells: [{ deviceId: 611, source: FULL, cell: FULL }],
      profiles: [{ profile: 'low', offered: true, missingSources: [] }],
    })
    expect(view).not.toBe('unreadable')
    expect(view !== null && view !== 'unreadable' && view.profiles[0]?.published).toBe(true)
  })

  it('keeps PUBLISHED distinct from OFFERED — serviceable is not the same as on', () => {
    const view = parseGridView({
      instanceId: 'i1',
      deviceId: 900,
      name: 'Front',
      fps: 10,
      cells: [{ deviceId: 611, source: FULL, cell: FULL }],
      profiles: [
        {
          profile: 'high',
          offered: true,
          missingSources: [],
          canvas: '3840x2160',
          published: false,
        },
      ],
    })
    const row = view !== null && view !== 'unreadable' ? view.profiles[0] : undefined
    expect(row?.offered).toBe(true)
    expect(row?.published).toBe(false)
    expect(row?.canvas).toBe('3840x2160')
  })
})
