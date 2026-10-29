import { describe, expect, it } from 'vitest'
import {
  ACTIVITY_WINDOW_MS,
  BOWL_CHANGE_WINDOW_MS,
  FAST_POLL_MS,
  MAX_BACKOFF_MS,
  PollCadence,
  READ_WINDOW_MS,
  SLOW_POLL_MS,
} from '../petkit-poll-cadence.js'

describe('PollCadence', () => {
  it('is slow when idle', () => {
    expect(new PollCadence().nextDelay(1_000)).toBe(SLOW_POLL_MS)
  })

  it('is fast after activity, then slow once the window passes', () => {
    const c = new PollCadence()
    c.noteActivity(0)
    expect(c.nextDelay(ACTIVITY_WINDOW_MS - 1)).toBe(FAST_POLL_MS)
    expect(c.nextDelay(ACTIVITY_WINDOW_MS)).toBe(SLOW_POLL_MS)
  })

  it('is fast after a consumer read', () => {
    const c = new PollCadence()
    c.noteRead(0)
    expect(c.fastReason(READ_WINDOW_MS - 1)).toBe('consumer-read')
    expect(c.nextDelay(READ_WINDOW_MS)).toBe(SLOW_POLL_MS)
  })

  it('reports a bowl change once and stays fast for the bowl window', () => {
    const c = new PollCadence()
    expect(c.noteBowl(0, 20)).toEqual({ from: null })
    expect(c.noteBowl(10, 20)).toBeUndefined()
    expect(c.noteBowl(20, 0)).toEqual({ from: 20 })
    expect(c.nextDelay(BOWL_CHANGE_WINDOW_MS)).toBe(FAST_POLL_MS)
    expect(c.nextDelay(BOWL_CHANGE_WINDOW_MS + 20)).toBe(SLOW_POLL_MS)
  })

  it('backs off exponentially on failures, bounded, and resets on success', () => {
    const c = new PollCadence()
    c.noteActivity(0)
    c.noteFailure()
    expect(c.nextDelay(0)).toBe(SLOW_POLL_MS)
    c.noteFailure()
    expect(c.nextDelay(0)).toBe(SLOW_POLL_MS * 2)
    for (let i = 0; i < 10; i += 1) c.noteFailure()
    expect(c.nextDelay(0)).toBe(MAX_BACKOFF_MS)
    c.noteSuccess()
    expect(c.nextDelay(0)).toBe(FAST_POLL_MS)
  })
})
