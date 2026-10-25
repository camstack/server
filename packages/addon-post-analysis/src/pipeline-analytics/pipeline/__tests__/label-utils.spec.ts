/**
 * `pickTopScoredLabel` / `resolveDetectionLabelCandidate` — choose the label
 * CANDIDATE a detection offers.
 *
 * Sub-detectors (face-embedding → identity, plate-ocr → plate-text) attach
 * their result to the first-level detection's `labels: ScoredLabel[]`. We pick
 * the highest-scoring label that adds information beyond the macro class, and
 * fall back to the raw detector class (`originalClass`) when there is none.
 *
 * Since 4g this module STOPS THERE. Whether a candidate may be written, and
 * into which of the two tiers, is `resolveTieredLabelWrite`'s decision — see
 * `label-tier.spec.ts`. The macro-class refusal that used to live here is now
 * one outcome of that single rule rather than a second copy of it, which is why
 * `{ className: 'person', originalClass: 'animal' }` produces a CANDIDATE here
 * and a refusal there.
 */

import type { ScoredLabel } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { resolveTieredLabelWrite } from '../label-tier.js'
import {
  pickTopScoredLabel,
  RAW_CLASS_STEP_ID,
  resolveDetectionLabelCandidate,
} from '../label-utils.js'

const AT = 1000

describe('pickTopScoredLabel', () => {
  it('returns the highest-scoring label', () => {
    const labels: ScoredLabel[] = [
      { label: 'John', score: 0.8 },
      { label: 'Jane', score: 0.95 },
    ]
    expect(pickTopScoredLabel(labels)?.label).toBe('Jane')
  })

  it('returns the WHOLE ScoredLabel — the tier and attribution travel with it', () => {
    const labels: ScoredLabel[] = [
      { label: 'Jane', score: 0.95, tier: 2, stepId: 'face-embedding', modelId: 'arcface-r100' },
    ]
    expect(pickTopScoredLabel(labels)).toEqual(labels[0])
  })

  it('ignores labels equal to the excluded macro class', () => {
    const labels: ScoredLabel[] = [
      { label: 'person', score: 0.99 },
      { label: 'John', score: 0.7 },
    ]
    expect(pickTopScoredLabel(labels, 'person')?.label).toBe('John')
  })

  it('returns undefined for empty / all-excluded label sets', () => {
    expect(pickTopScoredLabel([])).toBeUndefined()
    expect(pickTopScoredLabel(undefined)).toBeUndefined()
    expect(pickTopScoredLabel([{ label: 'car', score: 0.9 }], 'car')).toBeUndefined()
  })

  it('skips zero/negative scores', () => {
    expect(pickTopScoredLabel([{ label: 'noise', score: 0 }])).toBeUndefined()
  })

  it('ignores opaque embedding markers even at score 1.0', () => {
    const labels: ScoredLabel[] = [
      { label: 'embedding:512d', score: 1.0 },
      { label: 'ABC123', score: 0.7 },
    ]
    expect(pickTopScoredLabel(labels)?.label).toBe('ABC123')
  })

  it('returns undefined when only an embedding marker is present', () => {
    expect(pickTopScoredLabel([{ label: 'embedding:512d', score: 1.0 }])).toBeUndefined()
  })
})

describe('resolveDetectionLabelCandidate', () => {
  it('prefers an enrichment label over originalClass, and carries its tier', () => {
    const labels: ScoredLabel[] = [{ label: 'ABC123', score: 0.9, tier: 2, stepId: 'plate-ocr' }]
    expect(
      resolveDetectionLabelCandidate({
        className: 'vehicle',
        originalClass: 'car',
        labels,
        decidedAt: AT,
      }),
    ).toEqual({ text: 'ABC123', tier: 2, score: 0.9, stepId: 'plate-ocr', decidedAt: AT })
  })

  it('falls back to originalClass with the ROOT step tier, attributed to the detector', () => {
    expect(
      resolveDetectionLabelCandidate({
        className: 'animal',
        originalClass: 'cat',
        originalClassTier: 1,
        labels: [],
        decidedAt: AT,
      }),
    ).toEqual({ text: 'cat', tier: 1, score: 0, stepId: RAW_CLASS_STEP_ID, decidedAt: AT })
  })

  it('offers the raw class with NO tier when the root step declared none', () => {
    // The write rule then refuses it. This is the correct outcome against an
    // older runner: a tier guessed here would put a MACRO class in a label slot,
    // because outside `verbosity: 'full'` the FrameProcessor substitutes
    // `det.macroClass` for a missing `originalClass`.
    const c = resolveDetectionLabelCandidate({
      className: 'animal',
      originalClass: 'cat',
      decidedAt: AT,
    })
    expect(c?.tier).toBeUndefined()
    expect(resolveTieredLabelWrite({ className: 'animal' }, c!).kind).toBe('refused')
  })

  it('offers nothing when nothing adds information', () => {
    expect(
      resolveDetectionLabelCandidate({
        className: 'person',
        originalClass: 'person',
        labels: [],
        decidedAt: AT,
      }),
    ).toBeUndefined()
    expect(resolveDetectionLabelCandidate({ className: 'person', decidedAt: AT })).toBeUndefined()
  })
})

// ── A MACRO CLASS IS NEVER A LABEL (2026-08-07), now decided ONCE ─────────
//
// The two inputs of the originalClass fallback come from DIFFERENT time bases:
// `className` is the tracker's confidence-weighted LIFETIME class vote, while
// `originalClass` is the class of the detection matched into the track THIS
// frame. Their disagreeing does not mean "the detector saw something finer" —
// it produced live rows like `className='person', label='animal'` (track
// 9c05543f on 592, and 4 more across 104/103/637 in one week).
//
// The rule now lives in ONE place and applies to all four writers, so these
// assertions run the candidate through it rather than re-checking a second copy.
describe('the candidate meets the one write rule', () => {
  function refused(className: string, originalClass: string): boolean {
    const c = resolveDetectionLabelCandidate({
      className,
      originalClass,
      originalClassTier: 1,
      decidedAt: AT,
    })
    return c !== undefined && resolveTieredLabelWrite({ className }, c).kind === 'refused'
  }

  it('never writes a macro class as a label, however the classes disagree', () => {
    expect(refused('person', 'animal')).toBe(true)
    expect(refused('animal', 'person')).toBe(true)
    expect(refused('person', 'vehicle')).toBe(true)
    expect(refused('vehicle', 'package')).toBe(true)
    expect(refused('person', 'face')).toBe(true)
    expect(refused('vehicle', 'plate')).toBe(true)
  })

  it('still writes a genuinely finer raw class', () => {
    expect(refused('animal', 'bird')).toBe(false)
    expect(refused('vehicle', 'motorcycle')).toBe(false)
  })

  it('matches macro classes exactly — a plate read or a name that looks like one survives', () => {
    // Plate OCR is upper-case and identities are capitalised; only the exact
    // lower-case macro token is suppressed, so a real read is never dropped.
    expect(refused('vehicle', 'PLATE')).toBe(false)
    expect(refused('animal', 'Person')).toBe(false)
  })

  it('an enrichment label wins over the raw class', () => {
    const c = resolveDetectionLabelCandidate({
      className: 'person',
      originalClass: 'animal',
      originalClassTier: 1,
      labels: [{ label: 'Bob', score: 0.9, tier: 2, stepId: 'face-embedding' }],
      decidedAt: AT,
    })
    expect(c?.text).toBe('Bob')
    expect(resolveTieredLabelWrite({ className: 'person' }, c!).kind).toBe('write')
  })
})
