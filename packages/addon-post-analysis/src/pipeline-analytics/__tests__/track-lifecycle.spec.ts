/**
 * Track-lifecycle update-gate + payload assembly (pure) — TDD.
 *
 * The update-gate decides whether a track's best observation improved
 * MATERIALLY enough to emit a `phase:'update'` lifecycle event, reusing
 * the existing `isNewBest` signal plus a confidence-delta / newly-resolved
 * label / larger-crop trigger, debounced so it cannot rapid-fire. The
 * payload builder assembles the typed cross-phase payload.
 */
import { describe, it, expect } from 'vitest'
import {
  evaluateTrackLifecycleUpdate,
  buildTrackLifecyclePayload,
  resolveLifecycleUpdateLabel,
  DEFAULT_UPDATE_GATE_CONFIG,
  type TrackLifecycleUpdateMemory,
} from '../track-lifecycle.js'

const cfg = DEFAULT_UPDATE_GATE_CONFIG

describe('resolveLifecycleUpdateLabel', () => {
  it('falls back to the track row display label when the frame carried no patch — the face-recognizer path', () => {
    // The face recognizer assigns an identity over the async detail plane and
    // writes it to the track ROW (`applyLabelCandidate`), never into a frame
    // patch. The update signal must read the row too, or the identity trigger
    // can never fire for a recognised face — measured live 2026-09-05: every
    // face reached Home Assistant only at track end + sweep (~lastSeen+33 s).
    expect(resolveLifecycleUpdateLabel(undefined, 'Alice')).toBe('Alice')
  })

  it("prefers this frame's tiered patch over the stored label", () => {
    expect(resolveLifecycleUpdateLabel({ subLabel: 'AB123CD', subLabelScore: 0.9 }, 'Car')).toBe(
      'AB123CD',
    )
  })

  it('yields undefined when neither side knows anything', () => {
    expect(resolveLifecycleUpdateLabel(undefined, undefined)).toBeUndefined()
  })

  it('a row-stored identity drives the gate to an identity emit with flat confidence', () => {
    const label = resolveLifecycleUpdateLabel(undefined, 'Alice')
    const d = evaluateTrackLifecycleUpdate(
      {
        isNewBest: false,
        confidence: 0.8,
        now: 10_000,
        ...(label !== undefined ? { label } : {}),
      },
      { lastConfidence: 0.8, lastEmitAt: 0 },
      cfg,
    )
    expect(d.emit).toBe(true)
    expect(d.reason).toBe('identity')
    expect(d.memory.lastLabel).toBe('Alice')
  })
})

