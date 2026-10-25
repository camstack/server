import { describe, it, expect } from 'vitest'
import {
  isEdgeClear,
  isEdgeAwareNewBest,
  bboxCenterScore,
  bboxContainment,
  CENTER_TIE_BREAK_MARGIN,
  CONTAINMENT_MIN,
  DEFAULT_EDGE_TOLERANCE,
} from '../edge-clear.js'

const FRAME = { frameWidth: 1000, frameHeight: 500 }

describe('isEdgeClear', () => {
  it('a bbox fully inside the frame is edge-clear', () => {
    expect(isEdgeClear({ bbox: { x: 200, y: 100, w: 100, h: 100 }, ...FRAME })).toBe(true)
  })

  it('a bbox touching the left border is NOT edge-clear', () => {
    expect(isEdgeClear({ bbox: { x: 0, y: 100, w: 100, h: 100 }, ...FRAME })).toBe(false)
  })

  it('a bbox touching the top border is NOT edge-clear', () => {
    expect(isEdgeClear({ bbox: { x: 200, y: 0, w: 100, h: 100 }, ...FRAME })).toBe(false)
  })

  it('a bbox reaching the right border is NOT edge-clear', () => {
    // right edge = x + w = 1000 = frameWidth
    expect(isEdgeClear({ bbox: { x: 900, y: 100, w: 100, h: 100 }, ...FRAME })).toBe(false)
  })

  it('a bbox reaching the bottom border is NOT edge-clear', () => {
    // bottom edge = y + h = 500 = frameHeight
    expect(isEdgeClear({ bbox: { x: 200, y: 400, w: 100, h: 100 }, ...FRAME })).toBe(false)
  })

  it('a bbox WITHIN the tolerance band counts as touching (default 1%)', () => {
    // tolX = 1% of 1000 = 10px. x = 5 (< 10) → touching.
    expect(isEdgeClear({ bbox: { x: 5, y: 100, w: 100, h: 100 }, ...FRAME })).toBe(false)
  })

  it('a bbox just OUTSIDE the tolerance band is edge-clear', () => {
    // tolX = 10px; x = 15 (> 10), and right = 15+100 = 115 << 990 → clear.
    expect(isEdgeClear({ bbox: { x: 15, y: 15, w: 100, h: 100 }, ...FRAME })).toBe(true)
  })

  it('honours a custom tolerance', () => {
    // tolerance 5% → tolX = 50px. x = 30 (< 50) → touching.
    expect(
      isEdgeClear({
        bbox: { x: 30, y: 100, w: 100, h: 100 },
        ...FRAME,
        tolerance: 0.05,
      }),
    ).toBe(false)
  })

  it('treats unknown/degenerate frame dims as edge-clear (neutral)', () => {
    expect(
      isEdgeClear({
        bbox: { x: 0, y: 0, w: 10, h: 10 },
        frameWidth: 0,
        frameHeight: 0,
      }),
    ).toBe(true)
  })

  it('default tolerance is 1%', () => {
    expect(DEFAULT_EDGE_TOLERANCE).toBe(0.01)
  })
})

describe('isEdgeAwareNewBest', () => {
  it('an edge-clear candidate ALWAYS beats an edge-touching peak, even at lower confidence', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.9, edgeClear: false },
        { confidence: 0.3, edgeClear: true },
        0,
      ),
    ).toBe(true)
  })

  it('an edge-touching candidate NEVER beats an edge-clear peak, even at higher confidence', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.3, edgeClear: true },
        { confidence: 0.99, edgeClear: false },
        0,
      ),
    ).toBe(false)
  })

  it('within the same tier (both clear), higher confidence beyond hysteresis wins', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.5, edgeClear: true },
        { confidence: 0.56, edgeClear: true },
        0.05,
      ),
    ).toBe(true)
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.5, edgeClear: true },
        { confidence: 0.54, edgeClear: true },
        0.05,
      ),
    ).toBe(false)
  })

  it('within the same tier (both touching), higher confidence wins', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.4, edgeClear: false },
        { confidence: 0.7, edgeClear: false },
        0,
      ),
    ).toBe(true)
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.7, edgeClear: false },
        { confidence: 0.7, edgeClear: false },
        0,
      ),
    ).toBe(false)
  })

  it('centering tie-break (#27-D): a better-centred, near-equal-confidence frame wins', () => {
    // Same tier, confidence within hysteresis, candidate far better centred.
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.5, edgeClear: true, centerScore: 0.3 },
        { confidence: 0.52, edgeClear: true, centerScore: 0.9 },
        0.05,
      ),
    ).toBe(true)
  })

  it('centering tie-break does NOT fire when the centre gain is below the margin', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.5, edgeClear: true, centerScore: 0.5 },
        {
          confidence: 0.5,
          edgeClear: true,
          centerScore: 0.5 + CENTER_TIE_BREAK_MARGIN / 2,
        },
        0.05,
      ),
    ).toBe(false)
  })

  it('centering tie-break does NOT override a real confidence gap', () => {
    // Candidate is worse-centred but clearly higher confidence → still wins on
    // confidence (the primary signal), tie-break never consulted.
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.5, edgeClear: true, centerScore: 0.9 },
        { confidence: 0.8, edgeClear: true, centerScore: 0.1 },
        0.05,
      ),
    ).toBe(true)
    // ...and a worse-centred, lower-confidence candidate never wins.
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.8, edgeClear: true, centerScore: 0.9 },
        { confidence: 0.5, edgeClear: true, centerScore: 0.1 },
        0.05,
      ),
    ).toBe(false)
  })

  it('centering tie-break is disabled when either side omits centerScore (legacy callers)', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.5, edgeClear: true },
        { confidence: 0.5, edgeClear: true, centerScore: 0.99 },
        0.05,
      ),
    ).toBe(false)
  })
})

