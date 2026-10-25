import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DEFAULT_MOTION_CLEAR_HOLD_MS, MotionClearHold } from '../motion-clear-hold.js'

describe('MotionClearHold', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  // The quiet-hold logic in isolation; Amazon's 30 s DETECTED minimum has its
  // own spec (motion-min-detected.spec.ts).
  const make = (holdMs = 5_000): MotionClearHold =>
    new MotionClearHold({ holdMs, minDetectedMs: 0 })

  it('posts the rising edge immediately', () => {
    const hold = make()
    expect(hold.onDetected('u|104')).toBe(true)
  })

  it('drops a repeated DETECTED — the old transition dedupe, preserved', () => {
    const hold = make()
    expect(hold.onDetected('u|104')).toBe(true)
    expect(hold.onDetected('u|104')).toBe(false)
    expect(hold.onDetected('u|104')).toBe(false)
  })

  it('releases NOT_DETECTED only after the source stays quiet for the hold', () => {
    const hold = make(5_000)
    const release = vi.fn()
    hold.onDetected('u|104')
    hold.onCleared('u|104', release)

    vi.advanceTimersByTime(4_999)
    expect(release).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(release).toHaveBeenCalledTimes(1)
    expect(hold.believedDetected('u|104')).toBe(false)
  })

  it('absorbs the live 104 flap: 1.76s alternation collapses to ONE DETECTED', () => {
    // Replays the measured shape — 104 alternated DETECTED/NOT_DETECTED with a
    // median 1.76 s gap, 218 posts in 692 s. With the hold it must be 1 post.
    const hold = make(5_000)
    const release = vi.fn()
    let detectedPosts = 0

    for (let i = 0; i < 20; i += 1) {
      if (hold.onDetected('u|104')) detectedPosts += 1
      vi.advanceTimersByTime(900)
      hold.onCleared('u|104', release)
      vi.advanceTimersByTime(880) // 1.78 s cycle — inside the 5 s hold
    }

    expect(detectedPosts).toBe(1)
    expect(release).not.toHaveBeenCalled()
    expect(hold.believedDetected('u|104')).toBe(true)

    // …and the clear still lands once the flapping genuinely stops.
    vi.advanceTimersByTime(5_000)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('a DETECTED inside the hold window does NOT re-post — Alexa already believes DETECTED', () => {
    const hold = make(5_000)
    const release = vi.fn()
    hold.onDetected('u|104')
    hold.onCleared('u|104', release)
    vi.advanceTimersByTime(2_000)

    expect(hold.onDetected('u|104')).toBe(false)
    vi.advanceTimersByTime(10_000)
    expect(release).not.toHaveBeenCalled()
  })

  it('an UNKNOWN key still releases — a restart mid-motion must not strand Alexa at DETECTED', () => {
    // The map is in-memory. If the addon respawned while motion was active,
    // Alexa still believes DETECTED and nothing here knows it. Arming on an
    // unknown key costs at most one redundant NOT_DETECTED per restart;
    // returning early costs a stuck motion badge until the camera triggers
    // again.
    const hold = make(5_000)
    const release = vi.fn()
    hold.onCleared('u|104', release)
    vi.advanceTimersByTime(5_000)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('a clear AFTER a released clear is a no-op — the known-idle state is trusted', () => {
    const hold = make(5_000)
    const release = vi.fn()
    hold.onDetected('u|104')
    hold.onCleared('u|104', release)
    vi.advanceTimersByTime(5_000)
    expect(release).toHaveBeenCalledTimes(1)

    hold.onCleared('u|104', release)
    vi.advanceTimersByTime(60_000)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('a second clear while one is pending does not extend or duplicate the hold', () => {
    const hold = make(5_000)
    const release = vi.fn()
    hold.onDetected('u|104')
    hold.onCleared('u|104', release)
    vi.advanceTimersByTime(3_000)
    hold.onCleared('u|104', release)
    vi.advanceTimersByTime(2_000)
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('keys are independent — one camera flapping never suppresses another', () => {
    const hold = make(5_000)
    expect(hold.onDetected('u|104')).toBe(true)
    expect(hold.onDetected('u|101')).toBe(true)
    const release590 = vi.fn()
    hold.onCleared('u|104', release590)
    vi.advanceTimersByTime(5_000)
    expect(release590).toHaveBeenCalledTimes(1)
    expect(hold.believedDetected('u|101')).toBe(true)
  })

  it('clear() cancels pending releases so a stopped addon emits nothing', () => {
    const hold = make(5_000)
    const release = vi.fn()
    hold.onDetected('u|104')
    hold.onCleared('u|104', release)
    hold.clear()
    vi.advanceTimersByTime(60_000)
    expect(release).not.toHaveBeenCalled()
    // …and the next DETECTED is a fresh rising edge.
    expect(hold.onDetected('u|104')).toBe(true)
  })

  it('the default hold matches the HAP builder it is modelled on', () => {
    expect(DEFAULT_MOTION_CLEAR_HOLD_MS).toBe(5_000)
  })
})
