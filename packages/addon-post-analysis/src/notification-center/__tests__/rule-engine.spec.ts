/**
 * Rule-engine unit tests — the PURE evaluation surface (P1 condition
 * subset): subjects, delivery gating, devices/classes/confidence/zones,
 * label/identity/plate matchers, schedules (windows, timezone, midnight
 * crossing, invert), cooldown helpers and the attachment preference.
 */

import type { NcRule, ObjectEvent, SensorEvent, Track } from '@camstack/types'
import { NC_CONDITION_CATALOG, NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeTestNcSystemEventSubject } from './support/nc-test-deps.js'
import {
  cooldownKey,
  effectiveMediaPolicy,
  effectiveMediaPolicyForRule,
  evaluateRule,
  isCoolingDown,
  isScheduleActive,
  levenshtein,
  matchesPlate,
  type NcRuleSubject,
  normalizePlate,
  presentConditionIds,
  readSensorEventType,
  subjectFromObjectEvent,
  subjectFromPackageEvent,
  subjectFromSensorEvent,
  subjectFromTrack,
} from '../rule-engine.js'

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

function makeSubject(overrides: Partial<NcRuleSubject> = {}): NcRuleSubject {
  return {
    kind: 'object-event',
    recordId: 'ev-1',
    deviceId: 104,
    timestamp: Date.UTC(2026, 6, 22, 12, 0, 0), // Wednesday noon UTC
    classNames: ['person'],
    confidence: 0.9,
    zones: ['zone-a'],
    trackId: 'trk-1',
    ...overrides,
  }
}

function makeObjectEvent(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    id: 100_001,
    kind: 'object',
    deviceId: 104,
    timestamp: 111,
    trackId: 'trk-1',
    className: 'person',
    confidence: 0.87,
    zones: ['drive'],
    label: 'John',
    ...overrides,
  }
}

function makeTrack(overrides: Partial<Track> = {}): Track {
  return {
    trackId: 'trk-9',
    deviceId: 102,
    className: 'vehicle',
    firstSeen: 100,
    lastSeen: 900,
    positions: [],
    snapshots: [],
    zonesVisited: ['gate', 'lawn'],
    classes: ['vehicle', 'car'],
    totalDistance: 0.4,
    state: 'left',
    active: false,
    label: 'AB123CD',
    ...overrides,
  }
}

// ── subjects ────────────────────────────────────────────────────────

describe('subject builders', () => {
  it('maps an object event (class, label, confidence, zones, trackId, source)', () => {
    const s = subjectFromObjectEvent(makeObjectEvent())
    expect(s).toEqual({
      kind: 'object-event',
      recordId: '100001',
      deviceId: 104,
      timestamp: 111,
      classNames: ['person'],
      label: 'John',
      confidence: 0.87,
      zones: ['drive'],
      trackId: 'trk-1',
      // absent record source normalizes to `pipeline` (schema default).
      source: 'pipeline',
    })
  })

  it('object event without zones/label/confidence yields safe defaults', () => {
    const ev = makeObjectEvent()
    const { zones: _z, label: _l, confidence: _c, ...rest } = ev
    const s = subjectFromObjectEvent({ ...rest, kind: 'object' })
    expect(s.zones).toEqual([])
    expect(s.label).toBeUndefined()
    expect(s.confidence).toBeUndefined()
    // No lifespan on an object-event subject.
    expect(s.dwellSeconds).toBeUndefined()
    // No label-match confidence carried on the persisted event (P1 boundary).
    expect(s.labelConfidence).toBeUndefined()
  })

  it('carries the object event importance + explicit source (onboard)', () => {
    const s = subjectFromObjectEvent(makeObjectEvent({ importance: 0.72, source: 'onboard' }))
    expect(s.importance).toBe(0.72)
    expect(s.source).toBe('onboard')
  })

  it('object event without importance leaves it undefined (never guess)', () => {
    expect(subjectFromObjectEvent(makeObjectEvent()).importance).toBeUndefined()
  })

  it('maps a track (classes set, zonesVisited, lastSeen, bestConfidence, dwell)', () => {
    const s = subjectFromTrack(makeTrack({ importance: 0.6 }), {
      bestConfidence: 0.77,
      labelConfidence: 0.91,
    })
    expect(s.kind).toBe('track-end')
    expect(s.recordId).toBe('trk-9')
    expect(s.classNames).toEqual(['vehicle', 'car'])
    expect(s.zones).toEqual(['gate', 'lawn'])
    expect(s.timestamp).toBe(900)
    expect(s.confidence).toBe(0.77)
    // (lastSeen 900 − firstSeen 100) / 1000
    expect(s.dwellSeconds).toBeCloseTo(0.8)
    expect(s.importance).toBe(0.6)
    expect(s.labelConfidence).toBe(0.91)
    // Track provenance passes through (absent ⇒ pipeline handled elsewhere).
    expect(s.source).toBe('pipeline')
  })

  it('maps a sensor track source', () => {
    expect(subjectFromTrack(makeTrack({ source: 'sensor' })).source).toBe('sensor')
  })

  /**
   * The notification path is UNCHANGED by the synthetic-row `classes[]` seed.
   *
   * `projectSensorMarkers` / the audio projector now write `classes: [kind]`
   * on a synthetic row, so the hub's class filter can select one by its kind
   * (it could not: the column was NULL and the SQL prefilter keeps a row it
   * cannot read, so every class selection returned every synthetic row and
   * none selected one). That column is also what this subject reads.
   *
   * It cannot move a rule, because `className` on a synthetic row IS the kind
   * and this builder already fell back to `[className]` when the column was
   * absent — the two branches produce the identical subject. Pinned here
   * rather than asserted in a report: a rule that fires on an audio event must
   * keep firing exactly as it does today, and a viewing preference must never
   * be the reason it stops.
   */
  it('a synthetic row produces the SAME subject with and without classes[]', () => {
    const stamped = subjectFromTrack(
      makeTrack({ className: 'contact', classes: ['contact'], source: 'sensor' }),
    )
    const legacy = makeTrack({ className: 'contact', source: 'sensor' })
    const { classes: _dropped, ...withoutColumn } = legacy
    expect(subjectFromTrack({ ...withoutColumn })).toEqual(stamped)
    expect(stamped.classNames).toEqual(['contact'])
  })

  it('an audio row still reaches a rule as audio — hiding it is a VIEW concern', () => {
    const s = subjectFromTrack(
      makeTrack({ className: 'audio', classes: ['audio'], source: 'audio' }),
    )
    // Both discriminators a rule can target survive: the source stamp and the
    // taxonomy macro D189 put on every audio row.
    expect(s.source).toBe('audio')
    expect(s.classNames).toEqual(['audio'])
  })

  it('track without classes[] falls back to className', () => {
    const track = makeTrack()
    const { classes: _cl, ...rest } = track
    const s = subjectFromTrack({ ...rest })
    expect(s.classNames).toEqual(['vehicle'])
    expect(s.confidence).toBeUndefined()
    // labelConfidence absent when no close-time info is threaded.
    expect(s.labelConfidence).toBeUndefined()
  })
})

