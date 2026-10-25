/**
 * Zone-crossing DIRECTION (`conditions.crossing`).
 *
 * Exits were computed and dropped at the emit boundary until this condition
 * existed, because nothing on the persisted record could tell an entry from an
 * exit — so emitting both would have doubled every zone-scoped rule's
 * notifications. The contract these tests pin down:
 *
 *  - ABSENT behaves as `enter`: today's rules keep firing on entries and on
 *    plain movement-state events, and never start firing on exits.
 *  - `exit` matches ONLY an exit crossing (fail-closed on a non-crossing).
 *  - `any` filters nothing.
 *  - a `zones` condition can address the zone that was LEFT, whose id is no
 *    longer in the record's membership by the time the exit is confirmed.
 */

import type { NcRule, ObjectEvent } from '@camstack/types'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, type NcRuleSubject, subjectFromObjectEvent } from '../rule-engine.js'

// ── fixtures ────────────────────────────────────────────────────────

function makeRule(conditions: Record<string, unknown>): NcRule {
  const input = NcRuleInputSchema.parse({
    name: 'crossing rule',
    delivery: 'immediate',
    targets: [{ targetId: 't1' }],
    conditions,
  })
  return NcRuleSchema.parse({
    ...input,
    id: 'rule-x',
    createdBy: 'admin-user',
    createdAt: 1_000,
    updatedAt: 1_000,
  })
}

function makeSubject(overrides: Partial<NcRuleSubject> = {}): NcRuleSubject {
  return {
    kind: 'object-event',
    recordId: 'ev-1',
    deviceId: 101,
    timestamp: Date.UTC(2026, 6, 31, 12, 0, 0),
    classNames: ['person'],
    confidence: 0.889,
    zones: ['uscio'],
    trackId: 'trk-1',
    ...overrides,
  }
}

/** The subject a confirmed ENTRY produces: membership already holds the zone. */
const entering = makeSubject({ crossing: { direction: 'enter', zoneId: 'uscio' } })

/** The subject a confirmed EXIT produces: the box is OUT, so membership no
 *  longer names the zone — only the crossing does. */
const exiting = makeSubject({
  zones: [],
  crossing: { direction: 'exit', zoneId: 'uscio' },
})

/** A movement-state transition — not a crossing at all. */
const stateOnly = makeSubject()

// ── direction gate ──────────────────────────────────────────────────

describe('crossing direction', () => {
  it('ABSENT keeps every record today’s rules already match', () => {
    const rule = makeRule({})
    expect(evaluateRule(rule, stateOnly).matched).toBe(true)
    expect(evaluateRule(rule, entering).matched).toBe(true)
  })

  it('ABSENT rejects an exit — an operator who never asked gets nothing new', () => {
    const r = evaluateRule(makeRule({}), exiting)
    expect(r.matched).toBe(false)
    expect(r.failedCondition).toBe('crossing')
  })

  it("explicit 'enter' is the same gate as absent", () => {
    const rule = makeRule({ crossing: 'enter' })
    expect(evaluateRule(rule, entering).matched).toBe(true)
    expect(evaluateRule(rule, stateOnly).matched).toBe(true)
    expect(evaluateRule(rule, exiting).failedCondition).toBe('crossing')
  })

  it("'exit' matches only the exit crossing", () => {
    const rule = makeRule({ crossing: 'exit' })
    expect(evaluateRule(rule, exiting).matched).toBe(true)
    expect(evaluateRule(rule, entering).failedCondition).toBe('crossing')
  })

  it("'exit' fails closed on a record that is not a crossing", () => {
    // "Did it leave?" is a question about a boundary. A movement-state
    // transition is not an answer to it.
    expect(evaluateRule(makeRule({ crossing: 'exit' }), stateOnly).failedCondition).toBe('crossing')
  })

  it("'any' filters nothing", () => {
    const rule = makeRule({ crossing: 'any' })
    expect(evaluateRule(rule, entering).matched).toBe(true)
    expect(evaluateRule(rule, exiting).matched).toBe(true)
    expect(evaluateRule(rule, stateOnly).matched).toBe(true)
  })

  it('reports only a NARROWING direction in the matched-on summary', () => {
    // `enter` is the absent behaviour, so it explains nothing about why a
    // notification fired.
    expect(evaluateRule(makeRule({ crossing: 'enter' }), entering).matchedOn).not.toContain(
      'crossing',
    )
    expect(evaluateRule(makeRule({ crossing: 'exit' }), exiting).matchedOn).toContain('crossing')
  })

  it('a track-end rule can never satisfy a crossing (a closed track carries none)', () => {
    const input = NcRuleInputSchema.parse({
      name: 'track rule',
      delivery: 'track-end',
      targets: [{ targetId: 't1' }],
      conditions: { crossing: 'exit' },
    })
    const rule = NcRuleSchema.parse({
      ...input,
      id: 'rule-te',
      createdBy: 'admin',
      createdAt: 1,
      updatedAt: 1,
    })
    const trackSubject = makeSubject({ kind: 'track-end', crossing: undefined })
    expect(evaluateRule(rule, trackSubject).failedCondition).toBe('crossing')
  })
})

// ── the zone an exit is ABOUT ───────────────────────────────────────

describe('zones condition over a crossing', () => {
  it('a zone-scoped exit rule matches the zone that was LEFT', () => {
    // The whole point: `zones` on the record is the membership NOW, and an
    // exit is confirmed precisely when the box is no longer inside.
    expect(exiting.zones).toEqual([])
    const rule = makeRule({ crossing: 'exit', zones: { ids: ['uscio'] } })
    expect(evaluateRule(rule, exiting).matched).toBe(true)
  })

  it('a zone-scoped exit rule does NOT match some other zone’s exit', () => {
    const rule = makeRule({ crossing: 'exit', zones: { ids: ['drive'] } })
    expect(evaluateRule(rule, exiting).failedCondition).toBe('zones')
  })

  it('an exclude-zone veto also sees the zone that was left', () => {
    const rule = makeRule({ crossing: 'exit', zonesExclude: ['uscio'] })
    expect(evaluateRule(rule, exiting).failedCondition).toBe('zonesExclude')
  })

  it('changes nothing for an entry (the zone is already in the membership)', () => {
    const rule = makeRule({ zones: { ids: ['uscio'] } })
    expect(evaluateRule(rule, entering).matched).toBe(true)
    expect(evaluateRule(rule, stateOnly).matched).toBe(true)
  })
})

// ── subject threading ───────────────────────────────────────────────

describe('subjectFromObjectEvent', () => {
  function objectEvent(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
    return {
      id: 100_009,
      kind: 'object',
      deviceId: 101,
      timestamp: 111,
      trackId: 'trk-9',
      className: 'person',
      confidence: 0.9,
      zones: [],
      ...overrides,
    }
  }

  it('threads the persisted crossing onto the subject', () => {
    const s = subjectFromObjectEvent(
      objectEvent({ zoneCrossing: { direction: 'exit', zoneId: 'uscio', zoneName: 'Uscio' } }),
    )
    expect(s.crossing).toEqual({ direction: 'exit', zoneId: 'uscio', zoneName: 'Uscio' })
  })

  it('leaves it absent on a record that is not a crossing', () => {
    expect(subjectFromObjectEvent(objectEvent()).crossing).toBeUndefined()
  })
})
