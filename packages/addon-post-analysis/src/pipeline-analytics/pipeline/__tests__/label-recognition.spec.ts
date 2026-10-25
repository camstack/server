/**
 * The two reads that were asking the wrong column.
 *
 *  - `hasResolvedLabel` gates the ArcFace embedding on a periodic face refresh.
 *    It used to read `label` (tier 1) while an identity lands in `subLabel`
 *    (tier 2), so it was wrong in both directions at once.
 *  - `knownTrackLabelPatch` is what stamps the track's answer onto the object
 *    events emitted AFTER the recogniser answered; without it the back-patch
 *    filled the rows behind the emitter while the emitter kept digging.
 */

import { describe, expect, it } from 'vitest'
import { hasResolvedLabel, knownTrackLabelPatch, labelKindOf } from '../label-tier.js'

describe('hasResolvedLabel — tier 2 counts', () => {
  it('is TRUE for a track ArcFace has already named (the identity is in subLabel)', () => {
    expect(hasResolvedLabel({ subLabel: 'Alice' })).toBe(true)
  })

  it('is TRUE for a tier-1 sub-class', () => {
    expect(hasResolvedLabel({ label: 'van' })).toBe(true)
  })

  it('is FALSE for a track with nothing said about it', () => {
    expect(hasResolvedLabel({})).toBe(false)
    expect(hasResolvedLabel(undefined)).toBe(false)
    expect(hasResolvedLabel(null)).toBe(false)
  })

  it('is FALSE for an empty string, which is not an answer', () => {
    expect(hasResolvedLabel({ subLabel: '' })).toBe(false)
  })
})

describe('labelKindOf — a person and a plate are different sentences', () => {
  it('names the face family, machine and operator alike', () => {
    expect(labelKindOf({ stepId: 'face-recognizer', decidedAt: 0 })).toBe('identity')
    expect(labelKindOf({ stepId: 'operator:face-gallery', decidedAt: 0 })).toBe('identity')
  })

  it('names the plate family, machine and operator alike', () => {
    // The step the writer actually stamps. `applyTrackLabelCandidate` is given
    // `detail.stepId`, and a plate label rides the detail-subtree ROOT
    // (`plate-detection`), not its OCR leaf — measured on the live hub
    // 2026-08-20: every one of the 8 plate attributions in seven days reads
    // `{ stepId: 'plate-detection', modelId: 'vgg-english-g2' }`, and NOT ONE
    // reads `plate-ocr`. Listing only the leaf made `labelKindOf` answer
    // `undefined` for every real plate, so every plate took the generic
    // labelled sentence instead of the plate one.
    expect(labelKindOf({ stepId: 'plate-detection', decidedAt: 0 })).toBe('plate')
    expect(labelKindOf({ stepId: 'plate-ocr', decidedAt: 0 })).toBe('plate')
    expect(labelKindOf({ stepId: 'operator:plate-gallery', decidedAt: 0 })).toBe('plate')
  })

  it('answers NOTHING for a classifier, a migration, or an absent attribution', () => {
    expect(labelKindOf({ stepId: 'animal-classifier', decidedAt: 0 })).toBeUndefined()
    expect(labelKindOf({ stepId: 'migration:4g', decidedAt: 0 })).toBeUndefined()
    expect(labelKindOf(undefined)).toBeUndefined()
  })
})

describe('knownTrackLabelPatch — later rows carry what the track knows', () => {
  it('projects the tier the track holds, id and all', () => {
    expect(
      knownTrackLabelPatch({
        className: 'person',
        subLabel: 'Alice',
        subLabelScore: 0.9,
        subLabelMeta: { stepId: 'face-recognizer', decidedAt: 1, identityId: 'id-alice' },
      }),
    ).toEqual({
      subLabel: 'Alice',
      subLabelScore: 0.9,
      subLabelMeta: { stepId: 'face-recognizer', decidedAt: 1, identityId: 'id-alice' },
    })
  })

  // NEUTRALISATION: a track that says nothing must produce NO patch rather than
  // a patch of blanks — a blank patch spread onto an event row would erase a
  // label the frame path had just decided.
  it('answers undefined for a track that says nothing yet', () => {
    expect(knownTrackLabelPatch({ className: 'person' })).toBeUndefined()
    expect(knownTrackLabelPatch(undefined)).toBeUndefined()
  })
})
