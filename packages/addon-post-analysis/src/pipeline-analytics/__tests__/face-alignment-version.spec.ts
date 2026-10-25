/**
 * The alignment stamp on a gallery sample (D643).
 *
 * The SCRFD fix (2026-09-26) moved every aligned template: the anchors and the
 * input normalisation changed, so a face aligned before the deploy and one
 * aligned after are different pixels of the same person. The stamp is how
 * "new vs old" becomes a query instead of a guess. It is AUDIT-ONLY — matching
 * reads every sample regardless — but the prune reads it, so the one direction
 * that must never happen is a pre-fix face stamped as post-fix.
 */
import { describe, expect, it } from 'vitest'
import {
  alignmentForCapturedFace,
  FACE_ALIGNMENT_SCRFD_V2,
  isV2Aligned,
  parseFaceAlignment,
  SCRFD_V2_ALIGNMENT_SINCE_MS,
} from '../face-alignment-version.js'

describe('alignmentForCapturedFace', () => {
  it('stamps a face captured after the fixed detector was live everywhere as v2', () => {
    expect(alignmentForCapturedFace(SCRFD_V2_ALIGNMENT_SINCE_MS)).toBe(FACE_ALIGNMENT_SCRFD_V2)
    expect(alignmentForCapturedFace(SCRFD_V2_ALIGNMENT_SINCE_MS + 60_000)).toBe(
      FACE_ALIGNMENT_SCRFD_V2,
    )
  })

  it('leaves a face captured BEFORE the cutoff unstamped (v1) — a buffered pre-fix face assigned today is still old-aligned', () => {
    expect(alignmentForCapturedFace(SCRFD_V2_ALIGNMENT_SINCE_MS - 1)).toBeUndefined()
  })

  it('places the cutoff after the last node took the fix (hub 12:08Z, agent-a 12:08Z on 2026-09-26)', () => {
    expect(SCRFD_V2_ALIGNMENT_SINCE_MS).toBeGreaterThanOrEqual(Date.UTC(2026, 8, 26, 12, 9))
  })
})

describe('parseFaceAlignment / isV2Aligned', () => {
  it('reads the stored column back, and anything else is v1', () => {
    expect(parseFaceAlignment('scrfd-v2')).toBe(FACE_ALIGNMENT_SCRFD_V2)
    expect(parseFaceAlignment(null)).toBeUndefined()
    expect(parseFaceAlignment(undefined)).toBeUndefined()
    expect(parseFaceAlignment('scrfd-v9')).toBeUndefined()
    expect(isV2Aligned({ alignment: FACE_ALIGNMENT_SCRFD_V2 })).toBe(true)
    expect(isV2Aligned({})).toBe(false)
  })
})
