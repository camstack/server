/**
 * Split policy and thin-corpus warnings — pure, no provider.
 */
import { describe, expect, it } from 'vitest'
import type { RetrainDatasetStats } from '@camstack/types'
import { MIN_HOLDOUT_SUPPORT, planSplit, thinCorpusWarnings } from '../planner.js'

function stats(
  partial: Partial<RetrainDatasetStats> & Pick<RetrainDatasetStats, 'subjects'>,
): RetrainDatasetStats {
  return {
    frames: partial.frames ?? partial.subjects,
    completeFrames: partial.completeFrames ?? partial.subjects,
    completeness: partial.completeness ?? 1,
    subjects: partial.subjects,
    modelErrors: partial.modelErrors ?? 0,
    hardNegatives: partial.hardNegatives ?? 0,
    cells: partial.cells ?? [
      {
        macroClass: 'person',
        deviceId: 3839,
        lighting: 'night',
        subjects: partial.subjects,
        frames: partial.frames ?? partial.subjects,
      },
    ],
    cameras: partial.cameras ?? [
      {
        deviceId: 3839,
        frames: partial.frames ?? partial.subjects,
        completeFrames: partial.completeFrames ?? partial.subjects,
      },
    ],
  }
}

describe('thinCorpusWarnings', () => {
  it('warns when boxed subjects are below the holdout-support floor', () => {
    expect(thinCorpusWarnings(stats({ subjects: 3 }))).toEqual([
      `Only 3 boxed subjects in this version (< ${String(MIN_HOLDOUT_SUPPORT)}): floors and the comparison will be noisy — collect more annotated frames before spending GPU time.`,
    ])
  })

  it('is silent at the floor and above, and for an empty corpus', () => {
    expect(thinCorpusWarnings(stats({ subjects: MIN_HOLDOUT_SUPPORT }))).toEqual([])
    expect(thinCorpusWarnings(stats({ subjects: 100 }))).toEqual([])
    expect(thinCorpusWarnings(stats({ subjects: 0 }))).toEqual([])
  })
})

describe('planSplit', () => {
  it('carries the thin-corpus warning on the day-holdout path', () => {
    const { split, warnings } = planSplit(stats({ subjects: 3 }), null)
    expect(split.holdoutCameras).toEqual([])
    expect(split.holdoutLastDays).toBe(3)
    expect(split.trainSubjects).toBe(3)
    expect(warnings.some((w) => w.startsWith('Only 3 boxed subjects'))).toBe(true)
    expect(warnings.some((w) => w.includes('Fewer than 6 cameras'))).toBe(true)
  })
})
