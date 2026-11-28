// @vitest-environment jsdom
/**
 * The web glyph table covers the WHOLE icon catalog (D854).
 *
 * `@dominevo/types` owns the keys; this table owns the drawing. A key with no
 * glyph is offered by the picker and draws nothing, so the coverage is pinned
 * here — against the REAL `lucide-react`, not a fake.
 */
import { ICON_KEYS, canonicalIconKey } from '@dominevo/types'
import { describe, expect, it, vi } from 'vitest'
import { FAST_ICON_GLYPHS } from '../device-meta'
import { loadIconGlyphs, lucideExportName, resolveDisplayIcon } from '../icon-glyphs'

describe('the fast table (first paint)', () => {
  it('is a cache of catalog glyphs, never a second vocabulary', () => {
    for (const key of Object.keys(FAST_ICON_GLYPHS)) {
      expect(canonicalIconKey(key), `${key} is not a catalog key`).toBe(key)
    }
  })

  it('is small: the long tail is loaded lazily, not imported statically', () => {
    expect(Object.keys(FAST_ICON_GLYPHS).length).toBeLessThan(100)
    expect(Object.keys(FAST_ICON_GLYPHS).length).toBeLessThan(ICON_KEYS.length / 10)
  })

  it('answers synchronously, before anything has been loaded', () => {
    expect(resolveDisplayIcon('camera')).toBe(FAST_ICON_GLYPHS.camera)
    expect(resolveDisplayIcon('camera')).toBeDefined()
  })
})

describe('the lazy table', () => {
  // The loader is exercised against a two-glyph stand-in for the 1,700-module lucide table, so
  // "undefined before load, drawn after" does not depend on how fast a loaded box transforms
  // the real one. The REAL table is pinned by the "EVERY catalog key" test below.
  it('returns undefined for a key outside the fast table until loaded, then draws it', async () => {
    const telescope = () => null
    vi.resetModules()
    vi.doMock('lucide-react/dist/esm/icons/index.js', () => ({ Telescope: telescope }))
    try {
      const fresh = await import('../icon-glyphs')
      const { FAST_ICON_GLYPHS: fast } = await import('../device-meta')
      // `telescope` is in no meta table, so it is not in the fast table.
      expect(fast.telescope).toBeUndefined()
      expect(fresh.iconGlyphsLoaded()).toBe(false)
      expect(fresh.resolveDisplayIcon('telescope')).toBeUndefined()
      await fresh.loadIconGlyphs()
      expect(fresh.iconGlyphsLoaded()).toBe(true)
      expect(fresh.iconGlyphsFailed()).toBe(false)
      expect(fresh.resolveDisplayIcon('telescope')).toBe(telescope)
    } finally {
      vi.doUnmock('lucide-react/dist/esm/icons/index.js')
      vi.resetModules()
    }
  })

  it('EVERY catalog key resolves to a glyph', { timeout: 60_000 }, async () => {
    await loadIconGlyphs()
    const missing = ICON_KEYS.filter((key) => resolveDisplayIcon(key) === undefined)
    expect(missing).toEqual([])
  })

  it('a still-accepted spelling resolves to the same glyph as its key', async () => {
    await loadIconGlyphs()
    expect(resolveDisplayIcon('home')).toBe(resolveDisplayIcon('house'))
    expect(resolveDisplayIcon('gauge2')).toBe(resolveDisplayIcon('gauge'))
  })

  it('an unknown key is undefined — the override is not free text', async () => {
    await loadIconGlyphs()
    expect(resolveDisplayIcon('not-a-glyph')).toBeUndefined()
    expect(resolveDisplayIcon('constructor')).toBeUndefined()
    expect(resolveDisplayIcon('')).toBeUndefined()
  })

  it('derives the lucide export name the way lucide does', () => {
    expect(lucideExportName('house')).toBe('House')
    expect(lucideExportName('arrow-down-0-1')).toBe('ArrowDown01')
    expect(lucideExportName('gamepad-2')).toBe('Gamepad2')
  })
})
