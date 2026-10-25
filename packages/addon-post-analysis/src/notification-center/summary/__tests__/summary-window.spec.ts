import { describe, expect, it } from 'vitest'
import { decideSummaryWindow, motionWindowCloseAt } from '../summary-window.js'

const BOUNDS = { quietMs: 300_000, maxWindowMs: 1_800_000 }

describe('motionWindowCloseAt', () => {
  it('closes a quiet window one quiet period after the LAST motion', () => {
    const out = motionWindowCloseAt({ openedAtMs: 0, lastMotionMs: 60_000 }, BOUNDS)
    expect(out).toEqual({ closeAtMs: 360_000, cappedByCeiling: false })
  })

  it('a busy window is hard-closed at the ceiling and SAYS so', () => {
    // Motion at 29 min on a 30 min ceiling: the quiet close would be 34 min.
    const out = motionWindowCloseAt({ openedAtMs: 0, lastMotionMs: 1_740_000 }, BOUNDS)
    expect(out).toEqual({ closeAtMs: 1_800_000, cappedByCeiling: true })
  })

  it('the ceiling wins on the exact tie', () => {
    const out = motionWindowCloseAt({ openedAtMs: 0, lastMotionMs: 1_500_000 }, BOUNDS)
    expect(out.cappedByCeiling).toBe(true)
  })
})

describe('decideSummaryWindow — the track-close barrier', () => {
  const base = { openedAtMs: 0, closeAtMs: 1_000, barrierMs: 120_000 }

  it('collects while the window is open', () => {
    expect(decideSummaryWindow({ ...base, openTracks: 3, nowMs: 999 })).toEqual({
      kind: 'collecting',
    })
  })

  it('HOLDS a closed window while its own tracks are still running', () => {
    const verdict = decideSummaryWindow({
      ...base,
      openTracks: 2,
      nowMs: 1_000,
    })
    expect(verdict).toEqual({
      kind: 'barrier',
      openTracks: 2,
      deadlineMs: 121_000,
    })
  })

  it('releases the instant the last track closes', () => {
    const verdict = decideSummaryWindow({
      ...base,
      openTracks: 0,
      nowMs: 1_000,
    })
    expect(verdict.kind).toBe('ready')
    if (verdict.kind !== 'ready') throw new Error('unreachable')
    expect(verdict.window).toEqual({ startMs: 0, endMs: 1_000 })
    expect(verdict.barrierBroken).toBe(0)
  })

  it('gives up at the bound and REPORTS how many it gave up on', () => {
    const verdict = decideSummaryWindow({
      ...base,
      openTracks: 2,
      nowMs: 121_000,
    })
    expect(verdict.kind).toBe('ready')
    if (verdict.kind !== 'ready') throw new Error('unreachable')
    // A track that never closes must never hold a digest forever — and the
    // count is what tells an operator the mosaic may be missing a best shot.
    expect(verdict.barrierBroken).toBe(2)
  })

  it('a zero barrier disables the wait entirely', () => {
    const verdict = decideSummaryWindow({
      ...base,
      barrierMs: 0,
      openTracks: 5,
      nowMs: 1_000,
    })
    expect(verdict.kind).toBe('ready')
  })

  it('carries the ceiling flag through to the ready verdict', () => {
    const verdict = decideSummaryWindow({
      ...base,
      openTracks: 0,
      nowMs: 1_000,
      cappedByCeiling: true,
    })
    if (verdict.kind !== 'ready') throw new Error('unreachable')
    expect(verdict.cappedByCeiling).toBe(true)
  })
})
