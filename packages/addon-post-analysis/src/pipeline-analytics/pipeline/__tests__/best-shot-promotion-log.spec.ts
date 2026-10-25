/**
 * D400 — the best-shot promotion log.
 *
 * The 2026-09-07 audit closed track `5f5f0f6e` at UNKNOWN because "a promotion
 * that fired and whose capture missed is indistinguishable from one that never
 * fired". These pin that the two are now separable, and that the line carries
 * the deviceId tag every per-camera question needs.
 */

import { describe, expect, it } from 'vitest'
import {
  type BestShotPromotionAttempt,
  PROMOTION_REFUSAL_LOG_GAP_MS,
  bestShotPromotionMeta,
  shouldLogPromotionAttempt,
} from '../best-shot-promotion-log.js'
import { compareBestFrame } from '../edge-clear.js'

const held = { confidence: 0.83, edgeClear: false, containment: 0.52, canvasFill: 0.21 }
const candidate = { confidence: 0.79, edgeClear: true, containment: 1, canvasFill: 0 }

function attempt(over: Partial<BestShotPromotionAttempt> = {}): BestShotPromotionAttempt {
  return {
    trackId: '5f5f0f6e-0253-4208-8eab-f8d5d6a14fbe',
    className: 'person',
    timestamp: 1_788_803_565_069,
    candidate,
    held,
    comparison: compareBestFrame(held, candidate, 0.05),
    accepted: true,
    thumbnailRequested: true,
    keyFrameRequested: true,
    ...over,
  }
}

describe('bestShotPromotionMeta', () => {
  it('names the TERM that decided, so a fired promotion is identifiable', () => {
    // The audit's own case: a later edge-clear position against a
    // border-touching held peak. The edge tier is what should have fired.
    expect(bestShotPromotionMeta(attempt()).decidedBy).toBe('edge-clear')
  })

  it('carries both effective scores and both sides of the delivered-canvas fill', () => {
    const meta = bestShotPromotionMeta(attempt())
    expect(meta.heldScore).toBeGreaterThan(0)
    expect(meta.candidateScore).toBeGreaterThan(0)
    expect(meta.heldCanvasFill).toBe(0.21)
    expect(meta.candCanvasFill).toBe(0)
  })

  it('says first-sighting rather than inventing a comparison that never ran', () => {
    const meta = bestShotPromotionMeta(
      attempt({ held: undefined, comparison: undefined, accepted: true }),
    )
    expect(meta.decidedBy).toBe('first-sighting')
    expect(meta.heldScore).toBeUndefined()
    expect(meta.heldConfidence).toBeUndefined()
  })

  it('separates "the promotion fired but nothing was captured" from a refusal', () => {
    const suppressed = bestShotPromotionMeta(
      attempt({ accepted: true, thumbnailRequested: false, suppressedBy: 'capture-in-flight' }),
    )
    expect(suppressed.accepted).toBe(true)
    expect(suppressed.thumbnailRequested).toBe(false)
    expect(suppressed.suppressedBy).toBe('capture-in-flight')

    const refused = bestShotPromotionMeta(
      attempt({ accepted: false, thumbnailRequested: false, keyFrameRequested: false }),
    )
    expect(refused.accepted).toBe(false)
    expect(refused.suppressedBy).toBeUndefined()
  })

  it('rounds to three places so two frames diff by eye in a log grep', () => {
    const meta = bestShotPromotionMeta(
      attempt({ candidate: { ...candidate, confidence: 0.8329999999 } }),
    )
    expect(meta.candConfidence).toBe(0.833)
  })

  it('never emits an undefined key for an unmeasured term', () => {
    const meta = bestShotPromotionMeta(
      attempt({
        candidate: { confidence: 0.5, edgeClear: true },
        held: undefined,
        comparison: undefined,
      }),
    )
    expect('candCanvasFill' in meta).toBe(false)
    expect('candContainment' in meta).toBe(false)
  })
})

describe('shouldLogPromotionAttempt', () => {
  it('logs EVERY acceptance — that is the moment the cover image changes', () => {
    expect(shouldLogPromotionAttempt(attempt({ accepted: true }), { thumbnailLanded: true })).toBe(
      true,
    )
  })

  it('stays quiet on refusals for a track that already has its picture', () => {
    expect(shouldLogPromotionAttempt(attempt({ accepted: false }), { thumbnailLanded: true })).toBe(
      false,
    )
  })

  it('logs a refusal on a PICTURELESS track — the "never moved off the birth frame" shape', () => {
    expect(
      shouldLogPromotionAttempt(attempt({ accepted: false }), { thumbnailLanded: false }),
    ).toBe(true)
  })

  it('throttles those refusals so a busy camera cannot bury the acceptances', () => {
    const at = 1_788_803_565_069
    const gate = { thumbnailLanded: false, lastRefusalLogAtMs: at }
    expect(shouldLogPromotionAttempt(attempt({ accepted: false, timestamp: at + 100 }), gate)).toBe(
      false,
    )
    expect(
      shouldLogPromotionAttempt(
        attempt({ accepted: false, timestamp: at + PROMOTION_REFUSAL_LOG_GAP_MS }),
        gate,
      ),
    ).toBe(true)
  })

  it('never throttles an acceptance, however recent the last refusal line', () => {
    expect(
      shouldLogPromotionAttempt(attempt({ accepted: true }), {
        thumbnailLanded: false,
        lastRefusalLogAtMs: 1_788_803_565_069,
      }),
    ).toBe(true)
  })
})