// ── delivery gating ─────────────────────────────────────────────────

describe('delivery gating', () => {
  it('immediate rule only matches object-event subjects', () => {
    const rule = makeRule({ delivery: 'immediate' })
    expect(evaluateRule(rule, makeSubject()).matched).toBe(true)
    const trackSubject = makeSubject({ kind: 'track-end' })
    expect(evaluateRule(rule, trackSubject)).toEqual({
      matched: false,
      failedCondition: 'delivery',
    })
  })

  it('D142 removed: an immediate identity rule never matches a track-end subject (no deferred exception)', () => {
    // A stored rule may still carry the retired `waitForEnhancement: true`; it is inert.
    const rule = makeRule({
      delivery: 'immediate',
      waitForEnhancement: true,
      conditions: { identities: ['Alice'] },
    })
    expect(evaluateRule(rule, makeSubject({ kind: 'track-end', label: 'alice' }))).toEqual({
      matched: false,
      failedCondition: 'delivery',
    })
  })

  it('track-end rule only matches track-end subjects', () => {
    const rule = makeRule({ delivery: 'track-end' })
    expect(evaluateRule(rule, makeSubject({ kind: 'track-end' })).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject()).failedCondition).toBe('delivery')
  })
})

// ── condition groups ────────────────────────────────────────────────

describe('device scope', () => {
  it('passes when the device is listed, fails otherwise', () => {
    const rule = makeRule({ conditions: { devices: [104, 102] } })
    expect(evaluateRule(rule, makeSubject({ deviceId: 102 })).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject({ deviceId: 999 }))).toEqual({
      matched: false,
      failedCondition: 'devices',
    })
  })

  it('an empty devices list means all devices', () => {
    const rule = makeRule({ conditions: { devices: [] } })
    expect(evaluateRule(rule, makeSubject({ deviceId: 12345 })).matched).toBe(true)
  })
})

describe('classes', () => {
  it('any overlap passes (case-insensitive)', () => {
    const rule = makeRule({ conditions: { classes: ['Person', 'dog'] } })
    expect(evaluateRule(rule, makeSubject({ classNames: ['person'] })).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject({ classNames: ['vehicle'] })).failedCondition).toBe(
      'classes',
    )
  })

  it('multi-class track subject matches on any of its classes', () => {
    const rule = makeRule({ delivery: 'track-end', conditions: { classes: ['car'] } })
    const s = makeSubject({ kind: 'track-end', classNames: ['vehicle', 'car'] })
    expect(evaluateRule(rule, s).matched).toBe(true)
  })

  it('classesExclude vetoes on any overlap', () => {
    const rule = makeRule({ conditions: { classesExclude: ['animal'] } })
    expect(
      evaluateRule(rule, makeSubject({ classNames: ['person', 'animal'] })).failedCondition,
    ).toBe('classesExclude')
    expect(evaluateRule(rule, makeSubject({ classNames: ['person'] })).matched).toBe(true)
  })
})

describe('minConfidence', () => {
  const rule = makeRule({ conditions: { minConfidence: 0.8 } })

  it('passes at or above the threshold', () => {
    expect(evaluateRule(rule, makeSubject({ confidence: 0.8 })).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject({ confidence: 0.95 })).matched).toBe(true)
  })

  it('fails below the threshold', () => {
    expect(evaluateRule(rule, makeSubject({ confidence: 0.79 })).failedCondition).toBe(
      'minConfidence',
    )
  })

  it('fails when the record carries no confidence (never guess quality)', () => {
    const s = makeSubject()
    const { confidence: _c, ...rest } = s
    expect(evaluateRule(rule, rest).failedCondition).toBe('minConfidence')
  })
})

describe('zones', () => {
  it("match 'any' passes on one hit", () => {
    const rule = makeRule({ conditions: { zones: { ids: ['zone-a', 'zone-b'] } } })
    expect(evaluateRule(rule, makeSubject({ zones: ['zone-b'] })).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject({ zones: ['zone-c'] })).failedCondition).toBe('zones')
  })

  it("match 'all' requires every id", () => {
    const rule = makeRule({
      conditions: { zones: { ids: ['zone-a', 'zone-b'], match: 'all' } },
    })
    expect(evaluateRule(rule, makeSubject({ zones: ['zone-a', 'zone-b', 'x'] })).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject({ zones: ['zone-a'] })).failedCondition).toBe('zones')
  })

  it('a subject with no zones fails a zones condition', () => {
    const rule = makeRule({ conditions: { zones: { ids: ['zone-a'] } } })
    expect(evaluateRule(rule, makeSubject({ zones: [] })).failedCondition).toBe('zones')
  })

  it('zonesExclude vetoes on any hit', () => {
    const rule = makeRule({ conditions: { zonesExclude: ['private'] } })
    expect(evaluateRule(rule, makeSubject({ zones: ['drive', 'private'] })).failedCondition).toBe(
      'zonesExclude',
    )
    expect(evaluateRule(rule, makeSubject({ zones: ['drive'] })).matched).toBe(true)
  })
})

