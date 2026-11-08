/**
 * A new scalar draft takes its numbers from the catalog declaration (D944).
 */
import { DeviceType } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  defaultScalarTransform,
  dwellLabel,
  type ScalarTransformDraft,
  withTypeSamples,
} from '../scalar-form'
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
  it('a media player starts from its own dwell and sample defaults', () => {
    const fit: ScalarFieldFit = {
      ok: true,
      valueKind: 'number',
      sourceUnit: 'W',
      transforms: ['threshold'],
      declared: [
        {
          kind: 'threshold',
          comparisons: ['gte', 'lte'],
          comparison: 'gte',
          defaultThreshold: 5,
          defaultStartDwellMs: 30_000,
          defaultStopDwellMs: 180_000,
          deviceTypeDefaults: {
            [DeviceType.MediaPlayer]: {
              startDwellMs: 10_000,
              stopDwellMs: 10_000,
              minSamples: 1,
            },
          },
        },
      ],
    }
    expect(defaultScalarTransform(fit, DeviceType.MediaPlayer)).toEqual({
      kind: 'threshold',
      comparison: 'gte',
      threshold: 5,
      startDwellMs: 10_000,
      stopDwellMs: 10_000,
      minSamples: 1,
    })
    expect(defaultScalarTransform(fit, DeviceType.Washer)).toEqual({
      kind: 'threshold',
      comparison: 'gte',
      threshold: 5,
      startDwellMs: 30_000,
      stopDwellMs: 180_000,
    })
  })

  it('an applied history proposal takes the samples of a type with its own defaults', () => {
    const proposed: ScalarTransformDraft = {
      kind: 'threshold',
      comparison: 'gte',
      threshold: 8,
      startDwellMs: 20_000,
      stopDwellMs: 60_000,
    }
    expect(withTypeSamples(proposed, DeviceType.MediaPlayer)).toEqual({
      ...proposed,
      minSamples: 1,
    })
    expect(withTypeSamples(proposed, DeviceType.Washer)).toEqual(proposed)
    expect(withTypeSamples(proposed, undefined)).toEqual(proposed)
  })

  it('names a dwell in seconds under a minute and in minutes from there', () => {
    expect(dwellLabel(10_000)).toEqual({ unit: 'seconds', n: 10 })
    expect(dwellLabel(180_000)).toEqual({ unit: 'minutes', n: 3 })
  })
})
