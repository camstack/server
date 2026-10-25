/**
 * IDENTITIES ARE MATCHED BY GALLERY ID.
 *
 * A display name is renameable, and a rule authored on "Alice" went silently
 * dark the moment the operator fixed the spelling in the face gallery — the
 * rule still existed, still looked right in the editor, and matched nobody.
 * The id does not move, so the id is what the engine tests; the name survives
 * as a compatibility leg for rules whose migration could not resolve and for
 * records written before ids reached `LabelAttribution`.
 *
 * The empty list is a THIRD state and not an accident: "only known faces",
 * nobody in particular.
 */

import type { NcRuleInput, ObjectEvent } from '@camstack/types'
import { NcRuleInputSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, subjectFromObjectEvent } from '../rule-engine.js'

const ALICE = { stepId: 'face-recognizer', decidedAt: 1, identityId: 'id-alice' } as const

function rule(conditions: Record<string, unknown>): NcRuleInput {
  return NcRuleInputSchema.parse({
    name: 'r',
    delivery: 'immediate',
    targets: [{ targetId: 't' }],
    conditions,
  })
}

function event(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    id: 100_001,
    kind: 'object',
    deviceId: 104,
    timestamp: 1,
    trackId: 'trk-1',
    className: 'person',
    confidence: 0.9,
    zones: [],
    ...overrides,
  }
}

describe('identities — matched on the gallery id', () => {
  it('matches a subject whose identityId is listed, whatever the name says now', () => {
    // The operator renamed Alice to "Alice R." after authoring the rule. The
    // WORD on the record no longer matches anything the rule wrote down.
    const subject = subjectFromObjectEvent(event({ subLabel: 'Alice R.', subLabelMeta: ALICE }))
    expect(evaluateRule(rule({ identities: ['id-alice'] }), subject).matched).toBe(true)
  })

  // NEUTRALISATION: the id is really what is being tested. A different id on
  // the same record fails, so the pass above cannot be coming from the name.
  it('does NOT match a subject carrying a different identityId', () => {
    const subject = subjectFromObjectEvent(
      event({ subLabel: 'Alice R.', subLabelMeta: { ...ALICE, identityId: 'id-bob' } }),
    )
    const verdict = evaluateRule(rule({ identities: ['id-alice'] }), subject)
    expect(verdict.matched).toBe(false)
    expect(verdict.failedCondition).toBe('identities')
  })

  // The compatibility leg. A record written before ids existed carries a NAME
  // and nothing else; a rule whose migration could not resolve carries a name
  // too. Dropping either leg silences one of them.
  it('still matches on the display name (unmigrated rule / pre-id record)', () => {
    const subject = subjectFromObjectEvent(
      event({ subLabel: 'Alice', subLabelMeta: { stepId: 'face-recognizer', decidedAt: 1 } }),
    )
    expect(evaluateRule(rule({ identities: ['Alice'] }), subject).matched).toBe(true)
  })

  it('EMPTY list = only known faces: a recognised subject passes', () => {
    const subject = subjectFromObjectEvent(event({ subLabel: 'Alice', subLabelMeta: ALICE }))
    expect(evaluateRule(rule({ identities: [] }), subject).matched).toBe(true)
  })

  it('EMPTY list: an UNRECOGNISED person fails', () => {
    const subject = subjectFromObjectEvent(event())
    expect(evaluateRule(rule({ identities: [] }), subject).failedCondition).toBe('identities')
  })

  // A plate is not a face. The empty identity list must not be satisfied by a
  // vehicle whose plate happens to be labelled — that is what reading the WORD
  // instead of its provenance would do.
  it('EMPTY list: a plate-labelled subject fails', () => {
    const subject = subjectFromObjectEvent(
      event({
        className: 'vehicle',
        subLabel: 'AB123CD',
        subLabelMeta: { stepId: 'plate-ocr', decidedAt: 1 },
      }),
    )
    expect(evaluateRule(rule({ identities: [] }), subject).failedCondition).toBe('identities')
  })

  it('ABSENT condition: an unrecognised person still matches', () => {
    const subject = subjectFromObjectEvent(event())
    expect(evaluateRule(rule({ classes: ['person'] }), subject).matched).toBe(true)
  })

  it('identitiesExclude vetoes by id, and lets an unrecognised subject through', () => {
    const alice = subjectFromObjectEvent(event({ subLabel: 'Alice', subLabelMeta: ALICE }))
    expect(evaluateRule(rule({ identitiesExclude: ['id-alice'] }), alice).failedCondition).toBe(
      'identitiesExclude',
    )
    const stranger = subjectFromObjectEvent(event())
    expect(evaluateRule(rule({ identitiesExclude: ['id-alice'] }), stranger).matched).toBe(true)
  })
})

describe('plates — the same three states', () => {
  it('EMPTY values = any plate the pipeline could read', () => {
    const subject = subjectFromObjectEvent(
      event({
        className: 'vehicle',
        subLabel: 'AB123CD',
        subLabelMeta: { stepId: 'plate-ocr', decidedAt: 1 },
      }),
    )
    expect(evaluateRule(rule({ plates: { values: [], maxDistance: 1 } }), subject).matched).toBe(
      true,
    )
  })

  it('EMPTY values: a vehicle with no plate read fails', () => {
    const subject = subjectFromObjectEvent(event({ className: 'vehicle' }))
    expect(
      evaluateRule(rule({ plates: { values: [], maxDistance: 1 } }), subject).failedCondition,
    ).toBe('plates')
  })

  // NEUTRALISATION for the widened schema: a NAMED plate list must still behave
  // exactly as it did, fuzzily, on a record with no attribution at all.
  it('a named list keeps its Levenshtein behaviour on an unattributed label', () => {
    const subject = subjectFromObjectEvent(event({ className: 'vehicle', label: 'AB123CO' }))
    expect(
      evaluateRule(rule({ plates: { values: ['AB123CD'], maxDistance: 1 } }), subject).matched,
    ).toBe(true)
    expect(
      evaluateRule(rule({ plates: { values: ['ZZ999ZZ'], maxDistance: 1 } }), subject)
        .failedCondition,
    ).toBe('plates')
  })
})