describe('label / identity matchers', () => {
  it('labelEquals matches case-insensitively', () => {
    const rule = makeRule({ conditions: { labelEquals: ['John'] } })
    expect(evaluateRule(rule, makeSubject({ label: 'john' })).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject({ label: 'Jane' })).failedCondition).toBe('labelEquals')
  })

  it('labelEquals fails when the record has no label', () => {
    const rule = makeRule({ conditions: { labelEquals: ['John'] } })
    expect(evaluateRule(rule, makeSubject()).failedCondition).toBe('labelEquals')
  })

  it('identities match against the collapsed label (P1 boundary)', () => {
    const rule = makeRule({ conditions: { identities: ['Alice', 'Bob'] } })
    expect(evaluateRule(rule, makeSubject({ label: 'bob' })).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject({ label: 'Mallory' })).failedCondition).toBe('identities')
  })
})

describe('plate matcher', () => {
  it('normalizePlate strips separators and uppercases', () => {
    expect(normalizePlate('ab-123 cd')).toBe('AB123CD')
  })

  it('levenshtein basics', () => {
    expect(levenshtein('', '')).toBe(0)
    expect(levenshtein('abc', 'abc')).toBe(0)
    expect(levenshtein('abc', '')).toBe(3)
    expect(levenshtein('kitten', 'sitting')).toBe(3)
    expect(levenshtein('AB123CD', 'AB123C0')).toBe(1)
  })

  it('matchesPlate tolerates one OCR error at maxDistance 1', () => {
    expect(matchesPlate('AB123C0', ['AB123CD'], 1)).toBe(true)
    expect(matchesPlate('XY999ZZ', ['AB123CD'], 1)).toBe(false)
    expect(matchesPlate('', ['AB123CD'], 1)).toBe(false)
  })

  it('maxDistance 0 requires an exact normalized match', () => {
    const rule = makeRule({
      conditions: { plates: { values: ['AB-123-CD'], maxDistance: 0 } },
    })
    expect(evaluateRule(rule, makeSubject({ label: 'ab123cd' })).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject({ label: 'ab123c0' })).failedCondition).toBe('plates')
  })

  it('plate condition fails when the record has no label', () => {
    const rule = makeRule({ conditions: { plates: { values: ['AB123CD'] } } })
    expect(evaluateRule(rule, makeSubject()).failedCondition).toBe('plates')
  })
})

// ── B1 conditions: importance / dwell / source / label-confidence / identity-exclude

describe('minImportance', () => {
  const rule = makeRule({ conditions: { minImportance: 0.5 } })

  it('passes at or above the threshold', () => {
    expect(evaluateRule(rule, makeSubject({ importance: 0.5 })).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject({ importance: 0.9 })).matched).toBe(true)
  })

  it('fails below the threshold', () => {
    expect(evaluateRule(rule, makeSubject({ importance: 0.49 })).failedCondition).toBe(
      'minImportance',
    )
  })

  it('fails when the record carries no importance (never guess)', () => {
    expect(evaluateRule(rule, makeSubject()).failedCondition).toBe('minImportance')
  })
})

describe('minDwellSeconds', () => {
  const rule = makeRule({ delivery: 'track-end', conditions: { minDwellSeconds: 30 } })

  it('passes when the track lifespan meets the threshold', () => {
    const s = makeSubject({ kind: 'track-end', dwellSeconds: 45 })
    expect(evaluateRule(rule, s).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject({ kind: 'track-end', dwellSeconds: 30 })).matched).toBe(
      true,
    )
  })

  it('fails when the track was too short', () => {
    const s = makeSubject({ kind: 'track-end', dwellSeconds: 12 })
    expect(evaluateRule(rule, s).failedCondition).toBe('minDwellSeconds')
  })

  it('never matches for an immediate (object-event) subject — no full lifespan', () => {
    // Documented boundary: an object-event subject carries no dwell, so a
    // dwell condition on an immediate rule fails (before delivery gating,
    // an object-event subject has no dwellSeconds at all).
    const immediateRule = makeRule({ delivery: 'immediate', conditions: { minDwellSeconds: 5 } })
    expect(evaluateRule(immediateRule, makeSubject()).failedCondition).toBe('minDwellSeconds')
  })

  it('fails a track subject that somehow carries no dwell', () => {
    const s = makeSubject({ kind: 'track-end' })
    const { dwellSeconds: _d, ...rest } = s
    expect(evaluateRule(rule, rest).failedCondition).toBe('minDwellSeconds')
  })
})

describe('source', () => {
  it('matches the exact source', () => {
    const rule = makeRule({ conditions: { source: 'onboard' } })
    expect(evaluateRule(rule, makeSubject({ source: 'onboard' })).matched).toBe(true)
    expect(evaluateRule(rule, makeSubject({ source: 'pipeline' })).failedCondition).toBe('source')
  })

  it("'any' (and absent) matches every source", () => {
    const any = makeRule({ conditions: { source: 'any' } })
    expect(evaluateRule(any, makeSubject({ source: 'sensor' })).matched).toBe(true)
    const none = makeRule({ conditions: {} })
    expect(evaluateRule(none, makeSubject({ source: 'sensor' })).matched).toBe(true)
  })

  it('treats a subject with no source as pipeline', () => {
    const rule = makeRule({ conditions: { source: 'pipeline' } })
    const s = makeSubject()
    const { source: _s, ...rest } = s
    expect(evaluateRule(rule, rest).matched).toBe(true)
    const onboardRule = makeRule({ conditions: { source: 'onboard' } })
    expect(evaluateRule(onboardRule, rest).failedCondition).toBe('source')
  })

  it('matches a sensor-sourced track', () => {
    const rule = makeRule({ delivery: 'track-end', conditions: { source: 'sensor' } })
    expect(evaluateRule(rule, makeSubject({ kind: 'track-end', source: 'sensor' })).matched).toBe(
      true,
    )
  })
})

