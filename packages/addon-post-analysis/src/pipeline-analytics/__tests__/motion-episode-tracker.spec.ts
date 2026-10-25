import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MotionEpisodeTracker } from '../motion-episode-tracker.js'

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

describe('MotionEpisodeTracker', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('a rising edge with no open episode inserts a row and opens the episode', async () => {
    const insertRow = vi.fn().mockResolvedValue(101)
    const closeRow = vi.fn().mockResolvedValue(true)
    const tracker = new MotionEpisodeTracker({
      closeAfterMs: 15_000,
      logger: fakeLogger() as never,
      insertRow,
      closeRow,
    })

    await tracker.observe(102, 'onboard', true, 1_000, undefined)

    expect(insertRow).toHaveBeenCalledTimes(1)
    expect(insertRow).toHaveBeenCalledWith({
      deviceId: 102,
      source: 'onboard',
      timestamp: 1_000,
      regionData: undefined,
    })
    expect(closeRow).not.toHaveBeenCalled()
  })

  it('threads regionData through to insertRow, opaque to the tracker itself', async () => {
    const insertRow = vi.fn().mockResolvedValue(101)
    const closeRow = vi.fn().mockResolvedValue(true)
    const tracker = new MotionEpisodeTracker<{ regionCount: number }>({
      closeAfterMs: 15_000,
      logger: fakeLogger() as never,
      insertRow,
      closeRow,
    })

    await tracker.observe(102, 'onboard', true, 1_000, { regionCount: 3 })

    expect(insertRow).toHaveBeenCalledWith(
      expect.objectContaining({ regionData: { regionCount: 3 } }),
    )
  })

  it('a null insert reply opens nothing and logs — a failed write is not a phantom episode', async () => {
    const insertRow = vi.fn().mockResolvedValue(null)
    const closeRow = vi.fn().mockResolvedValue(true)
    const logger = fakeLogger()
    const tracker = new MotionEpisodeTracker({
      closeAfterMs: 15_000,
      logger: logger as never,
      insertRow,
      closeRow,
    })

    await tracker.observe(102, 'onboard', true, 1_000, undefined)
    expect(logger.warn).toHaveBeenCalled()

    // The window elapses; nothing to close because nothing opened.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(closeRow).not.toHaveBeenCalled()

    // The NEXT tick retries the insert rather than treating the earlier
    // failure as a permanently open (or permanently dead) episode.
    await tracker.observe(102, 'onboard', true, 30_000, undefined)
    expect(insertRow).toHaveBeenCalledTimes(2)
  })

  it('a further rising edge inside an open episode does NOT insert a new row', async () => {
    const insertRow = vi.fn().mockResolvedValue(101)
    const closeRow = vi.fn().mockResolvedValue(true)
    const tracker = new MotionEpisodeTracker({
      closeAfterMs: 15_000,
      logger: fakeLogger() as never,
      insertRow,
      closeRow,
    })

    await tracker.observe(102, 'onboard', true, 1_000, undefined)
    await tracker.observe(102, 'onboard', false, 4_000, undefined)
    await tracker.observe(102, 'onboard', true, 9_000, undefined)

    expect(insertRow).toHaveBeenCalledTimes(1)
  })

  it('closes with durationMs = lastOnAt - startedAt and the collected edges, 15s after the LAST edge', async () => {
    const insertRow = vi.fn().mockResolvedValue(101)
    const closeRow = vi.fn().mockResolvedValue(true)
    const tracker = new MotionEpisodeTracker({
      closeAfterMs: 15_000,
      logger: fakeLogger() as never,
      insertRow,
      closeRow,
    })

    await tracker.observe(102, 'onboard', true, 1_000, undefined)
    await vi.advanceTimersByTimeAsync(3_000)
    await tracker.observe(102, 'onboard', false, 4_000, undefined)
    await vi.advanceTimersByTimeAsync(5_000)
    await tracker.observe(102, 'onboard', true, 9_000, undefined) // a genuine second edge, 8000ms offset

    // Not closed yet — only 6s since the last edge (needs 15s).
    await vi.advanceTimersByTimeAsync(6_000)
    expect(closeRow).not.toHaveBeenCalled()

    // Now 15s since the last edge (9_000 + 15_000 = 24_000; we're at 15_000
    // wall-time from t=9_000 tick, i.e. advance the remaining 9s).
    await vi.advanceTimersByTimeAsync(9_000)

    expect(closeRow).toHaveBeenCalledTimes(1)
    expect(closeRow).toHaveBeenCalledWith({
      deviceId: 102,
      source: 'onboard',
      eventId: 101,
      durationMs: 8_000, // lastOnAt(9000) - startedAt(1000), NOT closedAt - startedAt
      edges: [0, 8_000],
    })
  })

  it('an instantaneous single edge reports ~0 duration, not the 15s quiet window', async () => {
    const insertRow = vi.fn().mockResolvedValue(101)
    const closeRow = vi.fn().mockResolvedValue(true)
    const tracker = new MotionEpisodeTracker({
      closeAfterMs: 15_000,
      logger: fakeLogger() as never,
      insertRow,
      closeRow,
    })

    await tracker.observe(102, 'onboard', true, 1_000, undefined)
    await vi.advanceTimersByTimeAsync(15_000)

    expect(closeRow).toHaveBeenCalledWith(expect.objectContaining({ durationMs: 0, edges: [0] }))
  })

  it('a further edge re-arms the close timer — it does not fire at the ORIGINAL 15s mark', async () => {
    const insertRow = vi.fn().mockResolvedValue(101)
    const closeRow = vi.fn().mockResolvedValue(true)
    const tracker = new MotionEpisodeTracker({
      closeAfterMs: 15_000,
      logger: fakeLogger() as never,
      insertRow,
      closeRow,
    })

    await tracker.observe(102, 'onboard', true, 0, undefined)
    await vi.advanceTimersByTimeAsync(10_000)
    await tracker.observe(102, 'onboard', true, 10_000, undefined) // continuation tick, re-arms
    await vi.advanceTimersByTimeAsync(10_000) // 20s total — past the original 15s mark
    expect(closeRow).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(5_000) // 15s since the 10_000 tick
    expect(closeRow).toHaveBeenCalledTimes(1)
  })

  it('two episode keys (onboard vs analyzer) on the SAME device never share state', async () => {
    const insertRow = vi
      .fn()
      .mockResolvedValue(1)
      .mockResolvedValueOnce(101)
      .mockResolvedValueOnce(202)
    const closeRow = vi.fn().mockResolvedValue(true)
    const tracker = new MotionEpisodeTracker({
      closeAfterMs: 15_000,
      logger: fakeLogger() as never,
      insertRow,
      closeRow,
    })

    await tracker.observe(102, 'onboard', true, 1_000, undefined)
    await tracker.observe(102, 'analyzer', true, 1_000, undefined)

    expect(insertRow).toHaveBeenCalledTimes(2)
    expect(insertRow).toHaveBeenNthCalledWith(1, {
      deviceId: 102,
      source: 'onboard',
      timestamp: 1_000,
      regionData: undefined,
    })
    expect(insertRow).toHaveBeenNthCalledWith(2, {
      deviceId: 102,
      source: 'analyzer',
      timestamp: 1_000,
      regionData: undefined,
    })

    // Closing one must not touch the other's open episode.
    await vi.advanceTimersByTimeAsync(15_000)
    expect(closeRow).toHaveBeenCalledTimes(2)
    expect(closeRow).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'onboard', eventId: 101 }),
    )
    expect(closeRow).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'analyzer', eventId: 202 }),
    )
  })

  it('closeAll force-closes every open episode and logs the reason', async () => {
    const insertRow = vi.fn().mockResolvedValueOnce(101).mockResolvedValueOnce(202)
    const closeRow = vi.fn().mockResolvedValue(true)
    const logger = fakeLogger()
    const tracker = new MotionEpisodeTracker({
      closeAfterMs: 15_000,
      logger: logger as never,
      insertRow,
      closeRow,
    })

    await tracker.observe(102, 'onboard', true, 1_000, undefined)
    await tracker.observe(108, 'analyzer', true, 1_000, undefined)

    await tracker.closeAll('addon-shutdown')

    expect(closeRow).toHaveBeenCalledTimes(2)
    expect(closeRow).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 102, eventId: 101, durationMs: 0 }),
    )
    expect(closeRow).toHaveBeenCalledWith(
      expect.objectContaining({ deviceId: 108, eventId: 202, durationMs: 0 }),
    )

    // The timers are cleared — advancing time must not double-close.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(closeRow).toHaveBeenCalledTimes(2)
  })

  it('closeAll is a no-op when nothing is open', async () => {
    const insertRow = vi.fn()
    const closeRow = vi.fn()
    const tracker = new MotionEpisodeTracker({
      closeAfterMs: 15_000,
      logger: fakeLogger() as never,
      insertRow,
      closeRow,
    })
    await tracker.closeAll('addon-shutdown')
    expect(closeRow).not.toHaveBeenCalled()
  })

  it('calls onNewEdge only on genuine transitions, and onTick on every observation', async () => {
    const insertRow = vi.fn().mockResolvedValue(101)
    const closeRow = vi.fn().mockResolvedValue(true)
    const onNewEdge = vi.fn()
    const onTick = vi.fn()
    const tracker = new MotionEpisodeTracker({
      closeAfterMs: 15_000,
      logger: fakeLogger() as never,
      insertRow,
      closeRow,
      onNewEdge,
      onTick,
    })

    await tracker.observe(102, 'onboard', true, 1_000, undefined)
    await tracker.observe(102, 'onboard', true, 2_000, undefined) // continuation, no edge
    await tracker.observe(102, 'onboard', false, 3_000, undefined) // off, no episode change
    await tracker.observe(102, 'onboard', true, 4_000, undefined) // genuine second edge

    expect(onNewEdge).toHaveBeenCalledTimes(2)
    expect(onNewEdge).toHaveBeenNthCalledWith(1, {
      deviceId: 102,
      source: 'onboard',
      timestamp: 1_000,
      eventId: 101,
      isFirst: true,
    })
    expect(onNewEdge).toHaveBeenNthCalledWith(2, {
      deviceId: 102,
      source: 'onboard',
      timestamp: 4_000,
      eventId: 101,
      isFirst: false,
    })
    // onTick fires for every detected:true observation (2 continuations +
    // the 2 edges), never for the observed-off.
    expect(onTick).toHaveBeenCalledTimes(3)
  })
})
