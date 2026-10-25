/**
 * Rule-engine AUDIO-WINDOW tests.
 *
 * A confirmed sampling window (`audio-rule-matcher.ts`) rides the EXISTING
 * `immediate` delivery through an INTERNAL `NcSubjectKind` (`audio-window`)
 * that never leaves the engine — the occupancy pattern, with a sound landing.
 * These specs pin:
 *  - `subjectFromAudioWindow` normalisation off an `AudioWindowHit`;
 *  - the `evaluateRule` audio branch: the safety gate (`immediate` delivery +
 *    a `conditions.audio` present), the spec pairing (a rule is never answered
 *    with another rule's window) and the `hitPercent` comparison;
 *  - the SEPARATION that keeps this dark: a rule with no `audio` condition
 *    never fires on a window, and a rule WITH one never fires on a detection,
 *    a track, a device event or the legacy classified-audio subject;
 *  - fail-closed for a condition that names neither labels nor a threshold.
 */

import type { AudioEvent, NcRule, ObjectEvent } from '@camstack/types'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeTestAudioEvent, makeTestObjectEvent } from '../../__tests__/support/events.js'
import type { AudioWindowHit, AudioWindowSpec } from '../audio-rule-matcher.js'
import {
  evaluateRule,
  subjectFromAudioEvent,
  subjectFromAudioWindow,
  subjectFromObjectEvent,
} from '../rule-engine.js'

const WED_NOON = Date.UTC(2026, 6, 22, 12, 0, 0)