describe('minLabelConfidence', () => {
  const rule = makeRule({ delivery: 'track-end', conditions: { minLabelConfidence: 0.8 } })

  it('passes at or above the threshold', () => {
    const s = makeSubject({ kind: 'track-end', labelConfidence: 0.8 })
    expect(evaluateRule(rule, s).matched).toBe(true)
  })

  it('fails below the threshold', () => {
    const s = makeSubject({ kind: 'track-end', labelConfidence: 0.5 })
    expect(evaluateRule(rule, s).failedCondition).toBe('minLabelConfidence')
  })

  it('fails when the subject carries no label-match confidence (never guess)', () => {
    expect(evaluateRule(rule, makeSubject({ kind: 'track-end' })).failedCondition).toBe(
      'minLabelConfidence',
    )
  })
})

describe('identitiesExclude', () => {
  const rule = makeRule({ conditions: { identitiesExclude: ['Alice', 'Bob'] } })

  it('vetoes when the label matches an excluded identity (case-insensitive)', () => {
    expect(evaluateRule(rule, makeSubject({ label: 'bob' })).failedCondition).toBe(
      'identitiesExclude',
    )
  })

  it('passes when the label is not excluded', () => {
    expect(evaluateRule(rule, makeSubject({ label: 'Carol' })).matched).toBe(true)
  })

  it('passes when the record has no label (nothing to exclude)', () => {
    expect(evaluateRule(rule, makeSubject()).matched).toBe(true)
  })
})

// ── schedules ───────────────────────────────────────────────────────

describe('schedules', () => {
  // 2026-07-22 is a Wednesday (day 3).
  const wedNoonUtc = Date.UTC(2026, 6, 22, 12, 0, 0)
  const wedLateUtc = Date.UTC(2026, 6, 22, 23, 30, 0)
  const thuEarlyUtc = Date.UTC(2026, 6, 23, 1, 30, 0)

  it('no schedule = always active', () => {
    expect(isScheduleActive(undefined, wedNoonUtc)).toBe(true)
  })

  it('inside/outside a same-day window (UTC)', () => {
    const schedule = {
      windows: [{ days: [3], startMinute: 9 * 60, endMinute: 17 * 60 }],
      timezone: 'UTC',
    }
    expect(isScheduleActive(schedule, wedNoonUtc)).toBe(true)
    expect(isScheduleActive(schedule, wedLateUtc)).toBe(false)
  })

  it('a window on other days does not match', () => {
    const schedule = {
      windows: [{ days: [0, 6], startMinute: 0, endMinute: 1439 }],
      timezone: 'UTC',
    }
    expect(isScheduleActive(schedule, wedNoonUtc)).toBe(false)
  })

  it('endMinute is exclusive', () => {
    const schedule = {
      windows: [{ days: [3], startMinute: 0, endMinute: 12 * 60 }],
      timezone: 'UTC',
    }
    expect(isScheduleActive(schedule, wedNoonUtc)).toBe(false)
  })

  it('midnight-crossing window spills into the next day', () => {
    // Wed 23:00 → Thu 03:00 (start > end crosses midnight).
    const schedule = {
      windows: [{ days: [3], startMinute: 23 * 60, endMinute: 3 * 60 }],
      timezone: 'UTC',
    }
    expect(isScheduleActive(schedule, wedLateUtc)).toBe(true) // Wed 23:30
    expect(isScheduleActive(schedule, thuEarlyUtc)).toBe(true) // Thu 01:30
    expect(isScheduleActive(schedule, wedNoonUtc)).toBe(false)
    // Thu 04:00 — past the spill end.
    expect(isScheduleActive(schedule, Date.UTC(2026, 6, 23, 4, 0, 0))).toBe(false)
  })

  it('invert flips the window', () => {
    const schedule = {
      windows: [{ days: [3], startMinute: 9 * 60, endMinute: 17 * 60 }],
      timezone: 'UTC',
      invert: true,
    }
    expect(isScheduleActive(schedule, wedNoonUtc)).toBe(false)
    expect(isScheduleActive(schedule, wedLateUtc)).toBe(true)
  })

  it('timezone shifts the local window (UTC noon = 14:00 in Rome, July)', () => {
    const schedule = {
      windows: [{ days: [3], startMinute: 13 * 60 + 30, endMinute: 15 * 60 }],
      timezone: 'Europe/Rome',
    }
    expect(isScheduleActive(schedule, wedNoonUtc)).toBe(true)
    const utcSchedule = { ...schedule, timezone: 'UTC' }
    expect(isScheduleActive(utcSchedule, wedNoonUtc)).toBe(false)
  })

  it('an invalid timezone never throws', () => {
    const schedule = {
      windows: [{ days: [0, 1, 2, 3, 4, 5, 6], startMinute: 0, endMinute: 1439 }],
      timezone: 'Not/AZone',
    }
    expect(typeof isScheduleActive(schedule, wedNoonUtc)).toBe('boolean')
  })

  it('rule evaluation applies the schedule at the SUBJECT timestamp', () => {
    const rule = makeRule({
      schedule: { windows: [{ days: [3], startMinute: 0, endMinute: 720 }], timezone: 'UTC' },
    })
    expect(
      evaluateRule(rule, makeSubject({ timestamp: Date.UTC(2026, 6, 22, 6, 0, 0) })).matched,
    ).toBe(true)
    expect(evaluateRule(rule, makeSubject({ timestamp: wedLateUtc }))).toEqual({
      matched: false,
      failedCondition: 'schedule',
    })
  })
})

