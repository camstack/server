/**
 * Rule-engine custom-zone (polygon) evaluation (Task A4). Covers the pure
 * geometric `customZones` group in `evaluateRule` (inside / outside /
 * straddling / degenerate polygon / missing bbox / empty list) and the
 * subject-side bbox threading + NORMALIZATION:
 *   - object-event bbox is PIXEL-space (`ObjectEvent.bbox` + `frameWidth`/
 *     `frameHeight`) → normalized to 0..1 before it reaches the subject;
 *   - track bbox is the normalized 0..1 `track.envelope`.
 * Both fail CLOSED (no subject bbox) when a normalized box can't be derived.
 */

import type { NcRule, ObjectEvent, Track } from '@camstack/types'
import { NcRuleInputSchema, NcRuleSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  evaluateRule,
  type NcRuleSubject,
  subjectFromObjectEvent,
  subjectFromTrack,
} from '../rule-engine.js'

// ── fixtures ────────────────────────────────────────────────────────

/** A centred 0.4..0.6 square (normalized), the shape viewer B5/B6 produces. */
const square = {
  kind: 'polygon' as const,
  points: [
    { x: 0.4, y: 0.4 },
    { x: 0.6, y: 0.4 },
    { x: 0.6, y: 0.6 },
    { x: 0.4, y: 0.6 },
  ],
}

function anyRule(conditions: Record<string, unknown>): NcRule {
  const input = NcRuleInputSchema.parse({
    name: 'zone rule',
    delivery: 'immediate',
    targets: [{ targetId: 't1' }],
    conditions,
  })
  return NcRuleSchema.parse({
    ...input,
    id: 'rule-z',
    createdBy: 'admin-user',
    createdAt: 1_000,
    updatedAt: 1_000,
  })
}

function subject(bbox?: NcRuleSubject['bbox']): NcRuleSubject {
  return {
    kind: 'object-event',
    recordId: 'e1',
    deviceId: 1,
    timestamp: 0,
    classNames: ['person'],
    zones: [],
    ...(bbox !== undefined ? { bbox } : {}),
  }
}

// ── geometric eval ──────────────────────────────────────────────────

describe('customZones eval', () => {
  it('passes when the subject bbox overlaps a custom polygon', () => {
    const r = evaluateRule(
      anyRule({ customZones: [square] }),
      subject({ x: 0.45, y: 0.45, w: 0.1, h: 0.1 }),
    )
    expect(r.matched).toBe(true)
    expect(r.matchedOn).toContain('customZones')
  })

  it('fails when the bbox is outside every polygon', () => {
    const r = evaluateRule(
      anyRule({ customZones: [square] }),
      subject({ x: 0.0, y: 0.0, w: 0.05, h: 0.05 }),
    )
    expect(r.matched).toBe(false)
    expect(r.failedCondition).toBe('customZones')
  })

  it('passes when the bbox straddles a polygon edge (any positive overlap)', () => {
    // Box spans 0.35..0.55 — its right half sits inside the 0.4..0.6 square.
    const r = evaluateRule(
      anyRule({ customZones: [square] }),
      subject({ x: 0.35, y: 0.45, w: 0.2, h: 0.1 }),
    )
    expect(r.matched).toBe(true)
  })

  it('fails closed when the subject carries no bbox', () => {
    const r = evaluateRule(anyRule({ customZones: [square] }), subject(undefined))
    expect(r.matched).toBe(false)
    expect(r.failedCondition).toBe('customZones')
  })

  it('fails on a degenerate polygon (<3 points) even with a bbox inside its span', () => {
    const line = {
      kind: 'polygon' as const,
      points: [
        { x: 0.4, y: 0.4 },
        { x: 0.6, y: 0.6 },
      ],
    }
    const r = evaluateRule(
      anyRule({ customZones: [line] }),
      subject({ x: 0.45, y: 0.45, w: 0.1, h: 0.1 }),
    )
    expect(r.matched).toBe(false)
    expect(r.failedCondition).toBe('customZones')
  })

  it('passes when the bbox overlaps ANY of several polygons', () => {
    const far = {
      kind: 'polygon' as const,
      points: [
        { x: 0.8, y: 0.8 },
        { x: 0.9, y: 0.8 },
        { x: 0.9, y: 0.9 },
        { x: 0.8, y: 0.9 },
      ],
    }
    const r = evaluateRule(
      anyRule({ customZones: [far, square] }),
      subject({ x: 0.45, y: 0.45, w: 0.1, h: 0.1 }),
    )
    expect(r.matched).toBe(true)
  })

  it('treats an empty customZones list as an absent condition (no gate)', () => {
    const r = evaluateRule(anyRule({ customZones: [] }), subject(undefined))
    expect(r.matched).toBe(true)
    expect(r.matchedOn).not.toContain('customZones')
  })
})

// ── subject-side bbox threading + normalization ─────────────────────

function makeObjectEvent(overrides: Partial<ObjectEvent> = {}): ObjectEvent {
  return {
    id: 100_001,
    kind: 'object',
    deviceId: 104,
    timestamp: 111,
    className: 'person',
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
    zonesVisited: [],
    totalDistance: 0,
    state: 'left',
    active: false,
    ...overrides,
  }
}

describe('subject bbox threading', () => {
  it('normalizes a PIXEL object-event bbox by frame dims onto the subject', () => {
    const s = subjectFromObjectEvent(
      makeObjectEvent({
        bbox: { x: 960, y: 540, w: 192, h: 216 },
        frameWidth: 1920,
        frameHeight: 1080,
      }),
    )
    expect(s.bbox).toEqual({ x: 0.5, y: 0.5, w: 0.1, h: 0.2 })
  })

  it('omits the subject bbox when the object event has no frame dims (fail closed)', () => {
    const s = subjectFromObjectEvent(makeObjectEvent({ bbox: { x: 960, y: 540, w: 192, h: 216 } }))
    expect(s.bbox).toBeUndefined()
  })

  it('omits the subject bbox when the object event has no bbox', () => {
    const s = subjectFromObjectEvent(makeObjectEvent({ frameWidth: 1920, frameHeight: 1080 }))
    expect(s.bbox).toBeUndefined()
  })

  it('threads the normalized 0..1 track envelope onto the subject', () => {
    // Binary-exact edges so the width/height subtraction has no fp residue.
    const s = subjectFromTrack(
      makeTrack({ envelope: { minX: 0.25, minY: 0.25, maxX: 0.5, maxY: 0.75 } }),
    )
    expect(s.bbox).toEqual({ x: 0.25, y: 0.25, w: 0.25, h: 0.5 })
  })

  it('omits the subject bbox when the track has no envelope (fail closed)', () => {
    const s = subjectFromTrack(makeTrack())
    expect(s.bbox).toBeUndefined()
  })

  it('end-to-end: a track whose envelope overlaps a custom polygon fires', () => {
    const s = subjectFromTrack(
      makeTrack({ envelope: { minX: 0.45, minY: 0.45, maxX: 0.55, maxY: 0.55 } }),
    )
    const rule = NcRuleSchema.parse({
      ...NcRuleInputSchema.parse({
        name: 'trk zone',
        delivery: 'track-end',
        targets: [{ targetId: 't1' }],
        conditions: { customZones: [square] },
      }),
      id: 'rule-t',
      createdBy: 'admin-user',
      createdAt: 1_000,
      updatedAt: 1_000,
    })
    expect(evaluateRule(rule, s).matched).toBe(true)
  })
})
