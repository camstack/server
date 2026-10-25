import { describe, expect, it } from 'vitest'
import { isDecisiveImprovement } from '../edge-clear.js'

/**
 * A materially BIGGER view of the same subject, equally clear, is decisive.
 *
 * The operator's rule: a best shot at the edge is acceptable "solo se non ce ne
 * sono migliori". For the edge tier that already holds — a clear frame beats a
 * touching one unconditionally. The 18.3% of tracks that shipped a stale best
 * lose a different way: the candidate is ALSO clear, just bigger, so no tier
 * upgrade fires and it must clear `DECISIVE_IMPROVEMENT_RATIO` on the COMPOSITE
 * score to bypass the 2 s capture gap.
 *
 * That composite dilutes the very axis that matters. `sizeFactor` is
 * `0.5 + 0.5 × sizeScore`, so even DOUBLING the size score moves it by at most
 * 1.33×; a 1.5× larger subject moves the composite ~1.12× and loses to a 1.25
 * threshold. The frame that a human would call obviously better is discarded by
 * arithmetic, and if the track ends inside the gap it is discarded for good.
 *
 * So size gets its own decisive path — narrow on purpose:
 *  - every existing tier protection still applies (no square, semantic or edge
 *    downgrade may ever be decisive);
 *  - it is about the SIZE axis, so it cannot loosen confidence or containment;
 *  - above `SIZE_SCORE_SATURATION_AREA_FRAC` both scores are 1, so a subject
 *    already filling the frame yields no bypass — which is the saturation
 *    choice ("anything bigger gains no further preference") left intact.
 */
const base = {
  confidence: 0.9,
  containment: 1,
  edgeClear: true,
  squareFraction: 1,
  semantic: false,
}

describe('isDecisiveImprovement — the size axis', () => {
  it('accepts a materially larger view that the composite score would have refused', () => {
    const current = { ...base, sizeScore: 0.3 }
    const candidate = { ...base, sizeScore: 0.45 } // 1.5× the subject
    expect(isDecisiveImprovement(current, candidate)).toBe(true)
  })

  it('refuses a marginally larger one — this is not a licence to churn captures', () => {
    const current = { ...base, sizeScore: 0.3 }
    const candidate = { ...base, sizeScore: 0.33 }
    expect(isDecisiveImprovement(current, candidate)).toBe(false)
  })

  it('yields nothing once both views have saturated', () => {
    // Both fill ≥10% of the frame: the size score says they are equally large,
    // and the saturation choice is that bigger stops mattering there.
    const current = { ...base, sizeScore: 1 }
    const candidate = { ...base, sizeScore: 1 }
    expect(isDecisiveImprovement(current, candidate)).toBe(false)
  })

  it('never rescues a frame that touches the edge, however much bigger', () => {
    const current = { ...base, sizeScore: 0.2 }
    const candidate = { ...base, sizeScore: 1, edgeClear: false }
    expect(isDecisiveImprovement(current, candidate)).toBe(false)
  })

  it('never rescues a square-tier downgrade', () => {
    const current = { ...base, sizeScore: 0.2 }
    const candidate = { ...base, sizeScore: 1, squareFraction: 0.4 }
    expect(isDecisiveImprovement(current, candidate)).toBe(false)
  })

  it('never out-shines a frame that PROVED something about the subject', () => {
    const current = { ...base, sizeScore: 0.2, semantic: true }
    const candidate = { ...base, sizeScore: 1 }
    expect(isDecisiveImprovement(current, candidate)).toBe(false)
  })

  it('still accepts the old composite route — the size path only ADDS', () => {
    const current = { ...base, confidence: 0.4, sizeScore: 0.5 }
    const candidate = { ...base, confidence: 0.9, sizeScore: 0.5 }
    expect(isDecisiveImprovement(current, candidate)).toBe(true)
  })
})
