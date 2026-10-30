/**
 * `check-no-glyph-chevrons` — a disclosure marker is `DisclosureChevron`, never
 * a text glyph; a comment may still name the glyph.
 */
import { describe, expect, it } from 'vitest'
import { findGlyphChevrons } from '../check-no-glyph-chevrons.js'

describe('glyph chevrons', () => {
  it('refuses the glyphs as shipped: a ternary literal and JSX text', () => {
    expect(findGlyphChevrons("<span>{collapsed ? '▸' : '▾'}</span>").map((f) => f.line)).toEqual([
      1,
    ])
    expect(findGlyphChevrons('const a = 1\n<span>▶ Play</span>').map((f) => f.line)).toEqual([2])
    expect(findGlyphChevrons("const open = '▼'")).toHaveLength(1)
  })

  it('allows a comment that names the glyph', () => {
    expect(findGlyphChevrons('// was a ▸ glyph\n/* ▾ */\nconst x = 1')).toEqual([])
  })

  it('allows the shared component', () => {
    expect(findGlyphChevrons('<DisclosureChevron expanded={open} />')).toEqual([])
  })
})
