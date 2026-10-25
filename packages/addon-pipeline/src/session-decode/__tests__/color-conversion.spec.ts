import { describe, it, expect } from 'vitest'
import {
  colorConvertFilterOptions,
  colorProvenanceLine,
  DEFAULT_COLOR_MATRIX,
  DEFAULT_COLOR_RANGE,
  OUTPUT_RGB_RANGE,
  resolveColorMatrix,
  resolveColorRange,
  resolveSourceColor,
  sourceColorKey,
  swsRangeFlag,
} from '../color-conversion.js'

// FFmpeg AVColorSpace / AVColorRange ABI integers (mirrors the module's private map).
const SPC_RGB = 0
const SPC_BT709 = 1
const SPC_UNSPECIFIED = 2
const SPC_BT470BG = 5
const SPC_SMPTE170M = 6
const SPC_BT2020_NCL = 9
const RANGE_UNSPECIFIED = 0
const RANGE_MPEG = 1
const RANGE_JPEG = 2

describe('color-conversion — matrix resolution', () => {
  it('maps known colorspaces to sws matrix tokens', () => {
    expect(resolveColorMatrix(SPC_BT709)).toBe('bt709')
    expect(resolveColorMatrix(SPC_BT470BG)).toBe('bt601')
    expect(resolveColorMatrix(SPC_SMPTE170M)).toBe('bt601')
    expect(resolveColorMatrix(SPC_BT2020_NCL)).toBe('bt2020nc')
  })

  it('defaults unspecified / RGB / exotic colorspaces to bt709', () => {
    expect(resolveColorMatrix(SPC_UNSPECIFIED)).toBe(DEFAULT_COLOR_MATRIX)
    expect(resolveColorMatrix(SPC_RGB)).toBe(DEFAULT_COLOR_MATRIX)
    expect(resolveColorMatrix(999)).toBe(DEFAULT_COLOR_MATRIX)
    expect(DEFAULT_COLOR_MATRIX).toBe('bt709')
  })
})

describe('color-conversion — range resolution', () => {
  it('maps mpeg→limited and jpeg→full', () => {
    expect(resolveColorRange(RANGE_MPEG)).toBe('limited')
    expect(resolveColorRange(RANGE_JPEG)).toBe('full')
  })

  it('defaults unspecified range to limited (the fallback-GOP fix)', () => {
    expect(resolveColorRange(RANGE_UNSPECIFIED)).toBe(DEFAULT_COLOR_RANGE)
    expect(DEFAULT_COLOR_RANGE).toBe('limited')
  })

  it('swsRangeFlag: limited→0, full→1', () => {
    expect(swsRangeFlag('limited')).toBe(0)
    expect(swsRangeFlag('full')).toBe(1)
  })
})

describe('color-conversion — the RC-5 invariant: all paths resolve identically', () => {
  it('a normal-tagged GOP and an UNSPECIFIED fallback GOP resolve to the SAME conversion', () => {
    // The bug: a fallback/replay GOP carries UNSPECIFIED range (0) while its
    // neighbours carry limited (1). Before the fix, the auto-converter guessed
    // them differently → one desaturated GOP. After the fix, both resolve to the
    // identical explicit (matrix, range), so the conversion is byte-consistent.
    const normal = resolveSourceColor(SPC_BT709, RANGE_MPEG)
    const fallback = resolveSourceColor(SPC_UNSPECIFIED, RANGE_UNSPECIFIED)
    expect(colorConvertFilterOptions(normal)).toBe(colorConvertFilterOptions(fallback))
    expect(sourceColorKey(normal)).toBe(sourceColorKey(fallback))
  })

  it('every conversion site outputs FULL-range RGB', () => {
    const opts = colorConvertFilterOptions(resolveSourceColor(SPC_BT709, RANGE_MPEG))
    expect(opts).toContain(`out_range=${OUTPUT_RGB_RANGE}`)
    expect(OUTPUT_RGB_RANGE).toBe('full')
  })

  it('produces the exact filter fragment', () => {
    expect(colorConvertFilterOptions(resolveSourceColor(SPC_BT709, RANGE_MPEG))).toBe(
      'in_color_matrix=bt709:in_range=limited:out_range=full',
    )
    expect(colorConvertFilterOptions(resolveSourceColor(SPC_BT470BG, RANGE_JPEG))).toBe(
      'in_color_matrix=bt601:in_range=full:out_range=full',
    )
  })
})

describe('color-conversion — resolved metadata + provenance', () => {
  it('flags defaulted tags for provenance', () => {
    const r = resolveSourceColor(SPC_UNSPECIFIED, RANGE_UNSPECIFIED)
    expect(r.colorSpaceDefaulted).toBe(true)
    expect(r.colorRangeDefaulted).toBe(true)
    expect(r.rawColorSpace).toBe(SPC_UNSPECIFIED)
    expect(r.rawColorRange).toBe(RANGE_UNSPECIFIED)

    const known = resolveSourceColor(SPC_BT709, RANGE_MPEG)
    expect(known.colorSpaceDefaulted).toBe(false)
    expect(known.colorRangeDefaulted).toBe(false)
  })

  it('transition marker names the path, raw+resolved color, and default substitution', () => {
    const line = colorProvenanceLine('hw-fullframe', resolveSourceColor(SPC_UNSPECIFIED, 0), true)
    expect(line).toContain('TRANSITION')
    expect(line).toContain('path:hw-fullframe')
    expect(line).toContain('2->bt709(default)')
    expect(line).toContain('0->limited(default)')
    expect(line).toContain('out:rgb-full')
    expect(line.endsWith('\n')).toBe(true)
  })

  it('non-transition marker omits the TRANSITION tag and default suffix for known tags', () => {
    const line = colorProvenanceLine('sw-crop', resolveSourceColor(SPC_BT709, RANGE_MPEG), false)
    expect(line).not.toContain('TRANSITION')
    expect(line).toContain('1->bt709')
    expect(line).not.toContain('(default)')
  })
})
