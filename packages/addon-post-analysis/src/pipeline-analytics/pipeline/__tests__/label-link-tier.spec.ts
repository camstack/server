/**
 * D715 — the detector's linked label in the ONE tier-1 write rule. The writer
 * is decided upstream (`resolveLabelLink`); here the two standings it can
 * arrive with must behave: an authoritative linked label (the detection's
 * score) is a scored answer, a fallback one (score 0) is outranked by any
 * scored answer of the classifier and still lands when nothing else answers.
 */
import type { ScoredLabel } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { resolveTieredLabelWrite } from '../label-tier.js'
import { RAW_CLASS_STEP_ID, resolveDetectionLabelCandidate } from '../label-utils.js'

const AT = 1000
const LINK = 'detector-link:animal-classifier'

function linked(score: number): ScoredLabel {
  return { label: 'deer', score, tier: 1, stepId: LINK, modelId: 'frigate-plus' }
}

describe('resolveDetectionLabelCandidate — linked label', () => {
  it('an authoritative linked label is offered at the detection score', () => {
    expect(
      resolveDetectionLabelCandidate({
        className: 'animal',
        labels: [linked(0.83)],
        decidedAt: AT,
      }),
    ).toEqual({
      text: 'deer',
      tier: 1,
      score: 0.83,
      stepId: LINK,
      modelId: 'frigate-plus',
      decidedAt: AT,
    })
  })

  it('a fallback linked label is offered at score 0 — at EVERY verbosity, ahead of the raw class', () => {
    expect(
      resolveDetectionLabelCandidate({
        className: 'animal',
        originalClass: 'deer',
        originalClassTier: 1,
        labels: [linked(0)],
        decidedAt: AT,
      }),
    ).toMatchObject({ text: 'deer', score: 0, stepId: LINK })
  })

  it('a scored classifier answer on the same detection wins over a fallback link', () => {
    const classifier: ScoredLabel = {
      label: 'dog',
      score: 0.6,
      tier: 1,
      stepId: 'animal-classifier',
    }
    expect(
      resolveDetectionLabelCandidate({
        className: 'animal',
        labels: [linked(0), classifier],
        decidedAt: AT,
      })?.stepId,
    ).toBe('animal-classifier')
  })

  it('without a linked label the raw class is still the last resort', () => {
    expect(
      resolveDetectionLabelCandidate({
        className: 'animal',
        originalClass: 'deer',
        originalClassTier: 1,
        labels: [],
        decidedAt: AT,
      })?.stepId,
    ).toBe(RAW_CLASS_STEP_ID)
  })
})

describe('label-tier precedence — fallback vs authoritative', () => {
  it('a classifier answer replaces a score-0 linked incumbent', () => {
    const d = resolveTieredLabelWrite(
      { className: 'animal', label: 'deer', labelScore: 0 },
      { text: 'dog', tier: 1, score: 0.6, stepId: 'animal-classifier', decidedAt: AT },
    )
    expect(d.kind).toBe('write')
  })

  it('an authoritative linked incumbent is not displaced by a weaker answer', () => {
    const d = resolveTieredLabelWrite(
      { className: 'animal', label: 'deer', labelScore: 0.83 },
      { text: 'dog', tier: 1, score: 0.6, stepId: 'animal-classifier', decidedAt: AT },
    )
    expect(d.kind === 'refused' && d.reason.kind).toBe('lower-score')
  })
})
