import { describe, expect, it } from 'vitest'
import {
  DEBUG_LAYERS_STORAGE_KEY,
  DEBUG_NO_BLUR_STORAGE_KEY,
  classifyLayer,
  createDebugLayersStore,
  describeLayer,
  formatCompositing,
  DEBUG_OUTLINES_STORAGE_KEY,
  DEBUG_TOP_LAYER_STORAGE_KEY,
  resolveDebugLayers,
  type FlagStorage,
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
      {
        ...PLAIN,
        position: 'fixed',
        zIndex: '40',
        backdropFilter: 'blur(4px)',
      },
      TOP,
    )
    expect(found).toEqual({
      reasons: ['fixed', 'backdrop-filter'],
      zIndex: '40',
    })
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
    expect(resolveDebugLayers('?debugLayers=1', null)).toEqual({
      on: true,
      persist: '1',
    })
  })
  it('turns off and forgets with ?debugLayers=0', () => {
    expect(resolveDebugLayers('?debugLayers=0', '1')).toEqual({
      on: false,
      persist: null,
    })
  })
  it('follows the remembered value without a query', () => {
    expect(resolveDebugLayers('', '1')).toEqual({ on: true, persist: 'keep' })
    expect(resolveDebugLayers('?x=1', null)).toEqual({
      on: false,
      persist: 'keep',
    })
  })
})

describe('createDebugLayersStore', () => {
  const memory = (
    initial: Record<string, string> = {},
  ): FlagStorage & { data: Record<string, string> } => {
    const data = { ...initial }
    return {
      data,
      getItem: (k) => data[k] ?? null,
      setItem: (k, v) => {
        data[k] = v
      },
      removeItem: (k) => {
        delete data[k]
      },
    }
  }

  it('starts off, and the in-app flip turns it on, remembered and notified', () => {
    const storage = memory()
    const store = createDebugLayersStore(storage, '')
    let calls = 0
    store.subscribe(() => {
      calls += 1
    })
    expect(store.getState()).toEqual({
      on: false,
      noBlur: false,
      outlines: true,
      topLayer: true,
    })
    store.setOn(true)
    expect(store.getState().on).toBe(true)
    expect(storage.data[DEBUG_LAYERS_STORAGE_KEY]).toBe('1')
    expect(calls).toBe(1)
  })

  it('still honours ?debugLayers=1 and the remembered value', () => {
    expect(createDebugLayersStore(memory(), '?debugLayers=1').getState().on).toBe(true)
    expect(
      createDebugLayersStore(memory({ [DEBUG_LAYERS_STORAGE_KEY]: '1' }), '').getState().on,
    ).toBe(true)
    const off = memory({ [DEBUG_LAYERS_STORAGE_KEY]: '1' })
    expect(createDebugLayersStore(off, '?debugLayers=0').getState().on).toBe(false)
    expect(off.data[DEBUG_LAYERS_STORAGE_KEY]).toBeUndefined()
  })

  it('turning the mode off also ends the no-blur experiment', () => {
    const storage = memory()
    const store = createDebugLayersStore(storage, '?debugLayers=1')
    store.setNoBlur(true)
    expect(store.getState()).toEqual({
      on: true,
      noBlur: true,
      outlines: true,
      topLayer: true,
    })
    expect(storage.data[DEBUG_NO_BLUR_STORAGE_KEY]).toBe('1')
    store.setOn(false)
    expect(store.getState()).toEqual({
      on: false,
      noBlur: false,
      outlines: true,
      topLayer: true,
    })
    expect(storage.data[DEBUG_NO_BLUR_STORAGE_KEY]).toBeUndefined()
  })

  it('works with no storage at all (private mode)', () => {
    const store = createDebugLayersStore(null, '')
    store.setOn(true)
    expect(store.getState().on).toBe(true)
  })

  it('keeps the outlines and top-layer switches, default on, until switched off', () => {
    const storage = memory()
    const store = createDebugLayersStore(storage, '?debugLayers=1')
    expect(store.getState()).toMatchObject({ outlines: true, topLayer: true })
    const before = store.getState()
    store.setOutlines(false)
    store.setTopLayer(false)
    expect(before.outlines).toBe(true)
    expect(store.getState()).toMatchObject({
      on: true,
      outlines: false,
      topLayer: false,
    })
    expect(storage.data[DEBUG_OUTLINES_STORAGE_KEY]).toBe('0')
    expect(storage.data[DEBUG_TOP_LAYER_STORAGE_KEY]).toBe('0')
    const reloaded = createDebugLayersStore(storage, '')
    expect(reloaded.getState()).toMatchObject({
      outlines: false,
      topLayer: false,
    })
    store.setOn(false)
    expect(store.getState()).toMatchObject({ outlines: true, topLayer: true })
    expect(storage.data[DEBUG_OUTLINES_STORAGE_KEY]).toBeUndefined()
  })

  it('notifies subscribers when a switch changes', () => {
    const store = createDebugLayersStore(null, '?debugLayers=1')
    let calls = 0
    const off = store.subscribe(() => {
      calls += 1
    })
    store.setTopLayer(false)
    off()
    store.setOutlines(false)
    expect(calls).toBe(1)
  })
})

describe('formatCompositing', () => {
  it('prints each property, `-` for empty and `n/a` without an element', () => {
    const lines = formatCompositing((prop) => (prop === 'opacity' ? '1' : ''))
    expect(lines).toHaveLength(6)
    expect(lines).toContain('opacity: 1')
    expect(lines).toContain('transform: -')
    expect(formatCompositing(null)[0]).toBe('transform: n/a')
  })
})
