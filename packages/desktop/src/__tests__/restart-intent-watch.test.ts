import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RESTART_INTENT_POLL_MS, startRestartIntentWatch } from '../restart-intent-watch'

describe('restart-intent watch', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('the poll alone reports the marker appearing, once per appearance', () => {
    let present = false
    const onAppear = vi.fn()
    const w = startRestartIntentWatch({
      markerExists: () => present,
      watchDir: () => null,
      onAppear,
    })
    vi.advanceTimersByTime(RESTART_INTENT_POLL_MS * 3)
    expect(onAppear).not.toHaveBeenCalled()
    present = true
    vi.advanceTimersByTime(RESTART_INTENT_POLL_MS * 3)
    expect(onAppear).toHaveBeenCalledTimes(1)
    present = false
    vi.advanceTimersByTime(RESTART_INTENT_POLL_MS)
    present = true
    vi.advanceTimersByTime(RESTART_INTENT_POLL_MS)
    expect(onAppear).toHaveBeenCalledTimes(2)
    w.stop()
  })

  it('a directory change reports at once, without waiting for the poll', () => {
    let present = false
    let fire: () => void = () => undefined
    const onAppear = vi.fn()
    const close = vi.fn()
    const w = startRestartIntentWatch({
      markerExists: () => present,
      watchDir: (cb) => {
        fire = cb
        return close
      },
      onAppear,
    })
    present = true
    fire()
    expect(onAppear).toHaveBeenCalledTimes(1)
    w.stop()
    expect(close).toHaveBeenCalled()
  })
})