// ── B2: device-event trigger ────────────────────────────────────────

function makeSensorEvent(overrides: Partial<SensorEvent> = {}): SensorEvent {
  return {
    id: 'se-1',
    deviceId: 104,
    sourceDeviceId: 42,
    kind: 'doorbell',
    value: null,
    timestamp: Date.UTC(2026, 6, 22, 12, 0, 0),
    ...overrides,
  }
}

describe('subjectFromSensorEvent', () => {
  it('builds a device-event subject (camera id, sensor kind, sensor source)', () => {
    const s = subjectFromSensorEvent(makeSensorEvent())
    expect(s.kind).toBe('device-event')
    expect(s.deviceId).toBe(104)
    expect(s.sensorKind).toBe('doorbell')
    expect(s.source).toBe('sensor')
    expect(s.classNames).toEqual([])
    expect(s.eventType).toBeUndefined()
  })

  it('extracts the event-emitter eventType token from the slice', () => {
    const s = subjectFromSensorEvent(
      makeSensorEvent({
        kind: 'device-event',
        value: { lastEvent: { eventType: 'press_long' }, eventTypes: [] },
      }),
    )
    expect(s.eventType).toBe('press_long')
  })

  it('readSensorEventType is defensive over the untyped slice', () => {
    expect(readSensorEventType(null)).toBeUndefined()
    expect(readSensorEventType({ lastEvent: null })).toBeUndefined()
    expect(readSensorEventType({ lastEvent: { eventType: '' } })).toBeUndefined()
    expect(readSensorEventType({ lastEvent: { eventType: 'press' } })).toBe('press')
  })

  it('CARRIES the sensor as well as the camera', () => {
    // The row is attributed to the camera because that is where the picture
    // comes from; the sensor is the device the operator named. Dropping it is
    // what made a sensor-scoped rule unmatched.
    const s = subjectFromSensorEvent(makeSensorEvent())
    expect(s.deviceId).toBe(104)
    expect(s.sourceDeviceId).toBe(42)
  })

  it('omits the sensor when it IS the attributed device', () => {
    // A redundant field reads as a second identity.
    const s = subjectFromSensorEvent(makeSensorEvent({ deviceId: 42, sourceDeviceId: 42 }))
    expect(s.sourceDeviceId).toBeUndefined()
  })
})

/**
 * The gap the Devices tab exposed: it offers all 293 devices, an operator picks
 * their front-door contact, and until now the resulting rule could never match
 * — the engine compared the scope against the CAMERA the row was attributed
 * to, and the sensor id appeared nowhere on the subject.
 */
describe('device scope resolves the sensor as well as its camera', () => {
  const rule = (devices: readonly number[]): NcRule =>
    makeRule({ delivery: 'device-event', conditions: { devices: [...devices] } })

  it('matches a rule that names the SENSOR', () => {
    expect(evaluateRule(rule([42]), subjectFromSensorEvent(makeSensorEvent())).matched).toBe(true)
  })

  it('still matches a rule that names the CAMERA', () => {
    // The pre-existing behaviour, which must not change: "anything on this
    // camera" is the other way an operator authors the same intent.
    expect(evaluateRule(rule([104]), subjectFromSensorEvent(makeSensorEvent())).matched).toBe(true)
  })

  it('names the `devices` condition when NEITHER id is in scope', () => {
    const res = evaluateRule(rule([999]), subjectFromSensorEvent(makeSensorEvent()))
    expect(res.matched).toBe(false)
    expect(res.failedCondition).toBe('devices')
  })

  it('does not widen a rule on a subject with no sensor', () => {
    // An object event has one device and one only — a `devices` rule must not
    // start matching on some other id because a sibling kind carries two.
    expect(evaluateRule(makeRule({ conditions: { devices: [42] } }), makeSubject()).matched).toBe(
      false,
    )
  })

  it('fires ONCE PER LINKED CAMERA for one sensor event', () => {
    // The fan-out is at ingest, not here: one door opening persists a row per
    // linked camera, so a sensor-scoped rule is evaluated once for each. The
    // rule's own throttle is what collapses that; the engine must not pretend
    // otherwise.
    const r = rule([42])
    const rows = [makeSensorEvent({ deviceId: 104 }), makeSensorEvent({ deviceId: 101 })]
    expect(rows.map((ev) => evaluateRule(r, subjectFromSensorEvent(ev)).matched)).toEqual([
      true,
      true,
    ])
  })
})

describe('device-event evaluation', () => {
  const rule = (conditions: Record<string, unknown> = {}): NcRule =>
    makeRule({ delivery: 'device-event', conditions })

  it('a device-event rule fires only on a device-event subject', () => {
    const r = rule()
    expect(evaluateRule(r, subjectFromSensorEvent(makeSensorEvent())).matched).toBe(true)
    expect(evaluateRule(r, makeSubject()).failedCondition).toBe('delivery')
  })

  it('sensorKinds gates the taxonomy kind (OR, case-insensitive)', () => {
    const r = rule({ sensorKinds: ['Doorbell', 'contact'] })
    expect(evaluateRule(r, subjectFromSensorEvent(makeSensorEvent())).matched).toBe(true)
    expect(
      evaluateRule(r, subjectFromSensorEvent(makeSensorEvent({ kind: 'motion-sensor' })))
        .failedCondition,
    ).toBe('sensorKinds')
  })

  it('eventTypeTokens fails a subject with no token; matches when present', () => {
    const r = rule({ eventTypeTokens: ['press_long'] })
    // doorbell pulse carries no eventType
    expect(evaluateRule(r, subjectFromSensorEvent(makeSensorEvent())).failedCondition).toBe(
      'eventTypeTokens',
    )
    const withToken = subjectFromSensorEvent(
      makeSensorEvent({ kind: 'device-event', value: { lastEvent: { eventType: 'press_long' } } }),
    )
    expect(evaluateRule(r, withToken).matched).toBe(true)
  })

  it('a device deviceIds filter applies to device-event rules', () => {
    const r = rule({ devices: [1] })
    expect(evaluateRule(r, subjectFromSensorEvent(makeSensorEvent())).failedCondition).toBe(
      'devices',
    )
  })
})

