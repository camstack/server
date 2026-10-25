/**
 * The tiered-label write rule (roadmap 4g).
 *
 * Each block names the live defect it prevents. The two that matter most:
 * `9c05543f` (592), a `person` track whose label REGRESSED to `animal`, and
 * `7d1dc71e` (636), which held `Turdus migratorius` with no way to also say
 * `bird`.
 */

import { describe, expect, it } from 'vitest'
import {
  displayLabel,
  type LabelCandidate,
  MIGRATION_STEP_ID,
  resolveTieredLabelWrite,
  type TieredLabelState,
} from '../label-tier.js'

function candidate(over: Partial<LabelCandidate> = {}): LabelCandidate {
  return { text: 'Alice', tier: 2, score: 0.8, stepId: 'face-recognizer', decidedAt: 100, ...over }
}

describe('resolveTieredLabelWrite — the tier is DECLARED, never inferred', () => {
  it('refuses a candidate whose step declared no tier', () => {
    const d = resolveTieredLabelWrite(
      { className: 'animal' },
      candidate({ text: 'Turdus migratorius', tier: undefined, stepId: 'bird-classifier' }),
    )
    expect(d.kind).toBe('refused')
    expect(d.kind === 'refused' && d.reason.kind).toBe('undeclared-tier')
  })

  it('does not fall back to a tier derived from the step id or the text', () => {
    // `bird-classifier` is a tier-2 step in the registry and `Turdus
    // migratorius` looks like a species. Neither may rescue an undeclared
    // candidate: the shape of a name cannot tell `Bird` the surname from
    // `bird` the sub-class.
    for (const stepId of ['bird-classifier', 'plate-ocr', 'animal-classifier']) {
      const d = resolveTieredLabelWrite(
        { className: 'animal' },
        candidate({ tier: undefined, stepId }),
      )
      expect(d.kind, stepId).toBe('refused')
    }
  })
})

describe('resolveTieredLabelWrite — a higher tier is never overwritten by a lower one', () => {
  const speciesOnTrack: TieredLabelState = {
    className: 'animal',
    subLabel: 'Turdus migratorius',
    subLabelScore: 0.9,
    subLabelMeta: { stepId: 'bird-classifier', decidedAt: 1 },
  }

  it('a tier-1 sub-class lands beside the species, not on top of it', () => {
    const d = resolveTieredLabelWrite(
      speciesOnTrack,
      candidate({ text: 'bird', tier: 1, score: 0.99, stepId: 'animal-classifier' }),
    )
    expect(d.kind).toBe('write')
    if (d.kind !== 'write') return
    expect(d.tier).toBe(1)
    expect(d.patch.label).toBe('bird')
    // The whole point: even at a HIGHER score, the tier-1 patch names no
    // tier-2 column, so it cannot clear the species.
    expect(d.patch.subLabel).toBeUndefined()
    expect(d.patch.subLabelScore).toBeUndefined()
    expect(d.patch.subLabelMeta).toBeUndefined()
  })

  it('both tiers coexist on the row — the 636 defect', () => {
    const merged = { ...speciesOnTrack, label: 'bird', labelScore: 0.99 }
    expect(merged.label).toBe('bird')
    expect(merged.subLabel).toBe('Turdus migratorius')
    expect(displayLabel(merged)).toBe('Turdus migratorius')
  })
})

describe('resolveTieredLabelWrite — within a tier, the higher score wins', () => {
  const incumbent: TieredLabelState = {
    className: 'person',
    subLabel: 'Alice',
    subLabelScore: 0.8,
    subLabelMeta: { stepId: 'face-recognizer', decidedAt: 1 },
  }

  it('a strictly higher score replaces', () => {
    const d = resolveTieredLabelWrite(incumbent, candidate({ text: 'Bob', score: 0.81 }))
    expect(d.kind).toBe('write')
    expect(d.kind === 'write' && d.patch.subLabel).toBe('Bob')
  })

  it('an equal score does not — a step re-offering the same answer writes once', () => {
    const d = resolveTieredLabelWrite(incumbent, candidate({ text: 'Bob', score: 0.8 }))
    expect(d.kind).toBe('refused')
    expect(d.kind === 'refused' && d.reason.kind).toBe('lower-score')
  })

  it('a lower score does not', () => {
    const d = resolveTieredLabelWrite(incumbent, candidate({ text: 'Bob', score: 0.5 }))
    expect(d.kind).toBe('refused')
  })

  it('an OPERATOR assignment takes the tier regardless of score', () => {
    // arcface routinely answers at 1.0; without authority a hand correction
    // would silently do nothing.
    const machineAtOne: TieredLabelState = { ...incumbent, subLabelScore: 1 }
    const d = resolveTieredLabelWrite(
      machineAtOne,
      candidate({
        text: 'Bob',
        score: 1,
        stepId: 'operator:face-gallery',
        operatorAuthority: true,
      }),
    )
    expect(d.kind).toBe('write')
    expect(d.kind === 'write' && d.patch.subLabel).toBe('Bob')
  })

  it('a MIGRATED incumbent loses to any declared write of its tier', () => {
    const migrated: TieredLabelState = {
      className: 'animal',
      subLabel: 'dog',
      subLabelMeta: { stepId: MIGRATION_STEP_ID, decidedAt: 1 },
    }
    const d = resolveTieredLabelWrite(
      migrated,
      candidate({ text: 'Canis lupus', score: 0.1, stepId: 'bird-classifier' }),
    )
    expect(d.kind).toBe('write')
  })
})

describe('resolveTieredLabelWrite — a macro class is never a label', () => {
  it('refuses the 592 collapse and names the token', () => {
    const d = resolveTieredLabelWrite(
      { className: 'person' },
      candidate({ text: 'animal', tier: 1, stepId: 'detector:raw-class' }),
    )
    expect(d.kind).toBe('refused')
    if (d.kind !== 'refused' || d.reason.kind !== 'macro-class') throw new Error('wrong refusal')
    expect(d.reason.text).toBe('animal')
    expect(d.reason.className).toBe('person')
  })

  it('refuses a candidate identical to the row class', () => {
    const d = resolveTieredLabelWrite({ className: 'Alice' }, candidate({ text: 'Alice', tier: 2 }))
    expect(d.kind).toBe('refused')
    expect(d.kind === 'refused' && d.reason.kind).toBe('equals-class')
  })

  it('refuses the opaque embedding marker', () => {
    const d = resolveTieredLabelWrite(
      { className: 'person' },
      candidate({ text: 'embedding:512d', tier: 2, score: 1 }),
    )
    expect(d.kind).toBe('refused')
    expect(d.kind === 'refused' && d.reason.kind).toBe('internal-marker')
  })

  it('keeps a capitalised NAME that collides with a taxonomy token', () => {
    // Exact match, no case folding: `Person` is a real surname, `person` is
    // the class.
    const d = resolveTieredLabelWrite({ className: 'person' }, candidate({ text: 'Person' }))
    expect(d.kind).toBe('write')
  })
})

describe('displayLabel', () => {
  it('is the finest thing known', () => {
    expect(displayLabel({ label: 'bird', subLabel: 'Turdus migratorius' })).toBe(
      'Turdus migratorius',
    )
    expect(displayLabel({ label: 'bird' })).toBe('bird')
    expect(displayLabel({})).toBeUndefined()
  })
})
