/**
 * ArcFace's raw (pre-L2) feature magnitude is a free quality signal: the
 * postprocessor already computes both the raw vector and its normalized form,
 * and `result-assembler` keeps only the normalized one — the magnitude is
 * discarded one line after it exists.
 *
 * Measured 2026-08-19 over 140 LFW faces pushed through this exact model with
 * this exact preprocessing, degrading each crop:
 *
 *   condition            ||feat|| mean   p05    p95
 *   112px colour                  4.39  3.41   5.25
 *   48px colour                   4.30  3.45   5.25
 *   32px grey                     4.30  3.39   6.14
 *   48px grey + blur              4.35  3.51   6.10
 *   24px grey + blur             10.41  4.75  16.26
 *   16px grey + blur             15.72 12.08  19.05
 *
 * A bound at 6.0 kept 97.6% of usable crops and rejected 93.2% of degenerate
 * ones. The direction is INVERTED relative to the MagFace convention (here the
 * degenerate crops have the LARGER norm); what matters is that it separates.
 *
 * The gate ships DISABLED (bound 0). Those numbers are from LFW, not from this
 * cluster, and the magnitude has never been observable in production precisely
 * because it was being thrown away — so the field and the logging land first,
 * and the operator turns the bound on once a week of live data says where it
 * belongs.
 */
import { describe, expect, it } from 'vitest'
import { embeddingMagnitudeVerdict } from '../embedding-magnitude-gate.js'

describe('embeddingMagnitudeVerdict', () => {
  it('is disabled by a bound of 0 — nothing is ever rejected', () => {
    expect(embeddingMagnitudeVerdict(999, 0)).toBeNull()
    expect(embeddingMagnitudeVerdict(4.4, 0)).toBeNull()
  })

  it('accepts a magnitude at or below the bound', () => {
    expect(embeddingMagnitudeVerdict(4.4, 6)).toBeNull()
    expect(embeddingMagnitudeVerdict(6, 6)).toBeNull()
  })

  it('rejects a magnitude above the bound, naming both numbers', () => {
    const v = embeddingMagnitudeVerdict(10.4, 6)
    expect(v).not.toBeNull()
    expect(v?.magnitude).toBe(10.4)
    expect(v?.bound).toBe(6)
  })

  it('never rejects when the magnitude is unmeasurable (older runner)', () => {
    expect(embeddingMagnitudeVerdict(undefined, 6)).toBeNull()
    expect(embeddingMagnitudeVerdict(Number.NaN, 6)).toBeNull()
  })

  it('separates the measured clean and degenerate populations at 6.0', () => {
    expect(embeddingMagnitudeVerdict(4.39, 6)).toBeNull() // 112px colour mean
    expect(embeddingMagnitudeVerdict(4.35, 6)).toBeNull() // 48px grey+blur mean
    expect(embeddingMagnitudeVerdict(10.41, 6)).not.toBeNull() // 24px grey+blur mean
    expect(embeddingMagnitudeVerdict(15.72, 6)).not.toBeNull() // 16px grey+blur mean
  })
})
