// @vitest-environment jsdom
/**
 * The web glyph table covers the WHOLE icon catalog (D854).
 *
 * `@camstack/types` owns the keys; this table owns the drawing. A key with no
 * glyph is offered by the picker and draws nothing, so the coverage is pinned
 * here — against the REAL `lucide-react`, not a fake.
 */
import { ICON_KEYS, canonicalIconKey } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { FAST_ICON_GLYPHS } from '../device-meta'
import {
  iconGlyphsFailed,
  iconGlyphsLoaded,
  loadIconGlyphs,
  lucideExportName,
  resolveDisplayIcon,
} from '../icon-glyphs'

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
  // The first load imports ~1,700 icon modules: far slower than the default 5 s under a loaded CI box.
  it('returns undefined for a key outside the fast table until loaded, then draws it', {
    timeout: 60_000,
  }, async () => {
    // `telescope` is in no meta table, so it is not in the fast table.
    expect(FAST_ICON_GLYPHS.telescope).toBeUndefined()
    if (!iconGlyphsLoaded()) expect(resolveDisplayIcon('telescope')).toBeUndefined()
    await loadIconGlyphs()
    expect(iconGlyphsLoaded()).toBe(true)
    expect(iconGlyphsFailed()).toBe(false)
    expect(resolveDisplayIcon('telescope')).toBeDefined()
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
