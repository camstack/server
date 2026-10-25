/**
 * Unit tests for the frame-push scrub controller (R9).
 *
 * Ported from the proven srcV2 viewer implementation
 * (camstack/srcV2/recording/__tests__/scrub-controller.spec.ts) — the same
 * pure reducer / throttle / commit-dedupe / live-bypass semantics now drive
 * the admin-ui RecordingTimeline through the `camstack-control` datachannel.
 */
import { describe, it, expect, vi } from 'vitest'
import {
  initialScrubState,
  scrubReducer,
  shouldEmit,
  shouldCommit,
  cursorFractionFor,
  makeScrubBridge,
} from '../scrub-controller'

describe('scrubReducer', () => {
  it('begin sets scrubbing + records the source', () => {
    const s = scrubReducer(initialScrubState, { type: 'begin', source: 'heatmap' })
    expect(s.scrubbing).toBe(true)
    expect(s.lastSource).toBe('heatmap')
  })
  it('update sets scrubEpoch + source while scrubbing', () => {
    const s = scrubReducer(
      { ...initialScrubState, scrubbing: true },
      { type: 'update', epoch: 1000, source: 'timeline' },
    )
    expect(s.scrubEpoch).toBe(1000)
    expect(s.lastSource).toBe('timeline')
  })
  it('end clears scrubbing, promotes epoch to playhead, keeps source', () => {
    const s = scrubReducer(
      { ...initialScrubState, scrubbing: true, scrubEpoch: 1000, lastSource: 'heatmap' },
      { type: 'end', epoch: 1200, source: 'heatmap' },
    )
    expect(s.scrubbing).toBe(false)
    expect(s.scrubEpoch).toBeNull()
    expect(s.playheadEpoch).toBe(1200)
    expect(s.lastSource).toBe('heatmap')
  })
  it('seek sets playhead + source without scrubbing', () => {
    const s = scrubReducer(initialScrubState, { type: 'seek', epoch: 500, source: 'timeline' })
    expect(s.scrubbing).toBe(false)
    expect(s.playheadEpoch).toBe(500)
    expect(s.lastSource).toBe('timeline')
  })
  it('playhead from the server does NOT change lastSource (no gesture)', () => {
    const s = scrubReducer(
      { ...initialScrubState, lastSource: 'heatmap' },
      { type: 'playhead', epoch: 9000 },
    )
    expect(s.playheadEpoch).toBe(9000)
    expect(s.lastSource).toBe('heatmap')
  })
  it('playhead is ignored while scrubbing (scrub target wins)', () => {
    const s = scrubReducer(
      { ...initialScrubState, scrubbing: true, scrubEpoch: 1000 },
      { type: 'playhead', epoch: 9000 },
    )
    expect(s.playheadEpoch).toBeNull()
  })
  it('begin clears any stale scrubEpoch from a prior gesture', () => {
    const s = scrubReducer(
      { ...initialScrubState, scrubEpoch: 4242, lastSource: 'timeline' },
      { type: 'begin', source: 'heatmap' },
    )
    expect(s.scrubbing).toBe(true)
    expect(s.scrubEpoch).toBeNull()
    expect(s.lastSource).toBe('heatmap')
  })
  it('reset returns to the initial state (mode exits / channel drop)', () => {
    const s = scrubReducer(
      { scrubbing: true, scrubEpoch: 1, playheadEpoch: 2, lastSource: 'timeline' },
      { type: 'reset' },
    )
    expect(s).toEqual(initialScrubState)
  })
})

describe('shouldEmit', () => {
  it('coalesces emits to the throttle window', () => {
    expect(shouldEmit(1000, 1000 + 70)).toBe(true)
    expect(shouldEmit(1000, 1000 + 30)).toBe(false)
  })
})