// ── B2: package-event trigger ───────────────────────────────────────

function makePackageEvent(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    id: 90_002,
    kind: 'object',
    deviceId: 104,
    timestamp: Date.UTC(2026, 6, 22, 12, 0, 0),
    className: 'package',
    state: 'idle',
    zones: ['porch'],
    confidence: 1,
    importance: 1,
    ...overrides,
  }
}

describe('package-event evaluation', () => {
  const rule = (conditions: Record<string, unknown> = {}): NcRule =>
    makeRule({ delivery: 'package-event', conditions })

  it('builds a package-event subject with the given phase', () => {
    const s = subjectFromPackageEvent(makePackageEvent(), 'delivered')
    expect(s.kind).toBe('package-event')
    expect(s.packagePhase).toBe('delivered')
    expect(s.classNames).toEqual(['package'])
    expect(s.zones).toEqual(['porch'])
  })

  it('fires only on a package-event subject', () => {
    const r = rule()
    expect(evaluateRule(r, subjectFromPackageEvent(makePackageEvent(), 'delivered')).matched).toBe(
      true,
    )
    expect(evaluateRule(r, makeSubject()).failedCondition).toBe('delivery')
  })

  it('packagePhase gates delivered vs picked-up; both matches either', () => {
    const delivered = subjectFromPackageEvent(makePackageEvent(), 'delivered')
    const pickedUp = subjectFromPackageEvent(makePackageEvent(), 'picked-up')
    expect(evaluateRule(rule({ packagePhase: 'delivered' }), delivered).matched).toBe(true)
    expect(evaluateRule(rule({ packagePhase: 'delivered' }), pickedUp).failedCondition).toBe(
      'packagePhase',
    )
    expect(evaluateRule(rule({ packagePhase: 'both' }), pickedUp).matched).toBe(true)
    expect(evaluateRule(rule({ packagePhase: 'both' }), delivered).matched).toBe(true)
  })

  it('zone + class conditions still apply to package subjects', () => {
    const r = rule({ zones: { ids: ['garage'] } })
    expect(
      evaluateRule(r, subjectFromPackageEvent(makePackageEvent(), 'delivered')).failedCondition,
    ).toBe('zones')
  })

  /**
   * The two phases must not share a cooldown window. A system event carries
   * its direction into the key for exactly this reason (D141: a recovery is
   * not eaten by the outage) — a parcel needs the same, or a package snatched
   * inside the rule's cooldown is notified only as delivered and the pick-up
   * is lost silently.
   */
  it('gives delivery and pick-up their own cooldown window, in both scopes', () => {
    const delivered = subjectFromPackageEvent(makePackageEvent(), 'delivered')
    const pickedUp = subjectFromPackageEvent(makePackageEvent(), 'picked-up')
    for (const scope of ['rule', 'rule-device'] as const) {
      const r = makeRule({
        delivery: 'package-event',
        throttle: { scope, cooldownSec: 60 },
      })
      expect(cooldownKey(r, delivered)).not.toBe(cooldownKey(r, pickedUp))
    }
  })
})

// ── condition catalog ───────────────────────────────────────────────

describe('condition catalog', () => {
  it('advertises the B1 conditions so the editor renders them', () => {
    const ids = new Set(NC_CONDITION_CATALOG.map((d) => d.id))
    for (const id of [
      'minImportance',
      'minDwellSeconds',
      'source',
      'minLabelConfidence',
      'identitiesExclude',
    ]) {
      expect(ids.has(id)).toBe(true)
    }
    const dwell = NC_CONDITION_CATALOG.find((d) => d.id === 'minDwellSeconds')
    // Track-end only — an immediate subject has no lifespan.
    expect(dwell?.appliesTo).toEqual(['track-end'])
  })

  it('advertises the B2 device/package conditions scoped to their trigger', () => {
    const byId = new Map(NC_CONDITION_CATALOG.map((d) => [d.id, d]))
    expect(byId.get('sensorKinds')?.appliesTo).toEqual(['device-event'])
    expect(byId.get('eventTypeTokens')?.appliesTo).toEqual(['device-event'])
    expect(byId.get('sensorKinds')?.group).toBe('device')
    expect(byId.get('packagePhase')?.appliesTo).toEqual(['package-event'])
    expect(byId.get('packagePhase')?.group).toBe('package')
    expect(byId.get('packagePhase')?.valueType).toBe('packagePhase')
    // minLabelConfidence is no longer advertised as INERT.
    expect(byId.get('minLabelConfidence')?.description).not.toMatch(/INERT/i)
  })
})

// ── AND semantics / failure ordering ────────────────────────────────

describe('condition-set AND semantics', () => {
  it('all present groups must pass; first failing group is reported', () => {
    const rule = makeRule({
      conditions: {
        devices: [104],
        classes: ['person'],
        minConfidence: 0.5,
        zones: { ids: ['zone-a'] },
      },
    })
    expect(evaluateRule(rule, makeSubject()).matched).toBe(true)
    // Fails devices first even though classes would also fail.
    const miss = makeSubject({ deviceId: 1, classNames: ['vehicle'] })
    expect(evaluateRule(rule, miss).failedCondition).toBe('devices')
  })

  it('an empty condition set always matches (delivery + schedule permitting)', () => {
    expect(evaluateRule(makeRule(), makeSubject()).matched).toBe(true)
  })
})

// ── throttle helpers ────────────────────────────────────────────────