describe('bboxContainment', () => {
  it('a fully-contained bbox has containment 1', () => {
    expect(bboxContainment({ x: 300, y: 150, w: 100, h: 100 }, 1000, 500)).toBe(1)
  })

  it('a subject flush against one border is penalised below 1', () => {
    // Tall subject flush to the LEFT (half a person out the side): left edge at 0,
    // spans 60% of the frame HEIGHT → sizeable penalty.
    const c = bboxContainment({ x: 0, y: 100, w: 120, h: 300 }, 1000, 500)
    expect(c).toBeLessThan(1)
    expect(c).toBeGreaterThan(CONTAINMENT_MIN)
  })

  it('a subject that merely GRAZES a border keeps most of its score', () => {
    // A NARROW, TALL subject whose feet touch the bottom border: what survives
    // is 3.3× taller than it is wide, so nothing about its shape says truncated
    // → no penalty. (Fixture updated with D400: it used to be an 80×80 SQUARE
    // box, which passed only because the old metric read the box's span across
    // the FRAME and never its own shape. A square remnant against a border is
    // precisely the ambiguous case, and calling it "grazing" hid the defect.)
    const grazing = bboxContainment({ x: 470, y: 320, w: 60, h: 180 }, 1000, 500)
    // ...whereas a WIDE subject cut off at the bottom is penalised heavily.
    const wideCut = bboxContainment({ x: 200, y: 420, w: 600, h: 80 }, 1000, 500)
    expect(grazing).toBeGreaterThan(wideCut)
    expect(grazing).toBeGreaterThan(0.9)
  })

  it('clipping on multiple borders compounds the penalty (corner subject)', () => {
    const oneSide = bboxContainment({ x: 0, y: 100, w: 200, h: 200 }, 1000, 500)
    const corner = bboxContainment({ x: 0, y: 0, w: 200, h: 200 }, 1000, 500)
    expect(corner).toBeLessThan(oneSide)
  })

  it('never drops below the CONTAINMENT_MIN floor', () => {
    // A subject flush on all four borders (fills the frame).
    const c = bboxContainment({ x: 0, y: 0, w: 1000, h: 500 }, 1000, 500)
    expect(c).toBeGreaterThanOrEqual(CONTAINMENT_MIN)
  })

  it('returns 1 (neutral) for degenerate frame dims', () => {
    expect(bboxContainment({ x: 0, y: 0, w: 10, h: 10 }, 0, 0)).toBe(1)
  })
})

describe('isEdgeAwareNewBest — edge-containment factor', () => {
  it('a fully-contained frame beats a border-clipped one of near-equal confidence', () => {
    // Same (touching) tier — both edgeClear:false. The clipped candidate has
    // slightly HIGHER raw confidence but low containment; the contained peak
    // wins on the effective score (confidence × containment).
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.7, edgeClear: false, containment: 1 },
        { confidence: 0.72, edgeClear: false, containment: 0.6 },
        0.05,
      ),
    ).toBe(false)
  })

  it('a contained candidate overturns a held clipped peak of near-equal confidence', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.72, edgeClear: false, containment: 0.6 },
        { confidence: 0.7, edgeClear: false, containment: 1 },
        0.05,
      ),
    ).toBe(true)
  })

  it('a DECISIVELY higher-confidence clipped candidate still wins over a contained peak', () => {
    // effective clipped = 0.95 × 0.65 ≈ 0.62 > contained 0.5 × 1 = 0.5 → clipped wins.
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.5, edgeClear: false, containment: 1 },
        { confidence: 0.95, edgeClear: false, containment: 0.65 },
        0.05,
      ),
    ).toBe(true)
  })

  it('containment omitted on both sides preserves pure-confidence behaviour', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.5, edgeClear: false },
        { confidence: 0.7, edgeClear: false },
        0.05,
      ),
    ).toBe(true)
  })
})

