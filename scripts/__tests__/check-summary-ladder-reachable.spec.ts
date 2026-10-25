import { describe, expect, it } from 'vitest'
import {
  committedSummaryLadderShape,
  findSummaryLadderFailures,
  type SummaryLadderShape,
} from '../check-summary-ladder-reachable.js'

const SUBJECT_CROP: ReadonlySet<string> = new Set(['thumbnail', 'thumbnailSmall'])

function shape(ladder: readonly string[]): SummaryLadderShape {
  return { ladder, subjectCropRungs: SUBJECT_CROP }
}

/** What 160200681's ladder reduces to once its two group-only head rungs are
 *  gone — which is what the 2026-09-01 group deletion made permanent. */
const LADDER_160200681_AFTER_GROUPS = ['keyFrame', 'keyFrameSmall', 'fullFrame'] as const

describe('findSummaryLadderFailures', () => {
  it('REFUSES a ladder headed by a whole frame', () => {
    // The regression itself: the head rung is a whole scene, so every digest
    // tile is a whole scene. Three days of digests looked exactly like this.
    const failures = findSummaryLadderFailures(shape(LADDER_160200681_AFTER_GROUPS))
    expect(failures).toHaveLength(1)
    expect(failures[0]?.what).toContain("'keyFrame'")
    expect(failures[0]?.why).toContain('thumbnail')
  })

  it('accepts a ladder whose head is a track subject crop', () => {
    expect(
      findSummaryLadderFailures(shape(['thumbnail', 'thumbnailSmall', 'keyFrame', 'fullFrame'])),
    ).toEqual([])
  })

  it('refuses an empty ladder', () => {
    expect(findSummaryLadderFailures(shape([]))).toHaveLength(1)
  })

  it('refuses a duplicated rung', () => {
    const failures = findSummaryLadderFailures(shape(['thumbnail', 'thumbnail', 'keyFrame']))
    expect(failures.some((f) => f.what.includes('appears twice'))).toBe(true)
  })
})

describe('the committed ladder', () => {
  it('passes its own guard', () => {
    // Reads the REAL SUMMARY_MEDIA_LADDER. If someone drops the crop rungs
    // again, this fails here as well as in CI.
    expect(findSummaryLadderFailures(committedSummaryLadderShape())).toEqual([])
  })

  it('offers a subject crop as the best rung a digest can reach', () => {
    expect(committedSummaryLadderShape().ladder[0]).toBe('thumbnail')
  })
})