describe('cooldown helpers', () => {
  it("scope 'rule' shares one key across devices", () => {
    const rule = makeRule({ throttle: { cooldownSec: 60, scope: 'rule' } })
    expect(cooldownKey(rule, makeSubject({ deviceId: 1 }))).toBe(
      cooldownKey(rule, makeSubject({ deviceId: 2 })),
    )
  })

  it("scope 'rule-device' keys per device (camera B never muted by camera A)", () => {
    const rule = makeRule({ throttle: { cooldownSec: 60, scope: 'rule-device' } })
    expect(cooldownKey(rule, makeSubject({ deviceId: 1 }))).not.toBe(
      cooldownKey(rule, makeSubject({ deviceId: 2 })),
    )
  })

  it('isCoolingDown respects the window boundaries', () => {
    const rule = makeRule({ throttle: { cooldownSec: 60, scope: 'rule' } })
    expect(isCoolingDown(rule, undefined, 100_000)).toBe(false)
    expect(isCoolingDown(rule, 50_000, 100_000)).toBe(true) // 50s ago
    expect(isCoolingDown(rule, 40_000, 100_000)).toBe(false) // exactly 60s ago
  })

  it('cooldownSec 0 never throttles', () => {
    const rule = makeRule({ throttle: { cooldownSec: 0, scope: 'rule' } })
    expect(isCoolingDown(rule, 99_999, 100_000)).toBe(false)
  })

  it('two provisional track ids of one subject share one cooldown window (D683 round 4: the NC owns duplicates)', () => {
    // Tracker v2 gives a re-appearance a new provisional id and fuses it later
    // (D683). The operator ruled there is no hold: the NC's cooldown must
    // treat both ids as one subject on one camera. It does, because the key
    // never contains a track id — pin that.
    for (const scope of ['rule', 'rule-device'] as const) {
      const rule = makeRule({ throttle: { cooldownSec: 60, scope } })
      const first = makeSubject({ deviceId: 101, recordId: 'ev-1', trackId: 't2' })
      const later = makeSubject({ deviceId: 101, recordId: 'ev-2', trackId: 't1' })
      expect([scope, cooldownKey(rule, first)]).toEqual([scope, cooldownKey(rule, later)])
    }
  })
})

// ── cooldown granularity (same-class minimum delay) ─────────────────

describe('cooldown granularity', () => {
  it('DEFAULT (unset) is byte-identical to an explicit per-class key, since 2026-10-01 (D36)', () => {
    // The literal strings, not just "equal for two classes": an UNSET rule now
    // reads exactly like `granularity: 'per-class'` — the operator's default —
    // new rules and existing (previously `shared`-reading) rules alike.
    const unset = makeRule({ throttle: { cooldownSec: 60, scope: 'rule-device' } })
    const explicit = makeRule({
      throttle: { cooldownSec: 60, scope: 'rule-device', granularity: 'per-class' },
    })
    expect(cooldownKey(unset, makeSubject({ classNames: ['cat'] }))).toBe(
      cooldownKey(explicit, makeSubject({ classNames: ['cat'] })),
    )
    const unsetRuleScope = makeRule({ throttle: { cooldownSec: 60, scope: 'rule' } })
    expect(cooldownKey(unsetRuleScope, makeSubject({ classNames: ['cat'] }))).toBe('r:rule-1:c:cat')
  })

  it('DEFAULT (unset) separates cat from dog — a cat no longer mutes the next dog', () => {
    const rule = makeRule({ throttle: { cooldownSec: 60, scope: 'rule-device' } })
    expect(cooldownKey(rule, makeSubject({ classNames: ['cat'] }))).not.toBe(
      cooldownKey(rule, makeSubject({ classNames: ['dog'] })),
    )
  })

  it("explicit 'shared' reproduces the pre-2026-10-01 class-agnostic key byte for byte", () => {
    // The literal strings: a `shared` rule's persisted `lastFiredAt` is
    // addressed by this key, and an operator who asked for one window across
    // every class must keep getting it.
    const shared = makeRule({
      throttle: { cooldownSec: 60, scope: 'rule-device', granularity: 'shared' },
    })
    expect(cooldownKey(shared, makeSubject({ classNames: ['cat'] }))).toBe('r:rule-1:d:104')
    const ruleScope = makeRule({
      throttle: { cooldownSec: 60, scope: 'rule', granularity: 'shared' },
    })
    expect(cooldownKey(ruleScope, makeSubject({ classNames: ['cat'] }))).toBe('r:rule-1')
  })

  it("explicit 'shared' lets a cat mute the next dog", () => {
    const rule = makeRule({
      throttle: { cooldownSec: 60, scope: 'rule-device', granularity: 'shared' },
    })
    expect(cooldownKey(rule, makeSubject({ classNames: ['cat'] }))).toBe(
      cooldownKey(rule, makeSubject({ classNames: ['dog'] })),
    )
  })

  it("'per-class' separates the windows: cat→dog fires, cat→cat waits", () => {
    const rule = makeRule({
      throttle: { cooldownSec: 60, scope: 'rule-device', granularity: 'per-class' },
    })
    expect(cooldownKey(rule, makeSubject({ classNames: ['cat'] }))).not.toBe(
      cooldownKey(rule, makeSubject({ classNames: ['dog'] })),
    )
    expect(cooldownKey(rule, makeSubject({ classNames: ['cat'] }))).toBe(
      cooldownKey(rule, makeSubject({ classNames: ['cat'], recordId: 'ev-2' })),
    )
  })

  it("'per-class' still keys per device under scope 'rule-device'", () => {
    const rule = makeRule({
      throttle: { cooldownSec: 60, scope: 'rule-device', granularity: 'per-class' },
    })
    expect(cooldownKey(rule, makeSubject({ deviceId: 1, classNames: ['cat'] }))).not.toBe(
      cooldownKey(rule, makeSubject({ deviceId: 2, classNames: ['cat'] })),
    )
  })

  it("'per-class' under scope 'rule' shares the class window across cameras", () => {
    const rule = makeRule({
      throttle: { cooldownSec: 60, scope: 'rule', granularity: 'per-class' },
    })
    expect(cooldownKey(rule, makeSubject({ deviceId: 1, classNames: ['cat'] }))).toBe(
      'r:rule-1:c:cat',
    )
    expect(cooldownKey(rule, makeSubject({ deviceId: 2, classNames: ['cat'] }))).toBe(
      'r:rule-1:c:cat',
    )
  })

  it('AUDIO stays per-class regardless of the setting (a scream is not a bark)', () => {
    const rule = makeRule({ throttle: { cooldownSec: 60, scope: 'rule-device' } })
    const scream = makeSubject({ kind: 'audio-event', classNames: ['audio-scream'] })
    const bark = makeSubject({ kind: 'audio-event', classNames: ['audio-dog'] })
    expect(cooldownKey(rule, scream)).not.toBe(cooldownKey(rule, bark))
  })

  it('a classless subject degrades to the shared key rather than a bogus one', () => {
    const rule = makeRule({
      throttle: { cooldownSec: 60, scope: 'rule-device', granularity: 'per-class' },
    })
    expect(cooldownKey(rule, makeSubject({ kind: 'device-event', classNames: [] }))).toBe(
      'r:rule-1:d:104',
    )
  })

  it("a 'device-event' never keys per class, even if a reconstructed subject carries one", () => {
    // The default flip's regression: `cooldownSubjectFromOutbox` reconstructs
    // `classNames` from the outbox row's display `className`, which for a
    // device event is the SENSOR KIND (`subject.sensorKind`), not a real
    // detection class — `subjectFromSensorEvent` never sets one live. Before
    // `per-class` became the default this never surfaced, because it required
    // an explicit `granularity: 'per-class'` nobody wrote for a sensor rule.
    const rule = makeRule({ throttle: { cooldownSec: 60, scope: 'rule-device' } })
    const live = makeSubject({ kind: 'device-event', classNames: [] })
    const reconstructed = makeSubject({ kind: 'device-event', classNames: ['contact'] })
    expect(cooldownKey(rule, live)).toBe(cooldownKey(rule, reconstructed))
  })

  it("a 'system-event' never keys per class either, for the same reason", () => {
    const rule = makeRule({ throttle: { cooldownSec: 60, scope: 'rule-device' } })
    const live = makeSubject({
      kind: 'system-event',
      classNames: [],
      deviceId: 0,
      systemEvent: makeTestNcSystemEventSubject({
        kind: 'device-offline',
        subject: 'device:104',
      }),
    })
    const reconstructed = makeSubject({
      kind: 'system-event',
      classNames: ['event'],
      deviceId: 0,
      systemEvent: makeTestNcSystemEventSubject({
        kind: 'device-offline',
        subject: 'device:104',
      }),
    })
    expect(cooldownKey(rule, live)).toBe(cooldownKey(rule, reconstructed))
  })
})

