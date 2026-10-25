import { describe, it, expect } from 'vitest'
import {
  ZoneTransitionTracker,
  DEFAULT_ENTER_FRAMES,
  DEFAULT_EXIT_FRAMES,
} from '../zone-transition-tracker.js'

const USCIO = 'cfeec78c-8d69-4678-9d25-937193eacb5d'
const AIUOLA = 'fa03b60a'

describe('ZoneTransitionTracker', () => {
  it('confirms an entry only once it has persisted', () => {
    const t = new ZoneTransitionTracker({ enterFrames: 2 })
    expect(t.observe('a', [USCIO])).toEqual({ entered: [], exited: [] })
    expect(t.observe('a', [USCIO])).toEqual({ entered: [USCIO], exited: [] })
  })

  it('reports an entry ONCE, not on every frame the subject stays inside', () => {
    const t = new ZoneTransitionTracker({ enterFrames: 1 })
    expect(t.observe('a', [USCIO]).entered).toEqual([USCIO])
    for (let i = 0; i < 50; i++) expect(t.observe('a', [USCIO]).entered).toEqual([])
  })

  it('NEVER emits for a one-frame graze — the flutter this exists to stop', () => {
    const t = new ZoneTransitionTracker()
    // A bbox wobbling across the boundary on alternate frames.
    for (let i = 0; i < 20; i++) {
      expect(t.observe('a', i % 2 === 0 ? [USCIO] : []).entered).toEqual([])
    }
  })

  it('waits longer to believe an exit than an entry', () => {
    const t = new ZoneTransitionTracker({ enterFrames: 1, exitFrames: 3 })
    t.observe('a', [USCIO])
    expect(t.observe('a', []).exited).toEqual([])
    expect(t.observe('a', []).exited).toEqual([])
    expect(t.observe('a', []).exited).toEqual([USCIO])
  })

  it('treats a momentary occlusion as still inside, not as an exit', () => {
    const t = new ZoneTransitionTracker({ enterFrames: 1, exitFrames: 4 })
    t.observe('a', [USCIO])
    t.observe('a', []) // lost for two frames…
    t.observe('a', [])
    expect(t.observe('a', [USCIO])).toEqual({ entered: [], exited: [] }) // …then back
    // The streak was cancelled, not merely decremented: a further two frames
    // out must NOT complete the earlier exit.
    expect(t.observe('a', []).exited).toEqual([])
    expect(t.observe('a', []).exited).toEqual([])
  })

  it('breaks an entry streak when the subject leaves before it confirms', () => {
    const t = new ZoneTransitionTracker({ enterFrames: 3 })
    t.observe('a', [USCIO])
    t.observe('a', [USCIO])
    t.observe('a', []) // gone — streak resets
    t.observe('a', [USCIO])
    expect(t.observe('a', [USCIO]).entered).toEqual([]) // only 2 in a row again
    expect(t.observe('a', [USCIO]).entered).toEqual([USCIO])
  })

  it('handles several zones on one subject independently', () => {
    const t = new ZoneTransitionTracker({ enterFrames: 1, exitFrames: 1 })
    expect([...t.observe('a', [USCIO, AIUOLA]).entered].sort()).toEqual([AIUOLA, USCIO].sort())
    const r = t.observe('a', [AIUOLA])
    expect(r.exited).toEqual([USCIO])
    expect(r.entered).toEqual([])
    expect(t.zonesFor('a')).toEqual([AIUOLA])
  })

  it('keeps subjects apart — one crossing says nothing about another', () => {
    const t = new ZoneTransitionTracker({ enterFrames: 1 })
    expect(t.observe('a', [USCIO]).entered).toEqual([USCIO])
    expect(t.observe('b', []).entered).toEqual([])
    expect(t.zonesFor('a')).toEqual([USCIO])
    expect(t.zonesFor('b')).toEqual([])
  })

  it('reports the zones still occupied when a track vanishes', () => {
    // The 2026-07-31 case: the subject walks OUT OF FRAME while inside the
    // zone. Nothing else will ever close that presence.
    const t = new ZoneTransitionTracker({ enterFrames: 1 })
    t.observe('a', [USCIO, AIUOLA])
    expect([...t.forget('a')].sort()).toEqual([AIUOLA, USCIO].sort())
    expect(t.size()).toBe(0)
  })

  it('forgets a track that never confirmed a zone without inventing an exit', () => {
    const t = new ZoneTransitionTracker({ enterFrames: 5 })
    t.observe('a', [USCIO])
    expect(t.forget('a')).toEqual([])
  })

  it('does not leak state for tracks that come and go', () => {
    const t = new ZoneTransitionTracker()
    for (let i = 0; i < 100; i++) {
      t.observe(`t${i}`, [USCIO])
      t.forget(`t${i}`)
    }
    expect(t.size()).toBe(0)
  })

  it('ships defaults that are responsive on entry and patient on exit', () => {
    expect(DEFAULT_ENTER_FRAMES).toBeLessThan(DEFAULT_EXIT_FRAMES)
  })
})
