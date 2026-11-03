import { describe, expect, it } from 'vitest'
import {
  classifyLayer,
  describeLayer,
  resolveDebugLayers,
  type RectLike,
  type StyleLike,
} from '../debug-layers'

const PLAIN: StyleLike = {
  position: 'static',
  zIndex: 'auto',
  opacity: '1',
  filter: 'none',
  backdropFilter: 'none',
  webkitBackdropFilter: 'none',
  transform: 'none',
  perspective: 'none',
  isolation: 'auto',
  mixBlendMode: 'normal',
  willChange: 'auto',
}
const TOP: RectLike = { top: 0, bottom: 56, width: 390, height: 56 }

describe('classifyLayer', () => {
  it('ignores a plain element', () => {
    expect(classifyLayer(PLAIN, TOP)).toBeNull()
  })

  it.each([
    [{ position: 'fixed' }, 'fixed'],
    [{ position: 'sticky' }, 'sticky'],
    [{ backdropFilter: 'blur(8px)' }, 'backdrop-filter'],
    [{ webkitBackdropFilter: 'blur(8px)' }, 'backdrop-filter'],
    [{ filter: 'blur(2px)' }, 'filter'],
    [{ opacity: '0.6' }, 'opacity'],
    [{ transform: 'matrix(1, 0, 0, 1, 0, 4)' }, 'transform'],
    [{ perspective: '100px' }, 'perspective'],
    [{ isolation: 'isolate' }, 'isolation'],
    [{ mixBlendMode: 'multiply' }, 'mix-blend-mode'],
    [{ willChange: 'transform' }, 'will-change'],
  ] as const)('flags %j as %s', (patch, reason) => {
    expect(classifyLayer({ ...PLAIN, ...patch }, TOP)?.reasons).toEqual([reason])
  })

  it('lists every reason and keeps the z-index', () => {
    const found = classifyLayer(
      { ...PLAIN, position: 'fixed', zIndex: '40', backdropFilter: 'blur(4px)' },
      TOP,
    )
    expect(found).toEqual({ reasons: ['fixed', 'backdrop-filter'], zIndex: '40' })
  })

  it('does not flag opacity 1 or an unparseable opacity', () => {
    expect(classifyLayer({ ...PLAIN, opacity: '1' }, TOP)).toBeNull()
    expect(classifyLayer({ ...PLAIN, opacity: '' }, TOP)).toBeNull()
  })

  it('skips elements outside the top band, empty, or scrolled away', () => {
    const fixed = { ...PLAIN, position: 'fixed' }
    expect(classifyLayer(fixed, { top: 120, bottom: 200, width: 10, height: 80 })).toBeNull()
    expect(classifyLayer(fixed, { top: -80, bottom: 0, width: 10, height: 80 })).toBeNull()
    expect(classifyLayer(fixed, { top: 0, bottom: 0, width: 10, height: 0 })).toBeNull()
    expect(classifyLayer(fixed, { top: 119, bottom: 200, width: 10, height: 81 })).not.toBeNull()
  })
})

describe('describeLayer', () => {
  const finding = { reasons: ['fixed', 'opacity'] as const, zIndex: '30' }
  it('names an element by its first classes', () => {
    expect(describeLayer('HEADER', 'sticky top-0 z-30 bg-surface', null, finding)).toBe(
      'header.sticky.top-0.z-30 z=30 fixed+opacity',
    )
  })
  it('prefers a component data attribute', () => {
    expect(describeLayer('div', 'a b', 'data-testid=mobile-top-bar', finding)).toBe(
      'div[data-testid=mobile-top-bar] z=30 fixed+opacity',
    )
  })
})

describe('resolveDebugLayers', () => {
  it('turns on and persists with ?debugLayers=1', () => {
    expect(resolveDebugLayers('?debugLayers=1', null)).toEqual({ on: true, persist: '1' })
  })
  it('turns off and forgets with ?debugLayers=0', () => {
    expect(resolveDebugLayers('?debugLayers=0', '1')).toEqual({ on: false, persist: null })
  })
  it('follows the remembered value without a query', () => {
    expect(resolveDebugLayers('', '1')).toEqual({ on: true, persist: 'keep' })
    expect(resolveDebugLayers('?x=1', null)).toEqual({ on: false, persist: 'keep' })
  })
})
