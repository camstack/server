/**
 * The `deviceState` gate — "only fire while some OTHER device is in one of
 * these states".
 *
 * The gate exists so a rule can be armed by the alarm ("only when armed away")
 * or by anything else with a state — a switch, a contact. It is the general
 * mechanism; the alarm is one caller.
 *
 * **Everything here is about failing CLOSED.** A gate that fired when it could
 * not read the state would be worse than no gate at all: the operator believes
 * the rule is suppressed while it is notifying. So an unknown device, a cold
 * cache, and an unwired caller all produce "does not fire" — not "fires
 * anyway".
 *
 * `evaluateRule` stays PURE: the state arrives as a lookup argument, never
 * fetched inside. It runs on the persist hook, per event.
 */

import type { NcRule } from '@camstack/types'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, type NcRuleSubject } from '../rule-engine.js'

const ALARM_ID = 42

function ruleWith(conditions: Record<string, unknown>): NcRule {
  const input = NcRuleInputSchema.parse({
    name: 'gated rule',
    delivery: 'immediate',
    targets: [{ targetId: 't1' }],
    conditions,
  })
  return NcRuleSchema.parse({
    ...input,
    id: 'r1',
    createdBy: 'admin',
    createdAt: 0,
    updatedAt: 0,
    disabledTargetIds: [],
  })
}

function subject(): NcRuleSubject {
  return {
    kind: 'object-event',
    recordId: 'ev-1',
    deviceId: 101,
    timestamp: 1_800_000_000_000,
    classNames: ['person'],
    zones: [],
  }
}

/** A lookup over a fixed map: every device answers its one cached word. */
function lookup(map: Record<number, string>): (id: number) => readonly string[] | undefined {
  return (id) => {
    const state = map[id]
    return state === undefined ? undefined : [state]
  }
}

const armedAway = { deviceState: { deviceId: ALARM_ID, states: ['armed_away'] } }

describe('deviceState — the safe direction', () => {
  it('does NOT fire when the state is unknown', () => {
    // The device is gone, or the cache has not been filled yet. Silence.
    const res = evaluateRule(ruleWith(armedAway), subject(), lookup({}))
    expect(res.matched).toBe(false)
    expect(res.failedCondition).toBe('deviceState')
  })

  it('does NOT fire when NO lookup is supplied at all', () => {
    // An unwired caller must not silently disable the gate — that would turn a
    // suppressed rule into a notifying one without a single line of evidence.
    const res = evaluateRule(ruleWith(armedAway), subject())
    expect(res.matched).toBe(false)
    expect(res.failedCondition).toBe('deviceState')
  })

  it('does NOT fire when the state is something else', () => {
    const res = evaluateRule(ruleWith(armedAway), subject(), lookup({ [ALARM_ID]: 'disarmed' }))
    expect(res.matched).toBe(false)
    expect(res.failedCondition).toBe('deviceState')
  })
})

describe('deviceState — when it does fire', () => {
  it('fires on a matching state', () => {
    const res = evaluateRule(ruleWith(armedAway), subject(), lookup({ [ALARM_ID]: 'armed_away' }))
    expect(res.matched).toBe(true)
  })

  it('fires on ANY of the listed states', () => {
    const rule = ruleWith({
      deviceState: { deviceId: ALARM_ID, states: ['armed_away', 'armed_night'] },
    })
    expect(evaluateRule(rule, subject(), lookup({ [ALARM_ID]: 'armed_night' })).matched).toBe(true)
  })

  it('matches case-insensitively and ignores surrounding space', () => {
    // Device vocabularies are not normalised across providers; an alarm that
    // reports `Armed_Away` must not silently stop arming the rule.
    const res = evaluateRule(ruleWith(armedAway), subject(), lookup({ [ALARM_ID]: ' Armed_Away ' }))
    expect(res.matched).toBe(true)
  })
})

describe('deviceState — rules that do not use it', () => {
  it('is unaffected by any lookup, present or absent', () => {
    const plain = ruleWith({ classes: ['person'] })
    expect(evaluateRule(plain, subject()).matched).toBe(true)
    expect(evaluateRule(plain, subject(), lookup({})).matched).toBe(true)
    expect(evaluateRule(plain, subject(), lookup({ [ALARM_ID]: 'disarmed' })).matched).toBe(true)
  })

  it('composes with the other conditions rather than replacing them', () => {
    // The gate is an AND: a matching alarm state does not rescue a rule whose
    // class condition fails.
    const rule = ruleWith({ ...armedAway, classes: ['vehicle'] })
    const res = evaluateRule(rule, subject(), lookup({ [ALARM_ID]: 'armed_away' }))
    expect(res.matched).toBe(false)
    expect(res.failedCondition).not.toBe('deviceState')
  })
})

/**
 * The alarm panel answers MORE than one word: `pending`/`triggered` also answer
 * as the armed mode they belong to, so an intruder rule gated on `armed_away`
 * keeps notifying through the entry delay and the siren (D630).
 */
describe('deviceState — a device that answers several words', () => {
  const PANEL = 900
  const gated = { deviceState: { deviceId: PANEL, states: ['armed_away'] } }
  const words =
    (answer: readonly string[] | undefined) =>
    (id: number): readonly string[] | undefined =>
      id === PANEL ? answer : undefined

  it('matches when ANY word is in the rule states', () => {
    const res = evaluateRule(ruleWith(gated), subject(), words(['pending', 'armed_away']))
    expect(res.matched).toBe(true)
  })

  it('does NOT match pending alone', () => {
    const res = evaluateRule(ruleWith(gated), subject(), words(['pending']))
    expect(res.matched).toBe(false)
    expect(res.failedCondition).toBe('deviceState')
  })

  it('does NOT match an unreadable device, nor an empty answer', () => {
    expect(evaluateRule(ruleWith(gated), subject(), words(undefined)).failedCondition).toBe(
      'deviceState',
    )
    expect(evaluateRule(ruleWith(gated), subject(), words([])).failedCondition).toBe('deviceState')
  })
})