describe('evaluateTrackLifecycleUpdate', () => {
  it('does not emit when isNewBest but confidence delta is below threshold', () => {
    const memory: TrackLifecycleUpdateMemory = { lastConfidence: 0.5, lastEmitAt: 0 }
    const d = evaluateTrackLifecycleUpdate(
      { isNewBest: true, confidence: 0.55, now: 10_000 },
      memory,
      cfg,
    )
    expect(d.emit).toBe(false)
    expect(d.memory).toEqual(memory) // unchanged
  })

  it('emits (confidence) when isNewBest and delta ≥ threshold, seeding memory', () => {
    const memory: TrackLifecycleUpdateMemory = { lastConfidence: 0.5, lastEmitAt: 0 }
    const d = evaluateTrackLifecycleUpdate(
      { isNewBest: true, confidence: 0.65, now: 10_000 },
      memory,
      cfg,
    )
    expect(d.emit).toBe(true)
    expect(d.reason).toBe('confidence')
    expect(d.memory.lastConfidence).toBe(0.65)
    expect(d.memory.lastEmitAt).toBe(10_000)
  })

  it('suppresses within the debounce window even when the trigger fires', () => {
    const memory: TrackLifecycleUpdateMemory = { lastConfidence: 0.5, lastEmitAt: 9_000 }
    const d = evaluateTrackLifecycleUpdate(
      { isNewBest: true, confidence: 0.9, now: 9_000 + cfg.minIntervalMs - 1 },
      memory,
      cfg,
    )
    expect(d.emit).toBe(false)
    // The drop is COUNTED, never silent; the trigger baseline stays unchanged.
    expect(d.suppressed).toBe('confidence')
    expect(d.memory.suppressedSinceEmit).toBe(1)
    expect(d.memory.lastConfidence).toBe(0.5)
    expect(d.memory.lastEmitAt).toBe(9_000)
  })

  it('emits once the debounce window has elapsed', () => {
    const memory: TrackLifecycleUpdateMemory = { lastConfidence: 0.5, lastEmitAt: 9_000 }
    const d = evaluateTrackLifecycleUpdate(
      { isNewBest: true, confidence: 0.9, now: 9_000 + cfg.minIntervalMs },
      memory,
      cfg,
    )
    expect(d.emit).toBe(true)
    expect(d.reason).toBe('confidence')
  })

  it('emits (identity) when a label is newly resolved, even with flat confidence', () => {
    const memory: TrackLifecycleUpdateMemory = { lastConfidence: 0.8, lastEmitAt: 0 }
    const d = evaluateTrackLifecycleUpdate(
      { isNewBest: false, confidence: 0.8, now: 10_000, label: 'Alice' },
      memory,
      cfg,
    )
    expect(d.emit).toBe(true)
    expect(d.reason).toBe('identity')
    expect(d.memory.lastLabel).toBe('Alice')
  })

  it('does not re-emit identity for the same label', () => {
    const memory: TrackLifecycleUpdateMemory = {
      lastConfidence: 0.8,
      lastEmitAt: 0,
      lastLabel: 'Alice',
    }
    const d = evaluateTrackLifecycleUpdate(
      { isNewBest: false, confidence: 0.8, now: 100_000, label: 'Alice' },
      memory,
      cfg,
    )
    expect(d.emit).toBe(false)
  })

  it('emits (crop) when the representative crop grows materially', () => {
    const memory: TrackLifecycleUpdateMemory = {
      lastConfidence: 0.8,
      lastEmitAt: 0,
      lastBboxArea: 1000,
    }
    const d = evaluateTrackLifecycleUpdate(
      {
        isNewBest: false,
        confidence: 0.8,
        now: 10_000,
        bboxArea: 1000 * (1 + cfg.minCropAreaGrowth),
      },
      memory,
      cfg,
    )
    expect(d.emit).toBe(true)
    expect(d.reason).toBe('crop')
    expect(d.memory.lastBboxArea).toBeCloseTo(1000 * (1 + cfg.minCropAreaGrowth), 3)
  })

  it('accumulates confidence delta against the last EMITTED value', () => {
    // Two sub-threshold new-bests: first does not emit; the second, whose
    // delta vs the last EMIT crosses the threshold, does.
    const m0: TrackLifecycleUpdateMemory = { lastConfidence: 0.5, lastEmitAt: 0 }
    const d1 = evaluateTrackLifecycleUpdate(
      { isNewBest: true, confidence: 0.55, now: 10_000 },
      m0,
      cfg,
    )
    expect(d1.emit).toBe(false)
    const d2 = evaluateTrackLifecycleUpdate(
      { isNewBest: true, confidence: 0.62, now: 20_000 },
      d1.memory,
      cfg,
    )
    expect(d2.emit).toBe(true)
    expect(d2.reason).toBe('confidence')
  })

  it('prioritises identity over confidence when both trigger', () => {
    const memory: TrackLifecycleUpdateMemory = { lastConfidence: 0.5, lastEmitAt: 0 }
    const d = evaluateTrackLifecycleUpdate(
      { isNewBest: true, confidence: 0.9, now: 10_000, label: 'Bob' },
      memory,
      cfg,
    )
    expect(d.emit).toBe(true)
    expect(d.reason).toBe('identity')
  })

  it('emits on first trigger with no prior memory (no debounce baseline)', () => {
    const d = evaluateTrackLifecycleUpdate(
      { isNewBest: true, confidence: 0.9, now: 10_000 },
      undefined,
      cfg,
    )
    expect(d.emit).toBe(true)
    expect(d.memory.lastEmitAt).toBe(10_000)
  })
})

