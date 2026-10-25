import { describe, it, expect } from 'vitest'
import { emptyAudioConfirmState, observeAudioConfirm } from '../audio-confirm-window'

const S = 1000
const cfg = { confirmHits: 2, confirmWindowSec: 5 }

describe('observeAudioConfirm', () => {
  it('confirms every frame when confirmHits <= 1 (unset = no grouping)', () => {
    const r = observeAudioConfirm(
      emptyAudioConfirmState(),
      { className: 'dog', timestampMs: 0 },
      {
        confirmHits: 1,
        confirmWindowSec: 5,
      },
    )
    expect(r.confirmed).toBe(true)
  })

  it('holds the first occurrence and confirms the second inside the window', () => {
    const a = observeAudioConfirm(
      emptyAudioConfirmState(),
      { className: 'dog', timestampMs: 0 },
      cfg,
    )
    expect(a.confirmed).toBe(false)
    const b = observeAudioConfirm(a.nextState, { className: 'dog', timestampMs: 3 * S }, cfg)
    expect(b.confirmed).toBe(true)
  })

  it('never confirms occurrences spread wider than the window', () => {
    let st = emptyAudioConfirmState()
    for (const at of [0, 6 * S, 12 * S, 18 * S]) {
      const r = observeAudioConfirm(st, { className: 'dog', timestampMs: at }, cfg)
      expect(r.confirmed).toBe(false)
      st = r.nextState
    }
  })

  it('counts each class on its own — two different sounds never corroborate each other', () => {
    const a = observeAudioConfirm(
      emptyAudioConfirmState(),
      { className: 'dog', timestampMs: 0 },
      cfg,
    )
    const b = observeAudioConfirm(a.nextState, { className: 'speech', timestampMs: S }, cfg)
    expect(b.confirmed).toBe(false)
    const c = observeAudioConfirm(b.nextState, { className: 'dog', timestampMs: 2 * S }, cfg)
    expect(c.confirmed).toBe(true)
  })

  it('re-arms after confirming: the next event needs a fresh count', () => {
    const a = observeAudioConfirm(
      emptyAudioConfirmState(),
      { className: 'dog', timestampMs: 0 },
      cfg,
    )
    const b = observeAudioConfirm(a.nextState, { className: 'dog', timestampMs: S }, cfg)
    expect(b.confirmed).toBe(true)
    const c = observeAudioConfirm(b.nextState, { className: 'dog', timestampMs: 2 * S }, cfg)
    expect(c.confirmed).toBe(false)
  })

  it('does not mutate the state it was given', () => {
    const st = emptyAudioConfirmState()
    const r = observeAudioConfirm(st, { className: 'dog', timestampMs: 0 }, cfg)
    expect(r.nextState).not.toBe(st)
    expect(observeAudioConfirm(st, { className: 'dog', timestampMs: 0 }, cfg).confirmed).toBe(false)
  })
})
