import { describe, it, expect } from 'vitest'
import type {
  BoundingBox,
  DetectionEvent,
  TrackedDetection,
  TrackedObjectState,
} from '@camstack/types'
import { DetectionEventEmitter } from '../event-emitter.js'

const BOX: BoundingBox = { x: 0, y: 0, w: 20, h: 20 }

function track(trackId: string, trackAge: number): TrackedDetection {
  return {
    class: 'person',
    originalClass: 'person',
    score: 0.9,
    bbox: BOX,
    trackId,
    trackAge,
    velocity: { dx: 0, dy: 0 },
    path: [BOX],
  }
}

function state(
  trackId: string,
  s: TrackedObjectState['state'],
  dwellTimeMs: number,
): TrackedObjectState {
  return { trackId, state: s, enteredAt: 0, totalDistancePx: 0, dwellTimeMs }
}

// Phase 2 — the event layer owns the fps-independent minimum-track-age gate
// (via dwellTimeMs) so a sub-second flicker fragment never becomes an event,
// while the tracker keeps emitting the track (overlay/enrichment) immediately.

describe('DetectionEventEmitter — minTrackAgeMs (wall-clock) gate', () => {
  it('withholds an event until the track has existed for minTrackAgeMs', () => {
    const em = new DetectionEventEmitter({ minTrackAge: 1, minTrackAgeMs: 1000, cooldownSec: 0 })
    const t = track('t1', 5)
    // 500 ms old → suppressed even though the frame-count gate is satisfied.
    expect(em.emit([t], [state('t1', 'entering', 500)], [], [], 'dev')).toHaveLength(0)
    // 1000 ms old → allowed.
    const out = em.emit([t], [state('t1', 'entering', 1000)], [], [], 'dev')
    expect(out.map((e) => e.type)).toContain('object.entering')
  })

  it('does not gate when minTrackAgeMs is 0 (library default)', () => {
    const em = new DetectionEventEmitter({ minTrackAge: 1, cooldownSec: 0 })
    const out = em.emit([track('t1', 5)], [state('t1', 'entering', 0)], [], [], 'dev')
    expect(out.map((e) => e.type)).toContain('object.entering')
  })
})

// Phase 3 — a `leaving` state resolves for a track ABSENT from the current
// frame, so it must be looked up from a last-known snapshot (not the current-
// frame track map). Before the fix this always `continue`d → zero leaving
// events ever fired.
describe('DetectionEventEmitter — object.leaving', () => {
  it('emits exactly one object.leaving when a present track then disappears', () => {
    const em = new DetectionEventEmitter({ minTrackAge: 1, cooldownSec: 0 })
    // Frame 1: track is present and moving (no event type maps to "moving").
    em.emit([track('t1', 5)], [state('t1', 'moving', 1000)], [], [], 'dev')
    // Frame 2: track is gone from the frame; the analyzer reports it "leaving".
    const out = em.emit([], [state('t1', 'leaving', 2000)], [], [], 'dev')
    const leaving = out.filter((e) => e.type === 'object.leaving')
    expect(leaving).toHaveLength(1)
    expect(leaving[0]!.detection.trackId).toBe('t1')
  })
})

