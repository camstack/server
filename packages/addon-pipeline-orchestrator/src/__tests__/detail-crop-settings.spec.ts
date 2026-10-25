/**
 * The detail-crop convention is ONE cluster-wide value.
 *
 * It decides the rectangle every enrichment step — clip-embedding above all —
 * is fed, and `object-clip` is a single shared feature space. A per-node or
 * per-(node,device) knob would let two accelerators on the same cluster cut
 * different crops and write both into that one index, which is the exact
 * defect this setting exists to close, merely relocated. So these tests pin
 * the SCOPE as hard as they pin the values.
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_DETAIL_CROP_CONVENTION } from '@camstack/types'
import type { ConfigField, ConfigSection } from '@camstack/types'
import {
  buildGlobalSettingsSections,
  DETAIL_CROP_PADDING_KEY,
  DETAIL_CROP_SECTION_ID,
  DETAIL_CROP_SQUARE_KEY,
  readDetailCropConvention,
} from '../settings-ui-schemas.js'

function sections(): ConfigSection[] {
  return buildGlobalSettingsSections({ fpsMinThresholdDefault: 0 })
}

function detailCropSection(): ConfigSection {
  const found = sections().find((s) => s.id === DETAIL_CROP_SECTION_ID)
  expect(found).toBeDefined()
  return found!
}

/**
 * `ConfigField` is a wide union whose separator/text variants have no
 * `default`/`min`/`perNode`. Read through an index signature instead of casting
 * — the assertions are about what the schema OBJECT carries, not about which
 * union member TypeScript picked.
 */
function field(key: string): Readonly<Record<string, unknown>> {
  const found: ConfigField | undefined = detailCropSection().fields.find((f) => f.key === key)
  expect(found).toBeDefined()
  return { ...found }
}

describe('detail-crop global settings section', () => {
  it('exposes exactly the two knobs of the convention', () => {
    expect(detailCropSection().fields.map((f) => f.key)).toEqual([
      DETAIL_CROP_PADDING_KEY,
      DETAIL_CROP_SQUARE_KEY,
    ])
  })

  it('defaults reproduce the live convention, so an unconfigured cluster keeps its index valid', () => {
    expect(field(DETAIL_CROP_PADDING_KEY)['default']).toBe(
      DEFAULT_DETAIL_CROP_CONVENTION.paddingRatio,
    )
    expect(field(DETAIL_CROP_SQUARE_KEY)['default']).toBe(DEFAULT_DETAIL_CROP_CONVENTION.square)
  })

  it('is NOT per-node — a per-node crop margin would split the shared index again', () => {
    for (const f of detailCropSection().fields) {
      expect(field(f.key)['perNode'] ?? false).toBe(false)
    }
  })

  it('the padding knob spans the values worth A/B testing (0 through 0.5)', () => {
    const padding = field(DETAIL_CROP_PADDING_KEY)
    expect(padding['type']).toBe('slider')
    expect(padding['min']).toBe(0)
    expect(padding['max']).toBeGreaterThanOrEqual(0.5)
  })
})

describe('readDetailCropConvention', () => {
  it('reads both knobs out of a stored config', () => {
    expect(
      readDetailCropConvention({ [DETAIL_CROP_PADDING_KEY]: 0.5, [DETAIL_CROP_SQUARE_KEY]: true }),
    ).toEqual({ paddingRatio: 0.5, square: true })
  })

  it('an empty store is the default convention, not an invented one', () => {
    expect(readDetailCropConvention({})).toEqual(DEFAULT_DETAIL_CROP_CONVENTION)
  })

  it('a junk value falls back per-field rather than discarding the whole convention', () => {
    expect(
      readDetailCropConvention({
        [DETAIL_CROP_PADDING_KEY]: 'wide',
        [DETAIL_CROP_SQUARE_KEY]: true,
      }),
    ).toEqual({ paddingRatio: DEFAULT_DETAIL_CROP_CONVENTION.paddingRatio, square: true })
  })

  it('an out-of-range padding is rejected, not clamped into a value nobody chose', () => {
    expect(readDetailCropConvention({ [DETAIL_CROP_PADDING_KEY]: -1 })).toEqual(
      DEFAULT_DETAIL_CROP_CONVENTION,
    )
    expect(readDetailCropConvention({ [DETAIL_CROP_PADDING_KEY]: 99 })).toEqual(
      DEFAULT_DETAIL_CROP_CONVENTION,
    )
  })
})
