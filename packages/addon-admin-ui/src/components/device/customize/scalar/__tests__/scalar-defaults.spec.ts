/**
 * A new scalar draft takes its numbers from the catalog declaration (D944).
 */
import { describe, expect, it } from 'vitest'
import { defaultScalarTransform, type ScalarTransformDraft } from '../scalar-form'
import type { ScalarFieldFit } from '../scalar-fit'

function draftOf(fit: ScalarFieldFit): ScalarTransformDraft {
  return defaultScalarTransform(fit)
}

describe('defaultScalarTransform', () => {
  it('copies a linear clamp from the declaration instead of dropping it', () => {
    const fit: ScalarFieldFit = {
      ok: true,
      valueKind: 'number',
      sourceUnit: null,
      transforms: ['linear'],
      declared: [{ kind: 'linear', defaultScale: 1, defaultOffset: 0, clampMin: 0, clampMax: 100 }],
    }
    expect(draftOf(fit)).toEqual({
      kind: 'linear',
      scale: 1,
      offset: 0,
      clampMin: 0,
      clampMax: 100,
    })
  })

  it('copies the declared comparison and dwell, not a hard-coded gte', () => {
    const fit: ScalarFieldFit = {
      ok: true,
      valueKind: 'number',
      sourceUnit: 'W',
      transforms: ['threshold'],
      declared: [
        {
          kind: 'threshold',
          comparisons: ['gte', 'lte'],
          comparison: 'lte',
          defaultThreshold: 5,
          defaultStartDwellMs: 30_000,
          defaultStopDwellMs: 180_000,
        },
      ],
    }
    expect(draftOf(fit)).toEqual({
      kind: 'threshold',
      comparison: 'lte',
      threshold: 5,
      startDwellMs: 30_000,
      stopDwellMs: 180_000,
    })
  })
})