function makeRule(overrides: Record<string, unknown> = {}): NcRule {
  const input = NcRuleInputSchema.parse({
    name: 'audio rule',
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

/** A LEVEL-mode confirmation — the windowed one. */
function makeHit(
  spec: Partial<Omit<Extract<AudioWindowSpec, { mode: 'level' }>, 'mode'>> = {},
  over: Partial<AudioWindowHit> = {},
): AudioWindowHit {
  const fullSpec: Extract<AudioWindowSpec, { mode: 'level' }> = {
    mode: 'level',
    dbThreshold: -30,
    hitPercent: 60,
    samplingSeconds: 10,
    ...spec,
  }
  return {
    deviceId: 104,
    timestamp: WED_NOON,
    labels: [],
    window: {
      hitPercent: 80,
      samples: 10,
      hits: 8,
      samplingSeconds: fullSpec.samplingSeconds,
    },
    spec: fullSpec,
    ...over,
  }
}

/** A LABEL-mode confirmation — one labelled frame, no window (D157). */
function makeLabelHit(
  labels: readonly string[],
  over: Partial<AudioWindowHit> = {},
): AudioWindowHit {
  return {
    deviceId: 104,
    timestamp: WED_NOON,
    labels: [...labels],
    spec: { mode: 'label', labels: [...labels], confirmHits: 2, confirmWindowSec: 5 },
    ...over,
  }
}

function makeObjectEvent(): ObjectEvent {
  return makeTestObjectEvent({
    deviceId: 104,
    timestamp: WED_NOON,
    className: 'person',
    confidence: 0.9,
    zones: [],
  })
}

function makeAudioEvent(): AudioEvent {
  return makeTestAudioEvent({
    deviceId: 104,
    timestamp: WED_NOON,
    rms: 0.4,
    dbfs: -12,
    classification: { className: 'dog', score: 0.8 },
  })
}

// ── subjectFromAudioWindow ──────────────────────────────────────────

describe('subjectFromAudioWindow', () => {
  it('normalizes a LEVEL window onto the engine subject', () => {
    const subject = subjectFromAudioWindow(
      makeHit({ dbThreshold: -30 }, { labels: ['dog'], peakDbfs: -11 }),
    )
    expect(subject.kind).toBe('audio-window')
    expect(subject.deviceId).toBe(104)
    expect(subject.timestamp).toBe(WED_NOON)
    expect(subject.source).toBe('audio')
    expect(subject.audioWindow).toEqual({
      mode: 'level',
      hitPercent: 80,
      samplingSeconds: 10,
      samples: 10,
      hits: 8,
      dbThreshold: -30,
      peakDbfs: -11,
      labels: ['dog'],
    })
  })

  it('normalizes a LABEL match onto the engine subject — no window on it at all', () => {
    const subject = subjectFromAudioWindow(makeLabelHit(['crying'], { peakDbfs: -48 }))
    expect(subject.audioWindow).toEqual({
      mode: 'label',
      specLabels: ['crying'],
      labels: ['crying'],
      peakDbfs: -48,
    })
  })

  it('names the heard sounds in the TAXONOMY spelling, as the legacy path does', () => {
    expect(subjectFromAudioWindow(makeLabelHit(['dog'])).classNames).toEqual(['audio-dog'])
  })

  it('carries NO confidence — a percentage of samples is not a classifier score', () => {
    expect(subjectFromAudioWindow(makeHit({ dbThreshold: -30 })).confidence).toBeUndefined()
    expect(subjectFromAudioWindow(makeLabelHit(['dog'])).confidence).toBeUndefined()
  })

  it('gives distinct windows distinct record ids (the outbox dedup key)', () => {
    const a = subjectFromAudioWindow(makeHit({ dbThreshold: -30 }))
    const b = subjectFromAudioWindow(
      makeHit({ dbThreshold: -30 }, { timestamp: WED_NOON + 60_000 }),
    )
    expect(a.recordId).not.toBe(b.recordId)
  })
})

// ── the safety gate ─────────────────────────────────────────────────

describe('evaluateRule — the audio safety gate', () => {
  it('fires an immediate rule that declares an audio condition', () => {
    const rule = makeRule({ conditions: { audio: { dbThreshold: -30, hitPercent: 60 } } })
    const subject = subjectFromAudioWindow(makeHit({ dbThreshold: -30 }))
    expect(evaluateRule(rule, subject).matched).toBe(true)
  })

  it('NEVER fires a rule with no audio condition — this is what keeps it dark', () => {
    const rule = makeRule({ conditions: { classes: ['person'] } })
    const subject = subjectFromAudioWindow(makeHit({ dbThreshold: -30 }))
    const verdict = evaluateRule(rule, subject)
    expect(verdict.matched).toBe(false)
    expect(verdict.failedCondition).toBe('audio')
  })

  it('never fires a LEGACY audio-class rule on a watcher match', () => {
    const rule = makeRule({ conditions: { classes: ['audio-dog'] } })
    expect(evaluateRule(rule, subjectFromAudioWindow(makeLabelHit(['dog']))).failedCondition).toBe(
      'audio',
    )
  })

  it('never fires an AUDIO rule on a detection, and the legacy path is untouched', () => {
    const audioRule = makeRule({ conditions: { audio: { dbThreshold: -30 } } })
    expect(evaluateRule(audioRule, subjectFromObjectEvent(makeObjectEvent())).failedCondition).toBe(
      'audio',
    )
    expect(evaluateRule(audioRule, subjectFromAudioEvent(makeAudioEvent())).failedCondition).toBe(
      'audio',
    )

    // …and the legacy classified-audio rule still fires on the legacy subject.
    const legacy = makeRule({ conditions: { classes: ['audio-dog'] } })
    expect(evaluateRule(legacy, subjectFromAudioEvent(makeAudioEvent())).matched).toBe(true)
  })

  it('refuses a non-immediate rule', () => {
    const rule = makeRule({
      delivery: 'track-end',
      conditions: { audio: { dbThreshold: -30 } },
    })
    expect(
      evaluateRule(rule, subjectFromAudioWindow(makeHit({ dbThreshold: -30 }))).failedCondition,
    ).toBe('delivery')
  })
})

// ── the hitPercent comparison and the spec pairing ──────────────────

describe('evaluateRule — the audio condition', () => {
  it('matches at and above the configured hitPercent, not below', () => {
    const rule = makeRule({ conditions: { audio: { dbThreshold: -30, hitPercent: 80 } } })
    const at = (measured: number): boolean =>
      evaluateRule(
        rule,
        subjectFromAudioWindow(
          makeHit(
            { dbThreshold: -30 },
            { window: { hitPercent: measured, samples: 10, hits: 8, samplingSeconds: 10 } },
          ),
        ),
      ).matched
    expect(at(80)).toBe(true)
    expect(at(95)).toBe(true)
    expect(at(79.9)).toBe(false)
  })

  it('never answers a rule with ANOTHER rule’s window', () => {
    const rule = makeRule({
      conditions: { audio: { dbThreshold: -30, hitPercent: 60, samplingSeconds: 10 } },
    })
    // Same measurement, a different window length / threshold / mode.
    expect(
      evaluateRule(rule, subjectFromAudioWindow(makeHit({ dbThreshold: -30, samplingSeconds: 30 })))
        .failedCondition,
    ).toBe('audio')
    expect(
      evaluateRule(rule, subjectFromAudioWindow(makeHit({ dbThreshold: -20 }))).failedCondition,
    ).toBe('audio')
    expect(evaluateRule(rule, subjectFromAudioWindow(makeLabelHit(['dog']))).failedCondition).toBe(
      'audio',
    )
  })

  // ── LABEL mode (D157) ─────────────────────────────────────────────

  it('fires a LABEL rule on one labelled frame, in either spelling', () => {
    const rule = makeRule({ conditions: { audio: { labels: ['audio-Dog'] } } })
    expect(evaluateRule(rule, subjectFromAudioWindow(makeLabelHit(['dog']))).matched).toBe(true)
  })

  it('IGNORES hitPercent and samplingSeconds in label mode — the live rule 4d7dbe2a', () => {
    // labels crying+scream, hitPercent 60 over 10 s, no dB threshold: the
    // stored shape of the operator's rule, which under the windowed semantics
    // could not fire (max measured hitPercent over the whole history: 40).
    const rule = makeRule({
      conditions: { audio: { labels: ['crying', 'scream'], hitPercent: 60, samplingSeconds: 10 } },
    })
    expect(
      evaluateRule(rule, subjectFromAudioWindow(makeLabelHit(['crying', 'scream']))).matched,
    ).toBe(true)
  })

  it('never answers a LABEL rule with another label set', () => {
    const rule = makeRule({ conditions: { audio: { labels: ['crying'] } } })
    expect(evaluateRule(rule, subjectFromAudioWindow(makeLabelHit(['dog']))).failedCondition).toBe(
      'audio',
    )
    // A superset is a different question too: the watcher keys on the SET.
    expect(
      evaluateRule(rule, subjectFromAudioWindow(makeLabelHit(['crying', 'dog']))).failedCondition,
    ).toBe('audio')
  })

  it('never answers a LABEL rule with a LEVEL window, or the reverse', () => {
    const labelRule = makeRule({ conditions: { audio: { labels: ['crying'] } } })
    expect(
      evaluateRule(labelRule, subjectFromAudioWindow(makeHit({ dbThreshold: -30 })))
        .failedCondition,
    ).toBe('audio')
    const levelRule = makeRule({ conditions: { audio: { dbThreshold: -30 } } })
    expect(
      evaluateRule(levelRule, subjectFromAudioWindow(makeLabelHit(['crying']))).failedCondition,
    ).toBe('audio')
  })

  it('takes a LEGACY both-filters rule as the LABEL rule it now is', () => {
    const rule = makeRule({ conditions: { audio: { labels: ['crying'], dbThreshold: -30 } } })
    expect(evaluateRule(rule, subjectFromAudioWindow(makeLabelHit(['crying']))).matched).toBe(true)
  })

  it('FAILS CLOSED on a condition naming neither labels nor a threshold', () => {
    const rule = makeRule({ conditions: { audio: { hitPercent: 1 } } })
    expect(evaluateRule(rule, subjectFromAudioWindow(makeLabelHit(['dog']))).failedCondition).toBe(
      'audio',
    )
    expect(
      evaluateRule(rule, subjectFromAudioWindow(makeHit({ dbThreshold: -30 }))).failedCondition,
    ).toBe('audio')
  })

  it('composes with the shared gauntlet — a device scope still narrows', () => {
    const rule = makeRule({
      conditions: { audio: { dbThreshold: -30 }, devices: [102] },
    })
    expect(
      evaluateRule(rule, subjectFromAudioWindow(makeHit({ dbThreshold: -30 }))).failedCondition,
    ).toBe('devices')
    expect(
      evaluateRule(rule, subjectFromAudioWindow(makeHit({ dbThreshold: -30 }, { deviceId: 102 })))
        .matched,
    ).toBe(true)
  })
})