describe('bboxCenterScore', () => {
  it('scores a dead-centre subject 1', () => {
    // 100×100 box centred in a 1000×500 frame.
    expect(bboxCenterScore({ x: 450, y: 200, w: 100, h: 100 }, 1000, 500)).toBeCloseTo(1, 5)
  })

  it('scores a corner subject near 0', () => {
    const s = bboxCenterScore({ x: 0, y: 0, w: 10, h: 10 }, 1000, 500)
    expect(s).toBeLessThan(0.05)
  })

  it('a mid-edge subject scores higher than a corner one', () => {
    const midEdge = bboxCenterScore({ x: 450, y: 0, w: 100, h: 20 }, 1000, 500)
    const corner = bboxCenterScore({ x: 0, y: 0, w: 20, h: 20 }, 1000, 500)
    expect(midEdge).toBeGreaterThan(corner)
  })

  it('returns 1 (neutral) for degenerate frame dims', () => {
    expect(bboxCenterScore({ x: 0, y: 0, w: 10, h: 10 }, 0, 0)).toBe(1)
  })
})

// ── 2026-07-22 best-shot quality triage: size-aware score + decisive bypass ──
import {
  bboxSizeScore,
  isDecisiveImprovement,
  SIZE_SCORE_SATURATION_AREA_FRAC,
  DECISIVE_IMPROVEMENT_RATIO,
} from '../edge-clear.js'

describe('bboxSizeScore', () => {
  it('saturates to 1 at/above the saturation area fraction', () => {
    const W = 640
    const H = 360
    const sideArea = W * H * SIZE_SCORE_SATURATION_AREA_FRAC
    const w = Math.sqrt(sideArea)
    expect(bboxSizeScore({ x: 0, y: 0, w, h: w }, W, H)).toBeCloseTo(1, 5)
    expect(bboxSizeScore({ x: 0, y: 0, w: W, h: H }, W, H)).toBe(1)
  })

  it('scores a bigger subject strictly higher than a smaller one', () => {
    const small = bboxSizeScore({ x: 0, y: 0, w: 20, h: 40 }, 640, 360)
    const big = bboxSizeScore({ x: 0, y: 0, w: 120, h: 130 }, 640, 360)
    expect(big).toBeGreaterThan(small)
    expect(small).toBeGreaterThan(0)
  })

  it('degenerate frame dims are neutral (1)', () => {
    expect(bboxSizeScore({ x: 0, y: 0, w: 10, h: 10 }, 0, 0)).toBe(1)
  })
})

describe('size-aware isEdgeAwareNewBest', () => {
  it('a much bigger same-tier subject beats an equal-confidence smaller one', () => {
    // d4dc1209 replay: distant view (area ~4.5k) held; close view (~16k) lands.
    const held = {
      confidence: 0.85,
      edgeClear: true,
      containment: 1,
      sizeScore: 0.44,
    }
    const cand = {
      confidence: 0.85,
      edgeClear: true,
      containment: 1,
      sizeScore: 0.84,
    }
    expect(isEdgeAwareNewBest(held, cand, 0.05)).toBe(true)
  })

  it('sizeScore omitted (face/object callers) keeps legacy confidence policy', () => {
    const held = { confidence: 0.9, edgeClear: true }
    const cand = { confidence: 0.91, edgeClear: true }
    expect(isEdgeAwareNewBest(held, cand, 0.05)).toBe(false)
  })
})

describe('isDecisiveImprovement', () => {
  it('true when the effective score improves by the decisive ratio (same tier)', () => {
    // Size factor maps to [0.5,1]: held 0.2 → 0.6, cand 1.0 → 1.0 (ratio 1.67).
    const held = { confidence: 0.6, edgeClear: true, sizeScore: 0.2 }
    const cand = { confidence: 0.6, edgeClear: true, sizeScore: 1 }
    expect(isDecisiveImprovement(held, cand)).toBe(true)
    expect(DECISIVE_IMPROVEMENT_RATIO).toBeLessThan(1.67)
  })

  it('false for a modest improvement', () => {
    const held = { confidence: 0.6, edgeClear: true, sizeScore: 0.5 }
    const cand = { confidence: 0.62, edgeClear: true, sizeScore: 0.5 }
    expect(isDecisiveImprovement(held, cand)).toBe(false)
  })

  it('never decisive on a tier DOWNGRADE', () => {
    const held = { confidence: 0.3, edgeClear: true }
    const cand = { confidence: 0.99, edgeClear: false }
    expect(isDecisiveImprovement(held, cand)).toBe(false)
  })
})

