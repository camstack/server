import type { SceneMonitorState } from '@camstack/types'
import { SCENE_DIVERGED } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import type { HysteresisStep } from '../scene-scoring.js'
import { coveredConditions, scoreStates, stepHysteresis } from '../scene-scoring.js'

const MODEL = 'clip-vit-b32'
function ref(vec: number[], condition: string, modelId = MODEL) {
  return { embedding: vec, modelId, condition, capturedAt: 1 }
}
function state(id: string, refs: ReturnType<typeof ref>[]): SceneMonitorState {
  return { id, label: id, references: refs, referenceCount: refs.length, currentlyMatched: false }
}

describe('scoreStates', () => {
  const live = [1, 0, 0]
  it('scores only references matching the current condition (Math.max across the subset)', () => {
    const s = state('closed', [ref([1, 0, 0], 'day'), ref([0, 1, 0], 'night')])
    const res = scoreStates([s], live, 'day', MODEL, 3)
    expect(res.bestStateId).toBe('closed')
    expect(res.bestScore).toBeCloseTo(1, 5) // day ref matches, night ref excluded
  })

  // The single most likely regression in this file, because the fallback reads
  // as robustness. It is not: a `day` reference scored against an IR frame
  // collapses the cosine and latches a false "the bin was taken" every night.
  it('does NOT fall back across conditions — an uncovered condition is unknown, never a guess', () => {
    const s = state('closed', [ref([1, 0, 0], 'day')])
    const res = scoreStates([s], live, 'night', MODEL, 3)
    expect(res.bestStateId).toBeNull()
    expect(res.bestScore).toBeNull() // "nothing to compare against", NOT "compared and missed"
  })

  // The OPT-IN escape hatch behind `onUncoveredCondition: 'judge-anyway'`. It
  // stays off by default for the reason the test above states; it exists for
  // the cameras where it is actually true (a floodlit driveway, an
  // always-white-light doorbell) and the operator has said so per scene.
  //
  // NEUTRALIZATION: drop the `crossConditionFallback` branch in
  // `selectConditionRefs` and this goes red while the default-behaviour test
  // above stays green — the two are the only pair that pins both directions.
  it('falls back across conditions ONLY when the caller opts in', () => {
    const s = state('closed', [ref([1, 0, 0], 'day')])
    const res = scoreStates([s], live, 'night', MODEL, 3, { crossConditionFallback: true })
    expect(res.bestStateId).toBe('closed')
    expect(res.bestScore).toBeCloseTo(1, 5)
  })

  // Opting in must not stop an EXACT match from winning: the fallback is a last
  // resort for the uncovered condition, never a widening of the comparison set.
  // A day reference that happens to score higher must not beat the IR reference
  // the operator went outside at 22:00 to capture.
  it('opting in still prefers the exact-condition references when they exist', () => {
    const s = state('closed', [ref([1, 0, 0], 'day'), ref([0, 1, 0], 'ir')])
    const res = scoreStates([s], live, 'ir', MODEL, 3, { crossConditionFallback: true })
    expect(res.bestScore).toBeCloseTo(0, 5) // the `ir` reference, not the `day` one
  })

  it('rejects a reference whose modelId does not match (version gate)', () => {
    const s = state('closed', [ref([1, 0, 0], 'day', 'siglip2-b16')])
    const res = scoreStates([s], live, 'day', MODEL, 3)
    expect(res.bestStateId).toBeNull() // no comparable reference
    expect(res.bestScore).toBeNull() // a model change must never read as divergence
  })

  it('rejects a reference whose dimension does not match the encoder', () => {
    const s = state('closed', [ref([1, 0, 0, 0], 'day')])
    const res = scoreStates([s], live, 'day', MODEL, 3)
    expect(res.bestScore).toBeNull()
  })

  it('distinguishes "compared and did not match" from "nothing comparable"', () => {
    const s = state('closed', [ref([0, 1, 0], 'day')]) // orthogonal → cosine 0
    const res = scoreStates([s], live, 'day', MODEL, 3)
    expect(res.bestStateId).toBe('closed')
    expect(res.bestScore).toBeCloseTo(0, 5) // a real 0, not null — this IS divergence
  })

  it('reports which conditions have a comparable reference (the coverage line)', () => {
    const s = state('closed', [
      ref([1, 0, 0], 'day'),
      ref([0, 1, 0], 'ir'),
      ref([0, 0, 1], 'night', 'siglip2-b16'), // model-gated out — NOT covered
    ])
    expect([...coveredConditions([s], MODEL, 3)].sort()).toEqual(['day', 'ir'])
  })
})

describe('stepHysteresis', () => {
  const start = { currentStateId: null, pendingStateId: null, pendingCount: 0 }
  it('flips only after N consecutive agreeing checks and resets on disagreement', () => {
    let st = stepHysteresis(start, 'open', 3)
    expect(st.currentStateId).toBeNull()
    st = stepHysteresis(st, 'closed', 3) // disagreement resets the pending run
    st = stepHysteresis(st, 'closed', 3)
    st = stepHysteresis(st, 'closed', 3)
    expect(st.currentStateId).toBe('closed') // 3rd agreeing check flips
    expect(st.transitioned).toBe(true)
  })

  // D49 applied to a fallible OBSERVATION: one bad snapshot must not be able to
  // destroy a week of latch state.
  it('never flips on a single reading, in either direction', () => {
    const held = { currentStateId: 'baseline', pendingStateId: null, pendingCount: 0 }
    const st = stepHysteresis(held, SCENE_DIVERGED, 3)
    expect(st.currentStateId).toBe('baseline')
    expect(st.transitioned).toBe(false)
  })

  it('treats the synthetic divergence candidate as an ordinary candidate — leaving a state costs the same N as entering it', () => {
    let st: HysteresisStep = {
      currentStateId: 'baseline',
      pendingStateId: null,
      pendingCount: 0,
      transitioned: false,
    }
    st = stepHysteresis(st, SCENE_DIVERGED, 3)
    st = stepHysteresis(st, SCENE_DIVERGED, 3)
    expect(st.transitioned).toBe(false)
    st = stepHysteresis(st, SCENE_DIVERGED, 3)
    expect(st.currentStateId).toBe(SCENE_DIVERGED)
    expect(st.transitioned).toBe(true)
  })
})
