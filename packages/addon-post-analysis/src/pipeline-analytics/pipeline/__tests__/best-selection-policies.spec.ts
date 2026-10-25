import { describe, expect, it } from 'vitest'

import { BestDetectionTracker } from '../best-detection-tracker.js'
import {
  BEST_FACE_POLICY,
  BEST_FRAME_POLICY,
  BEST_OBJECT_EMBED_POLICY,
  type BestSelectionPolicy,
} from '../best-selection-policies.js'

/**
 * S9 policy-table pin: the WHOLE point of the table is that a selection-policy
 * change must show up as a deliberate edit HERE, never as a silently omitted
 * constructor argument. These assertions are exact — if a value drifts, this
 * spec fails and the drift becomes a decision.
 */
describe('best-selection policy table (S9)', () => {
  it('BEST_FRAME_POLICY: edge/size-aware, hysteresis 0.05, minGap 2 s (decisive bypass via sizeAware)', () => {
    expect(BEST_FRAME_POLICY).toStrictEqual<BestSelectionPolicy>({
      hysteresis: 0.05,
      minGapMs: 2_000,
      edgeAware: true,
      sizeAware: true,
      semanticAware: true,
    })
  })

  it('BEST_FACE_POLICY: size-aware ranking, no hysteresis, no gap (true peak kept; buffering is cheap)', () => {
    expect(BEST_FACE_POLICY).toStrictEqual<BestSelectionPolicy>({
      hysteresis: 0,
      minGapMs: 0,
      edgeAware: false,
      sizeAware: true,
      semanticAware: false,
    })
  })

  it('BEST_OBJECT_EMBED_POLICY: edge + size aware, no rate limit (durable gate stays in ObjectEmbeddingStore.upsertIfBetter)', () => {
    // Was confidence-only. A frame with the subject half out of shot can carry
    // the highest confidence in the track and became the vector, while the
    // post-close rebuild embedded from the edge-aware keyFrame — two vectors of
    // one subject from materially different views. Not semantic: ranking "the
    // frame that proved an identity" highest would make the vector agree with
    // the recogniser by construction.
    expect(BEST_OBJECT_EMBED_POLICY).toStrictEqual<BestSelectionPolicy>({
      hysteresis: 0,
      minGapMs: 0,
      edgeAware: true,
      sizeAware: true,
      semanticAware: false,
    })
  })

  describe('the declaration is ENFORCED, not just documented', () => {
    it('edgeAware:false ignores the edge-clear tier (no clear-beats-touching upgrade)', () => {
      const t = new BestDetectionTracker(BEST_FACE_POLICY)
      // Held peak flagged edge-touching, weaker candidate flagged edge-clear:
      // an edge-AWARE tracker would tier-upgrade; a face-policy tracker must
      // rank on raw confidence only.
      expect(t.observe('a', 0.9, 0, false)).toBe(true)
      expect(t.observe('a', 0.5, 1_000, true)).toBe(false)
      expect(t.peak('a')?.confidence).toBe(0.9)
    })

    it('sizeAware:false keeps the strict minGap (no decisive-improvement bypass)', () => {
      const t = new BestDetectionTracker({
        hysteresis: 0,
        minGapMs: 5_000,
        edgeAware: false,
        sizeAware: false,
      })
      expect(t.observe('a', 0.5, 0, undefined, undefined, undefined, 0.1)).toBe(true)
      // Huge candidate on every axis, inside the gap: a size-AWARE tracker
      // takes it via the decisive bypass; this one must hold the gap.
      expect(t.observe('a', 0.95, 1_000, undefined, undefined, undefined, 1)).toBe(false)
      expect(t.peak('a')?.confidence).toBe(0.5)
    })

    it('default construction stays permissive (legacy behavior for existing specs)', () => {
      const t = new BestDetectionTracker()
      expect(t.observe('a', 0.9, 0, false)).toBe(true)
      // Tier upgrade honored when no policy restricts it.
      expect(t.observe('a', 0.5, 1, true)).toBe(true)
      expect(t.peak('a')?.confidence).toBe(0.5)
    })
  })
})

// Fourth construction site folded in post-review: the table is exhaustive.
import { CANDIDATE_IMPROVE_POLICY } from '../best-selection-policies.js'

describe('CANDIDATE_IMPROVE_POLICY', () => {
  it('is confidence-only (declared, exhaustive table)', () => {
    expect(CANDIDATE_IMPROVE_POLICY).toStrictEqual({
      hysteresis: 0,
      minGapMs: 0,
      edgeAware: false,
      sizeAware: false,
      semanticAware: false,
    })
  })
})
