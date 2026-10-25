import { describe, expect, it } from 'vitest'
import { BEST_FRAME_POLICY, BEST_OBJECT_EMBED_POLICY } from '../best-selection-policies.js'

/**
 * The LIVE object embedding comes from a frame that shows the whole subject.
 *
 * It used to be confidence-only: `edgeAware: false, sizeAware: false`. A frame
 * where the subject is half out of shot can carry the highest confidence in the
 * track — the detector is sure about the half it sees — and that half became
 * the vector. Meanwhile the post-close REBUILD embeds from the stored
 * `keyFrame`, which IS edge-aware, so one subject could hold two vectors
 * derived from materially different views of it.
 *
 * The policy's own comment reserved the right for the two paths to "drift apart
 * deliberately". This is not that drift being embraced — it is the drift being
 * removed, in the direction the durable path already took.
 *
 * What deliberately does NOT change: no hysteresis and no gap. This decision
 * only swaps an in-memory buffer — nothing is captured — and the durable
 * cross-restart gate stays downstream in `ObjectEmbeddingStore.upsertIfBetter`.
 */
describe('BEST_OBJECT_EMBED_POLICY', () => {
  it('ranks on how much of the subject is in frame', () => {
    expect(BEST_OBJECT_EMBED_POLICY.edgeAware).toBe(true)
  })

  it('ranks on subject size — a tiny crop makes a poor vector', () => {
    expect(BEST_OBJECT_EMBED_POLICY.sizeAware).toBe(true)
  })

  it('stays free of hysteresis and rate limits — it captures nothing', () => {
    expect(BEST_OBJECT_EMBED_POLICY.hysteresis).toBe(0)
    expect(BEST_OBJECT_EMBED_POLICY.minGapMs).toBe(0)
  })

  it('does NOT take the semantic tier — that is a best-SHOT concept', () => {
    // A frame that proved an identity is not thereby the best frame to embed;
    // ranking it so would make the vector agree with the recogniser by
    // construction.
    expect(BEST_OBJECT_EMBED_POLICY.semanticAware).toBe(false)
  })

  it('remains a SEPARATE policy from the best shot, not an alias', () => {
    // They now agree on the edge/size axes and must still differ where their
    // jobs differ, or one is masquerading as the other.
    expect(BEST_OBJECT_EMBED_POLICY.minGapMs).not.toBe(BEST_FRAME_POLICY.minGapMs)
  })
})