// ── rule media (D897) ───────────────────────────────────────────────

describe('effectiveMediaPolicy — every kind resolves ONE picture mode (D897)', () => {
  it('a sensor rule goes through its own selector now — and keeps its stored extras', () => {
    const rule = makeRule({
      delivery: 'device-event',
      media: { image: 'scene-boxes', gif: true, clip: true },
    })
    expect(effectiveMediaPolicy(rule, 'sensor')).toEqual({
      image: 'scene-boxes',
      gif: true,
      clip: true,
    })
  })

  it('a sensor rule stored before D897 keeps the clean snapshot it always shipped', () => {
    const rule = makeRule({ delivery: 'device-event', media: { attach: 'best' } })
    expect(effectiveMediaPolicyForRule(rule).image).toBe('clean')
  })

  it('a detection rule reads its legacy triple through the same mapping as the migration', () => {
    const detection = makeRule({ media: { attach: 'best-matching', gif: true } })
    expect(effectiveMediaPolicy(detection, 'detection')).toEqual({
      attach: 'best-matching',
      gif: true,
      image: 'crop',
    })
  })
})

// ── matched-condition summary + best-matching media (slice E) ────────

describe('evaluateRule matchedOn summary', () => {
  it('a matched rule lists the PRESENT condition ids (why it fired)', () => {
    const rule = makeRule({ conditions: { classes: ['person'], identities: ['john'] } })
    const evaluation = evaluateRule(rule, makeSubject({ label: 'John' }))
    expect(evaluation.matched).toBe(true)
    expect(evaluation.matchedOn).toEqual(['classes', 'identities'])
  })

  it('a plate rule reports the plates condition', () => {
    const rule = makeRule({
      conditions: { plates: { values: ['AB123CD'], maxDistance: 1 } },
    })
    const evaluation = evaluateRule(rule, makeSubject({ label: 'AB123CD' }))
    expect(evaluation.matched).toBe(true)
    expect(evaluation.matchedOn).toEqual(['plates'])
  })

  it('a condition-free rule matches with an empty summary', () => {
    const evaluation = evaluateRule(makeRule(), makeSubject())
    expect(evaluation.matched).toBe(true)
    expect(evaluation.matchedOn).toEqual([])
  })

  it('a non-matching rule carries no summary', () => {
    const rule = makeRule({ conditions: { classes: ['vehicle'] } })
    const evaluation = evaluateRule(rule, makeSubject({ classNames: ['person'] }))
    expect(evaluation.matched).toBe(false)
    expect(evaluation.matchedOn).toBeUndefined()
  })
})

describe('presentConditionIds', () => {
  it('omits absent / empty / neutral groups', () => {
    expect(presentConditionIds({})).toEqual([])
    expect(presentConditionIds({ classes: [], source: 'any', packagePhase: 'both' })).toEqual([])
  })

  it('preserves catalog order', () => {
    expect(
      presentConditionIds({ plates: { values: ['A'], maxDistance: 1 }, classes: ['person'] }),
    ).toEqual(['classes', 'plates'])
  })
})