describe('square-containment tier (subject-on-the-side, 2026-08-21)', () => {
  it('a square-contained candidate beats an evicted peak regardless of confidence', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.9, edgeClear: true, squareFraction: 0.08 },
        { confidence: 0.4, edgeClear: true, squareFraction: 1 },
        0.05,
      ),
    ).toBe(true)
  })

  it('an evicted candidate NEVER replaces a contained peak, even at far higher confidence', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.4, edgeClear: true, squareFraction: 1 },
        { confidence: 0.95, edgeClear: true, squareFraction: 0.08 },
        0.05,
      ),
    ).toBe(false)
  })

  it('the square tier outranks the edge tier: a delivered subject beats a delivered background', () => {
    // Feet grazing the bottom border (edge-touching) but fully inside the
    // delivered square, vs an edge-clear frame whose subject the square
    // consumers cut entirely.
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.6, edgeClear: true, squareFraction: 0.08 },
        { confidence: 0.4, edgeClear: false, squareFraction: 1 },
        0.05,
      ),
    ).toBe(true)
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.4, edgeClear: false, squareFraction: 1 },
        { confidence: 0.6, edgeClear: true, squareFraction: 0.08 },
        0.05,
      ),
    ).toBe(false)
  })

  it('within the below-threshold tier a MORE-contained frame wins on the effective score', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.5, edgeClear: true, squareFraction: 0.1 },
        { confidence: 0.5, edgeClear: true, squareFraction: 0.4 },
        0.05,
      ),
    ).toBe(true)
  })

  it('omitted on both sides preserves the legacy edge/confidence behaviour', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.5, edgeClear: true },
        { confidence: 0.56, edgeClear: true },
        0.05,
      ),
    ).toBe(true)
  })

  it('never decisive on a square-tier DOWNGRADE', () => {
    expect(
      isDecisiveImprovement(
        { confidence: 0.1, edgeClear: true, squareFraction: 1 },
        { confidence: 0.99, edgeClear: true, squareFraction: 0.08 },
      ),
    ).toBe(false)
  })
})

// ── SEMANTIC tier (D-semantic-bestshot, 2026-08-21) ─────────────────────────
//
// A frame from which a RECOGNITION actually succeeded (face auto-matched,
// plate read attributed, fine classification accepted) outranks any frame
// that proved nothing — the best shot should be the frame that PROVED
// something. Tier order, outermost first: square-containment (a delivered
// subject beats a delivered background — track ec0eb76d…), then SEMANTIC,
// then edge-clear, then the effective score.

describe('semantic tier (recognition-bearing frame)', () => {
  it('a semantic candidate beats a non-semantic held peak even at far lower confidence', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.95, edgeClear: true },
        { confidence: 0.3, edgeClear: true, semantic: true },
        0.05,
      ),
    ).toBe(true)
  })

  it('a non-semantic candidate NEVER displaces a semantic peak, whatever its confidence', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.3, edgeClear: true, semantic: true },
        { confidence: 0.99, edgeClear: true },
        0.05,
      ),
    ).toBe(false)
  })

  it('square containment stays ABOVE semantic: a square-EVICTED semantic frame never beats a contained one', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.5, edgeClear: true, squareFraction: 1 },
        {
          confidence: 0.9,
          edgeClear: true,
          semantic: true,
          squareFraction: 0.1,
        },
        0.05,
      ),
    ).toBe(false)
  })

  it('a square-contained non-semantic candidate still rescues a square-evicted semantic peak', () => {
    expect(
      isEdgeAwareNewBest(
        {
          confidence: 0.9,
          edgeClear: true,
          semantic: true,
          squareFraction: 0.1,
        },
        { confidence: 0.4, edgeClear: true, squareFraction: 1 },
        0.05,
      ),
    ).toBe(true)
  })

  it('a semantic edge-TOUCHING frame beats a non-semantic edge-CLEAR one (semantic outranks edge)', () => {
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.9, edgeClear: true },
        { confidence: 0.5, edgeClear: false, semantic: true },
        0.05,
      ),
    ).toBe(true)
  })

  it('WITHIN the semantic tier the edge tier still orders frames', () => {
    // Both semantic: clear beats touching regardless of confidence.
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.9, edgeClear: false, semantic: true },
        { confidence: 0.5, edgeClear: true, semantic: true },
        0.05,
      ),
    ).toBe(true)
    // Both semantic + both clear: effective score + hysteresis as always.
    expect(
      isEdgeAwareNewBest(
        { confidence: 0.6, edgeClear: true, semantic: true },
        { confidence: 0.62, edgeClear: true, semantic: true },
        0.05,
      ),
    ).toBe(false)
  })

  it('isDecisiveImprovement is never decisive on a semantic downgrade', () => {
    expect(
      isDecisiveImprovement(
        { confidence: 0.3, edgeClear: true, semantic: true, sizeScore: 0.1 },
        { confidence: 0.95, edgeClear: true, sizeScore: 1 },
      ),
    ).toBe(false)
  })
})
