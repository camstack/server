/**
 * D692 §3.2: a grouped rule admits a CANDIDATE — a subject that passes every condition
 * except the recognition-dependent ones. `evaluateRule(..., { relax })` answers PENDING
 * for exactly those conditions and nothing else; the gauntlet and its order are unchanged.
 */
import { NC_CONDITION_CATALOG, NcRuleInputSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  NC_RECOGNITION_CONDITIONS,
  type NcRuleSubject,
  evaluateRule,
  ruleHasRecognitionScope,
} from '../rule-engine.js'

const RELAX = { relax: NC_RECOGNITION_CONDITIONS }
const person: NcRuleSubject = {
  kind: 'object-event',
  recordId: 'ev-1',
  deviceId: 101,
  timestamp: 1_000,
  classNames: ['person'],
  zones: ['door'],
  trackId: 'trk-1',
}
const rule = (conditions: Record<string, unknown>) =>
  NcRuleInputSchema.parse({
    name: 'r',
    delivery: 'immediate',
    targets: [{ targetId: 't' }],
    conditions,
  })

describe('NC_RECOGNITION_CONDITIONS is the catalog label group, both ways (D692 §11)', () => {
  it('every label-group condition is classified, and nothing else is', () => {
    const labelGroup = NC_CONDITION_CATALOG.filter((d) => d.group === 'label').map((d) => d.id)
    expect([...NC_RECOGNITION_CONDITIONS].sort()).toEqual([...labelGroup].sort())
  })
})

describe('evaluateRule relax', () => {
  it('an unrecognised person is a CANDIDATE of an identity rule, never a match', () => {
    const r = rule({ classes: ['person'], identities: ['id-a'] })
    expect(evaluateRule(r, person).matched).toBe(false)
    const relaxed = evaluateRule(r, person, undefined, undefined, undefined, RELAX)
    expect(relaxed).toMatchObject({
      matched: false,
      failedCondition: 'identities',
      pendingOn: ['identities'],
    })
  })
  it('relax never rescues a NON-recognition failure', () => {
    const r = rule({ classes: ['car'], identities: ['id-a'] })
    const relaxed = evaluateRule(r, person, undefined, undefined, undefined, RELAX)
    expect(relaxed.failedCondition).toBe('classes')
    expect(relaxed.pendingOn).toBeUndefined()
  })
  it('a recognised in-scope subject is a plain match under relax too', () => {
    const r = rule({ classes: ['person'], identities: ['id-a'] })
    const named: NcRuleSubject = {
      ...person,
      label: 'Person A',
      labelKind: 'identity',
      identityId: 'id-a',
    }
    const relaxed = evaluateRule(r, named, undefined, undefined, undefined, RELAX)
    expect(relaxed.matched).toBe(true)
    expect(relaxed.pendingOn).toBeUndefined()
  })
  it('the conditions after the label group still run (a later failure is not hidden)', () => {
    const r = rule({ classes: ['person'], identities: ['id-a'], packagePhase: 'delivered' })
    const relaxed = evaluateRule(r, person, undefined, undefined, undefined, RELAX)
    expect(relaxed.failedCondition).toBe('packagePhase')
    expect(relaxed.pendingOn).toBeUndefined()
  })
  it('several recognition conditions are all reported pending, in gauntlet order', () => {
    const r = rule({ classes: ['person'], identities: ['id-a'], plates: { values: ['AB123CD'] } })
    const relaxed = evaluateRule(r, person, undefined, undefined, undefined, RELAX)
    expect(relaxed.pendingOn).toEqual(['identities', 'plates'])
  })
  // Every recognition condition, one case each: a NEW condition added to the set fails here
  // until it has a relaxed-path case of its own (review T3-M1).
  const failing: Readonly<
    Record<
      (typeof NC_RECOGNITION_CONDITIONS)[number],
      { conditions: Record<string, unknown>; subject: NcRuleSubject }
    >
  > = {
    labelEquals: { conditions: { labelEquals: ['courier'] }, subject: person },
    identities: { conditions: { identities: ['id-a'] }, subject: person },
    identitiesExclude: {
      conditions: { identitiesExclude: ['id-a'] },
      subject: { ...person, label: 'Person A', labelKind: 'identity', identityId: 'id-a' },
    },
    minLabelConfidence: { conditions: { minLabelConfidence: 0.8 }, subject: person },
    plates: { conditions: { plates: { values: ['AB123CD'] } }, subject: person },
  }
  it.each([...NC_RECOGNITION_CONDITIONS])('relax turns a failing %s into pending, alone', (id) => {
    const { conditions, subject } = failing[id]
    const r = rule({ classes: ['person'], ...conditions })
    expect(evaluateRule(r, subject)).toMatchObject({ matched: false, failedCondition: id })
    const relaxed = evaluateRule(r, subject, undefined, undefined, undefined, RELAX)
    expect(relaxed).toMatchObject({ matched: false, failedCondition: id, pendingOn: [id] })
  })
  it('relaxing ONE condition leaves the others failing as before', () => {
    const r = rule({ classes: ['person'], identities: ['id-a'], minLabelConfidence: 0.8 })
    const relaxed = evaluateRule(r, person, undefined, undefined, undefined, {
      relax: ['identities'],
    })
    expect(relaxed).toMatchObject({ matched: false, failedCondition: 'minLabelConfidence' })
    expect(relaxed.pendingOn).toBeUndefined()
  })

  it('ruleHasRecognitionScope: identities or plates, never identitiesExclude alone', () => {
    expect(ruleHasRecognitionScope(rule({ identities: [] }))).toBe(true)
    expect(ruleHasRecognitionScope(rule({ plates: { values: [] } }))).toBe(true)
    expect(ruleHasRecognitionScope(rule({ identitiesExclude: ['id-a'] }))).toBe(false)
  })
})
