/**
 * The synthetic scene's ground truth (Task 19 fix round 1, H2): every
 * subject in `buildSyntheticScenario()` keeps ONE identity throughout, so
 * `purities` — the "this track is mixed" marks — must come back empty. A
 * subject resolved from the tape's per-frame ORDINAL rather than from
 * `frame.detections` itself is wrong the moment an ordinal is reused across
 * subjects (P2's occlusion shifts the car from `d2` to `d1`), and marks the
 * pure car track `mixed` at the shift.
 *
 * Disarm: in `synthetic.ts`'s `syntheticTruth`, read `subjectOf(l.det)`
 * directly (the ordinal) instead of resolving through `subjectByOrdinal` —
 * `purities` must stop being empty.
 */
import { describe, expect, it } from 'vitest'
import { buildSyntheticScenario } from '../synthetic.js'

describe('buildSyntheticScenario', () => {
  it('marks no track mixed: every subject keeps one identity throughout', () => {
    expect(buildSyntheticScenario().gt.purities).toEqual([])
  })
})