// Requirement 1 — EVERY subject's passage must be valued. A track that passes
// the min-age gate but never fires a crop-bearing transition (the common
// degenerate passer-by: gated past `entering`, then `moving`, then a zero-area
// `leaving`) gets a synthetic APPEARANCE event (`object.detected`) carrying its
// CURRENT bbox, so the event-media path captures a real crop and the track gets
// a bestEventId. Fires at most once per track, and is SUPPRESSED when the track
// already produced a crop-bearing event that frame (no redundant double crop).
describe('DetectionEventEmitter — appearance (object.detected)', () => {
  const appearances = (out: readonly DetectionEvent[]) =>
    out.filter((e) => e.type === 'object.detected')

  it('emits one appearance for a degenerate moving track that never transitions', () => {
    const em = new DetectionEventEmitter({ minTrackAge: 3, minTrackAgeMs: 0, cooldownSec: 0 })
    const out = em.emit([track('t1', 5)], [state('t1', 'moving', 1000)], [], [], 'dev')
    const app = appearances(out)
    expect(app).toHaveLength(1)
    expect(app[0]!.detection.trackId).toBe('t1')
    // Carries the CURRENT frame bbox (from the present track).
    expect(app[0]!.detection.bbox).toEqual(BOX)
  })

  it('emits the appearance AT MOST once per track across many frames', () => {
    const em = new DetectionEventEmitter({ minTrackAge: 3, minTrackAgeMs: 0, cooldownSec: 0 })
    const t = track('t1', 5)
    const first = appearances(em.emit([t], [state('t1', 'moving', 1000)], [], [], 'dev'))
    const second = appearances(em.emit([t], [state('t1', 'moving', 1100)], [], [], 'dev'))
    const third = appearances(em.emit([t], [state('t1', 'moving', 1200)], [], [], 'dev'))
    expect(first).toHaveLength(1)
    expect(second).toHaveLength(0)
    expect(third).toHaveLength(0)
  })

  it('does NOT emit an appearance before the age gate passes', () => {
    const em = new DetectionEventEmitter({ minTrackAge: 3, minTrackAgeMs: 1000, cooldownSec: 0 })
    // trackAge below minTrackAge → no appearance.
    expect(
      appearances(em.emit([track('t1', 2)], [state('t1', 'moving', 2000)], [], [], 'dev')),
    ).toHaveLength(0)
    // dwellTimeMs below minTrackAgeMs → no appearance.
    expect(
      appearances(em.emit([track('t1', 5)], [state('t1', 'moving', 500)], [], [], 'dev')),
    ).toHaveLength(0)
    // both satisfied → appearance fires.
    expect(
      appearances(em.emit([track('t1', 5)], [state('t1', 'moving', 1000)], [], [], 'dev')),
    ).toHaveLength(1)
  })

  it('is SUPPRESSED when the track fires a crop-bearing transition the same frame (no double crop)', () => {
    const em = new DetectionEventEmitter({ minTrackAge: 3, minTrackAgeMs: 0, cooldownSec: 0 })
    const out = em.emit([track('t1', 5)], [state('t1', 'entering', 1000)], [], [], 'dev')
    expect(out.filter((e) => e.type === 'object.entering')).toHaveLength(1)
    // The entering event already values the track this frame → no appearance.
    expect(appearances(out)).toHaveLength(0)
    // ...and no LATER appearance either (the track is already valued).
    const next = em.emit([track('t1', 6)], [state('t1', 'moving', 1100)], [], [], 'dev')
    expect(appearances(next)).toHaveLength(0)
  })

  it('can be disabled via emitAppearance:false', () => {
    const em = new DetectionEventEmitter({
      minTrackAge: 3,
      minTrackAgeMs: 0,
      cooldownSec: 0,
      emitAppearance: false,
    })
    expect(
      appearances(em.emit([track('t1', 5)], [state('t1', 'moving', 1000)], [], [], 'dev')),
    ).toHaveLength(0)
  })

  it('reset clears appearance memory so a reused track id can re-appear', () => {
    const em = new DetectionEventEmitter({ minTrackAge: 3, minTrackAgeMs: 0, cooldownSec: 0 })
    expect(
      appearances(em.emit([track('t1', 5)], [state('t1', 'moving', 1000)], [], [], 'dev')),
    ).toHaveLength(1)
    em.reset()
    expect(
      appearances(em.emit([track('t1', 5)], [state('t1', 'moving', 1000)], [], [], 'dev')),
    ).toHaveLength(1)
  })
})

// ── Zone crossings (2026-07-31) ──────────────────────────────────────────────
// The emitter's zone branch has existed since the beginning and was never fed:
// the frame processor passed a literal `[]`. These assert the branch works, so
// that a future refactor cannot quietly return it to being dead code.

function zoneEvent(type: 'zone-enter' | 'zone-exit', trackId: string, detection: TrackedDetection) {
  return {
    type,
    zoneId: 'cfeec78c',
    zoneName: 'Uscio',
    trackId,
    detection,
    timestamp: 1_000,
  } as const
}

describe('DetectionEventEmitter — zone crossings', () => {
  it('turns a zone entry into a zone.enter event', () => {
    const em = new DetectionEventEmitter({ minTrackAge: 1, cooldownSec: 0 })
    const t = track('t1', 5)
    const out = em.emit(
      [t],
      [state('t1', 'moving', 5000)],
      [zoneEvent('zone-enter', 't1', t)],
      [],
      'dev',
    )
    expect(out.map((e) => e.type)).toContain('zone.enter')
  })

  it('turns a zone exit into a zone.exit event', () => {
    const em = new DetectionEventEmitter({ minTrackAge: 1, cooldownSec: 0 })
    const t = track('t1', 5)
    const out = em.emit(
      [t],
      [state('t1', 'moving', 5000)],
      [zoneEvent('zone-exit', 't1', t)],
      [],
      'dev',
    )
    expect(out.map((e) => e.type)).toContain('zone.exit')
  })

  it('carries the crossing on the event, so a rule can read WHICH zone', () => {
    const em = new DetectionEventEmitter({ minTrackAge: 1, cooldownSec: 0 })
    const t = track('t1', 5)
    const out = em.emit(
      [t],
      [state('t1', 'moving', 5000)],
      [zoneEvent('zone-enter', 't1', t)],
      [],
      'dev',
    )
    const ev = out.find((e) => e.type === 'zone.enter')
    expect(ev?.zoneEvents.map((z) => z.zoneId)).toEqual(['cfeec78c'])
  })

  it('a zone crossing VALUES the track, so it gets no redundant appearance event', () => {
    // Requirement 1's appearance fallback must not fire on top of a real,
    // crop-bearing zone event — that would double the media work per track.
    const em = new DetectionEventEmitter({ minTrackAge: 1, cooldownSec: 0 })
    const t = track('t1', 5)
    const out = em.emit(
      [t],
      [state('t1', 'moving', 5000)],
      [zoneEvent('zone-enter', 't1', t)],
      [],
      'dev',
    )
    expect(out.map((e) => e.type)).not.toContain('object.detected')
  })

  it('ignores a crossing for a track that is not in this frame', () => {
    // The zone branch resolves from `trackMap` only: a crossing without a
    // present track has no bbox to crop and must be dropped rather than
    // emitted with a stale one.
    const em = new DetectionEventEmitter({ minTrackAge: 1, cooldownSec: 0 })
    const t = track('t1', 5)
    const out = em.emit([], [], [zoneEvent('zone-enter', 't1', t)], [], 'dev')
    expect(out).toHaveLength(0)
  })
})