describe('zone entries and suppression accounting', () => {
  it('emits (zone) when the track enters a zone it had not visited', () => {
    const memory: TrackLifecycleUpdateMemory = {
      lastConfidence: 0.8,
      lastEmitAt: 0,
      lastZonesVisitedCount: 1,
    }
    const d = evaluateTrackLifecycleUpdate(
      { isNewBest: false, confidence: 0.8, now: 10_000, zonesVisitedCount: 2 },
      memory,
      cfg,
    )
    expect(d.emit).toBe(true)
    expect(d.reason).toBe('zone')
    expect(d.memory.lastZonesVisitedCount).toBe(2)
  })

  it('does not emit for an unchanged zone count', () => {
    const memory: TrackLifecycleUpdateMemory = {
      lastConfidence: 0.8,
      lastEmitAt: 0,
      lastZonesVisitedCount: 1,
    }
    const d = evaluateTrackLifecycleUpdate(
      { isNewBest: false, confidence: 0.8, now: 10_000, zonesVisitedCount: 1 },
      memory,
      cfg,
    )
    expect(d.emit).toBe(false)
  })

  it('seeds the zone baseline on first observation without emitting', () => {
    // A track born inside a zone already carried that zone on its `start`
    // event — the first evaluation must not double-report it as an entry.
    const d = evaluateTrackLifecycleUpdate(
      { isNewBest: false, confidence: 0.8, now: 10_000, zonesVisitedCount: 1 },
      undefined,
      cfg,
    )
    expect(d.emit).toBe(false)
    expect(d.memory.lastZonesVisitedCount).toBe(1)
  })

  it('counts every debounce-suppressed trigger and resets the count on emit', () => {
    const m0: TrackLifecycleUpdateMemory = { lastConfidence: 0.5, lastEmitAt: 9_000 }
    const s1 = evaluateTrackLifecycleUpdate(
      { isNewBest: true, confidence: 0.9, now: 10_000 },
      m0,
      cfg,
    )
    expect(s1.emit).toBe(false)
    expect(s1.suppressed).toBe('confidence')
    const s2 = evaluateTrackLifecycleUpdate(
      { isNewBest: true, confidence: 0.95, now: 11_000 },
      s1.memory,
      cfg,
    )
    expect(s2.memory.suppressedSinceEmit).toBe(2)
    const e = evaluateTrackLifecycleUpdate(
      { isNewBest: true, confidence: 0.95, now: 9_000 + cfg.minIntervalMs },
      s2.memory,
      cfg,
    )
    expect(e.emit).toBe(true)
    expect(e.memory.suppressedSinceEmit).toBeUndefined()
  })
})

describe('buildTrackLifecyclePayload', () => {
  it('builds a start payload with duration 0 and no media', () => {
    const p = buildTrackLifecyclePayload({
      deviceId: 4,
      trackId: 't1',
      phase: 'start',
      classes: ['person'],
      bestClassName: 'person',
      bestConfidence: 0.4,
      firstSeen: 1000,
      lastSeen: 1000,
    })
    expect(p.phase).toBe('start')
    expect(p.durationMs).toBe(0)
    expect(p.classes).toEqual(['person'])
    expect(p.media).toBeUndefined()
    expect(p.label).toBeUndefined()
  })

  it('builds a rich end payload with media + spatial summary', () => {
    const p = buildTrackLifecyclePayload({
      deviceId: 4,
      trackId: 't1',
      phase: 'end',
      classes: ['person', 'vehicle'],
      bestClassName: 'person',
      bestConfidence: 0.91,
      firstSeen: 1000,
      lastSeen: 9000,
      label: 'Alice',
      zonesVisited: ['entrance'],
      totalDistance: 1.2,
      positionsCount: 42,
      importance: 0.7,
      importanceReason: 'identity',
      keyFrameMediaId: 1,
      bestEventId: 'ev:9',
      embeddingModelId: 'mobileclip-s0',
    })
    expect(p.phase).toBe('end')
    expect(p.durationMs).toBe(8000)
    expect(p.label).toBe('Alice')
    expect(p.importance).toBe(0.7)
    expect(p.positionsCount).toBe(42)
    expect(p.media).toEqual({ keyFrameMediaId: 1, bestEventId: 'ev:9' })
    expect(p.embeddingModelId).toBe('mobileclip-s0')
  })

  it('omits the media object entirely when no media keys are present', () => {
    const p = buildTrackLifecyclePayload({
      deviceId: 4,
      trackId: 't1',
      phase: 'update',
      classes: ['person'],
      bestClassName: 'person',
      bestConfidence: 0.7,
      firstSeen: 1000,
      lastSeen: 3000,
    })
    expect('media' in p).toBe(false)
    expect('label' in p).toBe(false)
    expect('importance' in p).toBe(false)
  })

  it('clamps a negative duration to 0', () => {
    const p = buildTrackLifecyclePayload({
      deviceId: 4,
      trackId: 't1',
      phase: 'update',
      classes: ['person'],
      bestClassName: 'person',
      bestConfidence: 0.7,
      firstSeen: 5000,
      lastSeen: 4000,
    })
    expect(p.durationMs).toBe(0)
  })
})
