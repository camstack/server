/**
 * Rule-engine AUDIO + macro-expansion tests.
 *
 * Audio classification events persist on a separate path and never reach the
 * object-event hook. These specs pin the NEW audio subject ingestion, the
 * safety gate (audio fires ONLY on an explicit `audio-*` class opt-in), the
 * fail-closed degradation of object/track-specific conditions on audio
 * subjects, and the video macro→leaf class expansion.
 */

import type { AudioEvent, NcRule } from '@camstack/types'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { evaluateRule, type NcRuleSubject, subjectFromAudioEvent } from '../rule-engine.js'

// ── fixtures ────────────────────────────────────────────────────────

function makeRule(overrides: Record<string, unknown> = {}): NcRule {
  const input = NcRuleInputSchema.parse({
    name: 'test rule',
    delivery: 'immediate',
    targets: [{ targetId: 't1' }],
    ...overrides,
  })
  return NcRuleSchema.parse({
    ...input,
    id: 'rule-1',
    createdBy: 'admin-user',
    createdAt: 1_000,
    updatedAt: 1_000,
  })
}

function makeAudioEvent(overrides: Partial<AudioEvent> = {}): AudioEvent {
  return {
    id: 100_001,
    kind: 'audio',
    deviceId: 104,
    timestamp: Date.UTC(2026, 6, 22, 12, 0, 0), // Wednesday noon UTC
    rms: 0.1,
    dbfs: -20,
    classification: { className: 'dog', score: 0.92 },
    ...overrides,
  }
}

// ── subjectFromAudioEvent ───────────────────────────────────────────

describe('subjectFromAudioEvent', () => {
  it('namespaces the macro class as `audio-<id>` (matches the taxonomy id)', () => {
    const s = subjectFromAudioEvent(makeAudioEvent())
    expect(s.kind).toBe('audio-event')
    expect(s.recordId).toBe('100001')
    expect(s.deviceId).toBe(104)
    expect(s.classNames).toEqual(['audio-dog'])
    expect(s.confidence).toBe(0.92)
    expect(s.zones).toEqual([])
    expect(s.source).toBe('pipeline')
    // No object/track dimensions carried.
    expect(s.trackId).toBeUndefined()
    expect(s.label).toBeUndefined()
    expect(s.bbox).toBeUndefined()
  })

  it('preserves underscore macro ids (glass_breaking → audio-glass_breaking)', () => {
    const s = subjectFromAudioEvent(
      makeAudioEvent({ classification: { className: 'glass_breaking', score: 0.7 } }),
    )
    expect(s.classNames).toEqual(['audio-glass_breaking'])
  })

  it('a level-path audio event (no classification) carries no class + no confidence', () => {
    const { classification: _c, ...rest } = makeAudioEvent()
    const s = subjectFromAudioEvent(rest)
    expect(s.classNames).toEqual([])
    expect(s.confidence).toBeUndefined()
  })
})

// ── safety gate ─────────────────────────────────────────────────────

describe('audio safety gate', () => {
  it('a rule with NO classes NEVER fires on an audio subject', () => {
    const rule = makeRule({ conditions: {} })
    const ev = evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent()))
    expect(ev.matched).toBe(false)
    expect(ev.failedCondition).toBe('classes')
  })

  it('a rule with ONLY video classes NEVER fires on an audio subject', () => {
    const rule = makeRule({ conditions: { classes: ['person', 'vehicle'] } })
    const ev = evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent()))
    expect(ev.matched).toBe(false)
    expect(ev.failedCondition).toBe('classes')
  })

  it('a rule opting in to the matching audio class FIRES', () => {
    const rule = makeRule({ conditions: { classes: ['audio-dog'] } })
    const ev = evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent()))
    expect(ev.matched).toBe(true)
    expect(ev.matchedOn).toEqual(['classes'])
  })

  it('an audio opt-in for a DIFFERENT audio class does not fire', () => {
    const rule = makeRule({ conditions: { classes: ['audio-scream'] } })
    const ev = evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent()))
    expect(ev.matched).toBe(false)
    expect(ev.failedCondition).toBe('classes')
  })

  it('a mixed video+audio opt-in fires on the audio class', () => {
    const rule = makeRule({ conditions: { classes: ['person', 'audio-dog'] } })
    const ev = evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent()))
    expect(ev.matched).toBe(true)
  })

  it('a non-immediate (track-end) rule never targets an audio subject', () => {
    const rule = makeRule({ delivery: 'track-end', conditions: { classes: ['audio-dog'] } })
    const ev = evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent()))
    expect(ev.matched).toBe(false)
    expect(ev.failedCondition).toBe('delivery')
  })

  it('a classless (level-path) audio subject never fires even with an audio opt-in', () => {
    const rule = makeRule({ conditions: { classes: ['audio-dog'] } })
    const { classification: _c, ...rest } = makeAudioEvent()
    const ev = evaluateRule(rule, subjectFromAudioEvent(rest))
    expect(ev.matched).toBe(false)
    expect(ev.failedCondition).toBe('classes')
  })
})

// ── composed conditions on audio subjects ───────────────────────────

