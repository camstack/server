/**
 * Rule-engine SCENE GATE tests.
 *
 * `conditions.scene` is the second gate in this engine (after `deviceState`)
 * and it is deliberately NOT the third discriminator: unlike `occupancy` and
 * `audio`, carrying it does not change what a rule fires ON. These specs pin
 * exactly that distinction, plus the four ways the gate must fail closed and
 * the one way it must not (a latch that survives a scene which cannot judge).
 *
 * See D159 for the semantics and `scene-state-cache.spec.ts` for the mirror.
 */

import type { NcRule, ObjectEvent } from '@camstack/types'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, subjectFromObjectEvent, subjectFromOccupancyEvent } from '../rule-engine.js'
import type { NcSceneObservation } from '../scene-state-cache.js'

const WED_NOON = Date.UTC(2026, 6, 22, 12, 0, 0)
const SCENE = 'scene-uuid-1'

function makeRule(conditions: Record<string, unknown>, delivery = 'immediate'): NcRule {
  const input = NcRuleInputSchema.parse({
    name: 'scene-gated rule',
    delivery,
    targets: [{ targetId: 't1' }],
    conditions,
  })
  return NcRuleSchema.parse({
    ...input,
    id: 'rule-1',
    createdBy: 'admin-user',
    createdAt: 1_000,
    updatedAt: 1_000,
  })
}

function makeObjectEvent(): ObjectEvent {
  return {
    id: 90_001,
    kind: 'object',
    deviceId: 104,
    timestamp: WED_NOON,
    className: 'person',
    state: 'moving',
    confidence: 0.9,
    zones: [],
  }
}

function observation(over: Partial<NcSceneObservation> = {}): NcSceneObservation {
  return {
    sceneId: SCENE,
    deviceId: 102,
    label: 'Bin out front',
    verdict: 'matched',
    latched: false,
    emit: 'latched',
    ...over,
  }
}

/** The lookup the centre hands `evaluateRule`. */
function lookupOf(...observations: readonly NcSceneObservation[]) {
  const byId = new Map(observations.map((o) => [o.sceneId, o]))
  return (sceneId: string): NcSceneObservation | undefined => byId.get(sceneId)
}

