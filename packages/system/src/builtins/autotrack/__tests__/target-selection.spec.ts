import { describe, expect, it } from 'vitest'
import {
  INITIAL_TARGET_SELECTION_STATE,
  selectTarget,
  type TargetCandidate,
  type TargetSelectionState,
} from '../target-selection.js'

const DELAY = 15_000
const NOW = 500_000

function candidate(trackId: string, areaPx: number): TargetCandidate {
  return { trackId, areaPx }
}

describe('selectTarget', () => {
  it('acquires the largest candidate when nothing is held', () => {
    const out = selectTarget(INITIAL_TARGET_SELECTION_STATE, {
      nowMs: NOW,
      candidates: [candidate('a', 100), candidate('b', 400)],
      disappearDelayMs: DELAY,
    })
    expect(out.trackId).toBe('b')
    expect(out.reason).toBe('acquired')
    expect(out.present).toBe(true)
  })

  it('breaks an exact tie deterministically instead of following detector order', () => {
    const first = selectTarget(INITIAL_TARGET_SELECTION_STATE, {
      nowMs: NOW,
      candidates: [candidate('b', 100), candidate('a', 100)],
      disappearDelayMs: DELAY,
    })
    const second = selectTarget(INITIAL_TARGET_SELECTION_STATE, {
      nowMs: NOW,
      candidates: [candidate('a', 100), candidate('b', 100)],
      disappearDelayMs: DELAY,
    })
    expect(first.trackId).toBe(second.trackId)
  })

  it('stays on the held track even when a bigger one appears — the sticky rule', () => {
    const held: TargetSelectionState = { trackId: 'a', lastSeenAtMs: NOW }
    const out = selectTarget(held, {
      nowMs: NOW + 100,
      candidates: [candidate('a', 10), candidate('b', 10_000)],
      disappearDelayMs: DELAY,
    })
    expect(out.trackId).toBe('a')
    expect(out.reason).toBe('held')
  })

  it('reports an absent frame WITHOUT releasing, and does not advance lastSeen', () => {
    const held: TargetSelectionState = { trackId: 'a', lastSeenAtMs: NOW }
    const out = selectTarget(held, {
      nowMs: NOW + 1_000,
      candidates: [candidate('b', 10_000)],
      disappearDelayMs: DELAY,
    })
    expect(out.trackId).toBe('a')
    expect(out.present).toBe(false)
    expect(out.reason).toBe('held-absent')
    expect(out.state.lastSeenAtMs).toBe(NOW)
  })

  it('releases only after the disappear delay', () => {
    const held: TargetSelectionState = { trackId: 'a', lastSeenAtMs: NOW }
    const out = selectTarget(held, {
      nowMs: NOW + DELAY,
      candidates: [],
      disappearDelayMs: DELAY,
    })
    expect(out.trackId).toBeNull()
    expect(out.reason).toBe('released')
  })

  it('switches to a new candidate on the frame the old target is released', () => {
    const held: TargetSelectionState = { trackId: 'a', lastSeenAtMs: NOW }
    const out = selectTarget(held, {
      nowMs: NOW + DELAY,
      candidates: [candidate('b', 50)],
      disappearDelayMs: DELAY,
    })
    expect(out.trackId).toBe('b')
    expect(out.reason).toBe('switched')
    expect(out.present).toBe(true)
  })

  it('is idle, not absent, when nothing is held and nothing is on offer', () => {
    const out = selectTarget(INITIAL_TARGET_SELECTION_STATE, {
      nowMs: NOW,
      candidates: [],
      disappearDelayMs: DELAY,
    })
    expect(out.reason).toBe('idle')
    expect(out.trackId).toBeNull()
  })

  it('never mutates the state it was given', () => {
    const held: TargetSelectionState = { trackId: 'a', lastSeenAtMs: NOW }
    const snapshot = JSON.stringify(held)
    selectTarget(held, { nowMs: NOW + 1, candidates: [], disappearDelayMs: DELAY })
    expect(JSON.stringify(held)).toBe(snapshot)
  })
})