describe('conditions compose / fail-closed on audio', () => {
  it('devices composes (a non-listed device fails devices)', () => {
    const rule = makeRule({ conditions: { classes: ['audio-dog'], devices: [999] } })
    expect(evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent())).failedCondition).toBe(
      'devices',
    )
  })

  it('minConfidence composes off the classification score', () => {
    const rule = makeRule({ conditions: { classes: ['audio-dog'], minConfidence: 0.95 } })
    expect(evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent())).failedCondition).toBe(
      'minConfidence',
    )
    const okRule = makeRule({ conditions: { classes: ['audio-dog'], minConfidence: 0.5 } })
    expect(evaluateRule(okRule, subjectFromAudioEvent(makeAudioEvent())).matched).toBe(true)
  })

  it('schedule composes at the audio timestamp', () => {
    const rule = makeRule({
      conditions: { classes: ['audio-dog'] },
      schedule: {
        timezone: 'UTC',
        windows: [{ days: [3], startMinute: 13 * 60, endMinute: 14 * 60 }],
      },
    })
    // Event is Wed 12:00 UTC — outside the 13:00-14:00 window.
    expect(evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent())).failedCondition).toBe(
      'schedule',
    )
  })

  it('minImportance FAILS CLOSED on audio (no importance to guess)', () => {
    const rule = makeRule({ conditions: { classes: ['audio-dog'], minImportance: 0.1 } })
    expect(evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent())).failedCondition).toBe(
      'minImportance',
    )
  })

  it('minDwellSeconds FAILS CLOSED on audio (no closed lifespan)', () => {
    const rule = makeRule({ conditions: { classes: ['audio-dog'], minDwellSeconds: 1 } })
    expect(evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent())).failedCondition).toBe(
      'minDwellSeconds',
    )
  })

  it('zones FAIL CLOSED on audio (audio has no zone provenance)', () => {
    const rule = makeRule({
      conditions: { classes: ['audio-dog'], zones: { match: 'any', ids: ['drive'] } },
    })
    expect(evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent())).failedCondition).toBe(
      'zones',
    )
  })

  it('customZones FAIL CLOSED on audio (no bbox)', () => {
    const rule = makeRule({
      conditions: {
        classes: ['audio-dog'],
        customZones: [
          {
            kind: 'polygon',
            points: [
              { x: 0, y: 0 },
              { x: 1, y: 0 },
              { x: 1, y: 1 },
            ],
          },
        ],
      },
    })
    expect(evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent())).failedCondition).toBe(
      'customZones',
    )
  })

  it('identities FAIL CLOSED on audio (no label)', () => {
    const rule = makeRule({ conditions: { classes: ['audio-dog'], identities: ['john'] } })
    expect(evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent())).failedCondition).toBe(
      'identities',
    )
  })

  it('minLabelConfidence FAILS CLOSED on audio', () => {
    const rule = makeRule({ conditions: { classes: ['audio-dog'], minLabelConfidence: 0.1 } })
    expect(evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent())).failedCondition).toBe(
      'minLabelConfidence',
    )
  })

  it('plates FAIL CLOSED on audio (no plate label)', () => {
    const rule = makeRule({
      conditions: { classes: ['audio-dog'], plates: { values: ['AB123'], maxDistance: 1 } },
    })
    expect(evaluateRule(rule, subjectFromAudioEvent(makeAudioEvent())).failedCondition).toBe(
      'plates',
    )
  })
})

// ── macro → leaf class expansion (video) ────────────────────────────

describe('class macro expansion', () => {
  function makeVideoSubject(overrides: Partial<NcRuleSubject> = {}): NcRuleSubject {
    return {
      kind: 'object-event',
      recordId: 'ev-1',
      deviceId: 104,
      timestamp: Date.UTC(2026, 6, 22, 12, 0, 0),
      classNames: ['car'],
      confidence: 0.9,
      zones: [],
      ...overrides,
    }
  }

  it('selecting the `vehicle` macro matches a `car` detection', () => {
    const rule = makeRule({ conditions: { classes: ['vehicle'] } })
    expect(evaluateRule(rule, makeVideoSubject({ classNames: ['car'] })).matched).toBe(true)
  })

  it('selecting `animal` matches a `dog` detection', () => {
    const rule = makeRule({ conditions: { classes: ['animal'] } })
    expect(evaluateRule(rule, makeVideoSubject({ classNames: ['dog'] })).matched).toBe(true)
  })

  it('selecting `vehicle` does NOT match a `person` detection', () => {
    const rule = makeRule({ conditions: { classes: ['vehicle'] } })
    expect(evaluateRule(rule, makeVideoSubject({ classNames: ['person'] })).failedCondition).toBe(
      'classes',
    )
  })

  it('classesExclude expands too — excluding `animal` vetoes a `dog`', () => {
    const rule = makeRule({ conditions: { classesExclude: ['animal'] } })
    expect(evaluateRule(rule, makeVideoSubject({ classNames: ['dog'] })).failedCondition).toBe(
      'classesExclude',
    )
  })

  it('a leaf class still matches itself exactly', () => {
    const rule = makeRule({ conditions: { classes: ['car'] } })
    expect(evaluateRule(rule, makeVideoSubject({ classNames: ['car'] })).matched).toBe(true)
  })
})