describe('evaluateRule — the scene gate', () => {
  it('a rule with NO scene condition is untouched — the gate costs nothing', () => {
    const rule = makeRule({ classes: ['person'] })
    const subject = subjectFromObjectEvent(makeObjectEvent())
    expect(evaluateRule(rule, subject).matched).toBe(true)
    // …and stays true even with a lookup wired that knows nothing.
    expect(evaluateRule(rule, subject, undefined, undefined, lookupOf()).matched).toBe(true)
  })

  it('FAILS CLOSED with no lookup wired at all', () => {
    const rule = makeRule({ scene: { sceneId: SCENE, requiredState: 'diverged' } })
    const subject = subjectFromObjectEvent(makeObjectEvent())
    expect(evaluateRule(rule, subject).failedCondition).toBe('scene')
  })

  /**
   * NEUTRALIZATION: change the `observation === undefined` guard in the engine's
   * scene block to a pass and this test fails. That is the whole gate — a rule
   * the operator believes is narrowed, notifying because a mirror was cold.
   */
  it('FAILS CLOSED on a scene the mirror does not carry (cold, deleted, disabled)', () => {
    const rule = makeRule({ scene: { sceneId: SCENE, requiredState: 'diverged' } })
    const subject = subjectFromObjectEvent(makeObjectEvent())
    const verdict = evaluateRule(rule, subject, undefined, undefined, lookupOf())
    expect(verdict.matched).toBe(false)
    expect(verdict.failedCondition).toBe('scene')
  })

  it('fires when the LIVE verdict is the required one, and not otherwise', () => {
    const rule = makeRule({ scene: { sceneId: SCENE, requiredState: 'diverged', latched: false } })
    const subject = subjectFromObjectEvent(makeObjectEvent())
    expect(
      evaluateRule(
        rule,
        subject,
        undefined,
        undefined,
        lookupOf(observation({ verdict: 'diverged' })),
      ).matched,
    ).toBe(true)
    expect(
      evaluateRule(
        rule,
        subject,
        undefined,
        undefined,
        lookupOf(observation({ verdict: 'matched' })),
      ).failedCondition,
    ).toBe('scene')
  })

  it('a scene that CANNOT JUDGE fires neither polarity on the live reading', () => {
    const subject = subjectFromObjectEvent(makeObjectEvent())
    const unknown = lookupOf(observation({ verdict: 'unknown' }))
    for (const requiredState of ['matched', 'diverged'] as const) {
      const rule = makeRule({ scene: { sceneId: SCENE, requiredState, latched: false } })
      expect(evaluateRule(rule, subject, undefined, undefined, unknown).failedCondition).toBe(
        'scene',
      )
    }
  })

  it('…but the LATCH survives a scene that cannot judge — that is what a latch is for', () => {
    const rule = makeRule({ scene: { sceneId: SCENE, requiredState: 'diverged', latched: true } })
    const subject = subjectFromObjectEvent(makeObjectEvent())
    const lookup = lookupOf(observation({ verdict: 'unknown', latched: true }))
    expect(evaluateRule(rule, subject, undefined, undefined, lookup).matched).toBe(true)
  })

  it('`latched` absent follows the scene’s own `emit` (D62 — one authority, not two)', () => {
    const rule = makeRule({ scene: { sceneId: SCENE, requiredState: 'diverged' } })
    const subject = subjectFromObjectEvent(makeObjectEvent())
    // The bin came back (verdict matched) but the operator has not reset it.
    const state = { verdict: 'matched' as const, latched: true }
    expect(
      evaluateRule(
        rule,
        subject,
        undefined,
        undefined,
        lookupOf(observation({ ...state, emit: 'latched' })),
      ).matched,
    ).toBe(true)
    expect(
      evaluateRule(
        rule,
        subject,
        undefined,
        undefined,
        lookupOf(observation({ ...state, emit: 'live' })),
      ).failedCondition,
    ).toBe('scene')
  })

  it('is a GATE, not a trigger: it never turns a detection rule into a scene rule', () => {
    // A scene-gated detection rule still needs its detection. The gate narrows;
    // it does not supply a subject, and it does not make the rule fire on a
    // scene edge (there is no scene subject kind at all — D159).
    const rule = makeRule({
      classes: ['vehicle'],
      scene: { sceneId: SCENE, requiredState: 'diverged', latched: false },
    })
    const subject = subjectFromObjectEvent(makeObjectEvent()) // a person
    const lookup = lookupOf(observation({ verdict: 'diverged' }))
    expect(evaluateRule(rule, subject, undefined, undefined, lookup).failedCondition).toBe(
      'classes',
    )
  })

  it('composes with an OCCUPANCY rule — the count edge still discriminates', () => {
    const rule = makeRule(
      {
        occupancy: { op: 'became-occupied', count: 1, sustainSeconds: 15 },
        scene: { sceneId: SCENE, requiredState: 'diverged', latched: false },
      },
      'device-event',
    )
    const subject = subjectFromOccupancyEvent({
      deviceId: 104,
      timestamp: WED_NOON,
      count: 1,
      previousCount: 0,
      occupied: true,
      threshold: 1,
    })
    expect(
      evaluateRule(
        rule,
        subject,
        undefined,
        undefined,
        lookupOf(observation({ verdict: 'diverged' })),
      ).matched,
    ).toBe(true)
    expect(
      evaluateRule(
        rule,
        subject,
        undefined,
        undefined,
        lookupOf(observation({ verdict: 'matched' })),
      ).failedCondition,
    ).toBe('scene')
  })

  it('the gate runs AFTER the subject-kind branches, so a wrong trigger still says so', () => {
    // A `device-event` rule carrying a scene gate, evaluated against an object
    // event: the answer must be `delivery`, not `scene` — naming the gate here
    // would send the operator to fix the wrong thing.
    const rule = makeRule({ scene: { sceneId: SCENE, requiredState: 'diverged' } }, 'device-event')
    const subject = subjectFromObjectEvent(makeObjectEvent())
    expect(evaluateRule(rule, subject, undefined, undefined, lookupOf()).failedCondition).toBe(
      'delivery',
    )
  })
})