describe('shouldCommit (drop redundant feeder reloads)', () => {
  it('always commits the first time (no prior commit)', () => {
    expect(shouldCommit(null, 1000, 5000)).toBe(true)
  })
  it('drops an exact-duplicate commit within the dedupe window', () => {
    // The bug: the same epoch committed twice ~200ms apart → two feeder reloads.
    expect(shouldCommit({ epoch: 1000, at: 5000 }, 1000, 5200)).toBe(false)
  })
  it('drops a tiny nudge near the last target within the window', () => {
    expect(shouldCommit({ epoch: 1_000_000, at: 5000 }, 1_000_400, 5300)).toBe(false)
  })
  it('commits a genuinely different (far) target', () => {
    expect(shouldCommit({ epoch: 1_000_000, at: 5000 }, 1_060_000, 5300)).toBe(true)
  })
  it('commits a re-seek to the same spot once the window has elapsed', () => {
    expect(shouldCommit({ epoch: 1000, at: 5000 }, 1000, 5000 + 3000)).toBe(true)
  })
})

describe('makeScrubBridge (ungated sink wiring)', () => {
  const newSink = () => ({
    scrubStart: vi.fn(),
    scrubTo: vi.fn(),
    scrubCommit: vi.fn(),
    seek: vi.fn(),
  })

  it('drives the sink on a drag even with no prior tap (ungated)', () => {
    const sink = newSink()
    const dispatch = vi.fn()
    const lastEmitRef = { current: 0 }
    const bridge = makeScrubBridge(sink, dispatch, lastEmitRef)

    bridge.beginScrub('timeline')
    bridge.updateScrub(6000, 'timeline')
    bridge.endScrub(6000, 'timeline')

    expect(sink.scrubStart).toHaveBeenCalled()
    expect(sink.scrubTo).toHaveBeenCalledWith(6000)
    expect(sink.scrubCommit).toHaveBeenCalledWith(6000)
  })

  it('a tap issues a direct seek', () => {
    const sink = newSink()
    const dispatch = vi.fn()
    const lastEmitRef = { current: 0 }
    const bridge = makeScrubBridge(sink, dispatch, lastEmitRef)

    bridge.seek(6000, 'heatmap')

    expect(sink.seek).toHaveBeenCalledWith(6000)
  })

  it('dispatches the reducer action for each gesture', () => {
    const sink = newSink()
    const dispatch = vi.fn()
    const bridge = makeScrubBridge(sink, dispatch, { current: 0 })

    bridge.beginScrub('timeline')
    bridge.updateScrub(1000, 'timeline')
    bridge.endScrub(1200, 'timeline')
    bridge.seek(500, 'heatmap')
    bridge.setPlayhead(9000)

    expect(dispatch).toHaveBeenNthCalledWith(1, { type: 'begin', source: 'timeline' })
    expect(dispatch).toHaveBeenNthCalledWith(2, { type: 'update', epoch: 1000, source: 'timeline' })
    expect(dispatch).toHaveBeenNthCalledWith(3, { type: 'end', epoch: 1200, source: 'timeline' })
    expect(dispatch).toHaveBeenNthCalledWith(4, { type: 'seek', epoch: 500, source: 'heatmap' })
    expect(dispatch).toHaveBeenNthCalledWith(5, { type: 'playhead', epoch: 9000 })
  })

  it('drops a duplicate scrubCommit fired twice in quick succession', () => {
    const sink = newSink()
    const lastCommitRef = { current: null as { epoch: number; at: number } | null }
    const bridge = makeScrubBridge(sink, vi.fn(), { current: 0 }, lastCommitRef)

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(5000)
    bridge.endScrub(1000, 'heatmap') // commits
    nowSpy.mockReturnValue(5200)
    bridge.endScrub(1000, 'heatmap') // duplicate → dropped
    nowSpy.mockRestore()

    expect(sink.scrubCommit).toHaveBeenCalledTimes(1)
    expect(sink.scrubCommit).toHaveBeenCalledWith(1000)
  })

  it('drops a seek that duplicates the last commit, but allows a far one', () => {
    const sink = newSink()
    const lastCommitRef = { current: null as { epoch: number; at: number } | null }
    const bridge = makeScrubBridge(sink, vi.fn(), { current: 0 }, lastCommitRef)

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(5000)
    bridge.seek(1_000_000, 'heatmap') // commits
    nowSpy.mockReturnValue(5100)
    bridge.seek(1_000_100, 'heatmap') // near-duplicate → dropped
    nowSpy.mockReturnValue(5200)
    bridge.seek(2_000_000, 'heatmap') // far → commits
    nowSpy.mockRestore()

    expect(sink.seek).toHaveBeenCalledTimes(2)
    expect(sink.seek).toHaveBeenNthCalledWith(1, 1_000_000)
    expect(sink.seek).toHaveBeenNthCalledWith(2, 2_000_000)
  })

  it('still dispatches the state action even when the commit is deduped', () => {
    const sink = newSink()
    const dispatch = vi.fn()
    const lastCommitRef = { current: null as { epoch: number; at: number } | null }
    const bridge = makeScrubBridge(sink, dispatch, { current: 0 }, lastCommitRef)

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(5000)
    bridge.endScrub(1000, 'heatmap')
    nowSpy.mockReturnValue(5200)
    bridge.endScrub(1000, 'heatmap') // commit deduped, but state still moves
    nowSpy.mockRestore()

    expect(dispatch).toHaveBeenCalledWith({ type: 'end', epoch: 1000, source: 'heatmap' })
    expect(dispatch).toHaveBeenCalledTimes(2)
  })

  it('never dedupes a commit while the player is LIVE (live→recorded must reach the server)', () => {
    const sink = newSink()
    const lastCommitRef = { current: null as { epoch: number; at: number } | null }
    let live = true
    const bridge = makeScrubBridge(sink, vi.fn(), { current: 0 }, lastCommitRef, () => live)

    const nowSpy = vi.spyOn(Date, 'now')
    // First scrub while live → commits (and records lastCommit).
    nowSpy.mockReturnValue(5000)
    bridge.seek(1_000_000, 'timeline')
    // Re-scrub to the SAME epoch within the dedupe window: normally dropped, but
    // the player is still live, so it MUST fire again (otherwise it stays live).
    nowSpy.mockReturnValue(5100)
    bridge.seek(1_000_000, 'timeline')
    // Once the player has actually entered recorded, the near-duplicate IS deduped.
    live = false
    nowSpy.mockReturnValue(5200)
    bridge.seek(1_000_000, 'timeline')
    nowSpy.mockRestore()

    expect(sink.seek).toHaveBeenCalledTimes(2)
    expect(sink.seek).toHaveBeenNthCalledWith(1, 1_000_000)
    expect(sink.seek).toHaveBeenNthCalledWith(2, 1_000_000)
  })

  it('throttles continuous updates via the shared lastEmitRef', () => {
    const sink = newSink()
    const lastEmitRef = { current: 0 }
    const bridge = makeScrubBridge(sink, vi.fn(), lastEmitRef)

    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1000)
    bridge.updateScrub(100, 'timeline') // first emit (1000 - 0 >= 70)
    nowSpy.mockReturnValue(1030)
    bridge.updateScrub(200, 'timeline') // coalesced (1030 - 1000 < 70)
    nowSpy.mockReturnValue(1100)
    bridge.updateScrub(300, 'timeline') // emits again (1100 - 1000 >= 70)
    nowSpy.mockRestore()

    expect(sink.scrubTo).toHaveBeenCalledTimes(2)
    expect(sink.scrubTo).toHaveBeenNthCalledWith(1, 100)
    expect(sink.scrubTo).toHaveBeenNthCalledWith(2, 300)
  })
})

describe('cursorFractionFor', () => {
  it('uses scrubEpoch while scrubbing, else playheadEpoch', () => {
    const day = { from: 0, to: 100 }
    expect(
      cursorFractionFor({ ...initialScrubState, scrubbing: true, scrubEpoch: 25 }, day),
    ).toBeCloseTo(0.25)
    expect(cursorFractionFor({ ...initialScrubState, playheadEpoch: 80 }, day)).toBeCloseTo(0.8)
  })
  it('returns null when there is no position', () => {
    expect(cursorFractionFor(initialScrubState, { from: 0, to: 100 })).toBeNull()
  })
  it('clamps to [0,1] and guards a zero-width day', () => {
    const day = { from: 0, to: 100 }
    expect(cursorFractionFor({ ...initialScrubState, playheadEpoch: 200 }, day)).toBe(1)
    expect(cursorFractionFor({ ...initialScrubState, playheadEpoch: -5 }, day)).toBe(0)
    expect(
      cursorFractionFor({ ...initialScrubState, playheadEpoch: 50 }, { from: 0, to: 0 }),
    ).toBeNull()
  })
})
