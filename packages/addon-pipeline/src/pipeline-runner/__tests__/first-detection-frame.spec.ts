import { beforeEach, describe, expect, it } from 'vitest'
import { FirstDetectionFrameTimer } from '../first-detection-frame.js'

describe('FirstDetectionFrameTimer', () => {
  let timer: FirstDetectionFrameTimer
  beforeEach(() => {
    timer = new FirstDetectionFrameTimer()
  })

  it('measures the first frame after an attach', () => {
    timer.markAttached(101, 1_000)
    expect(timer.takeLatency(101, 1_850)).toBe(850)
  })

  it('reports ONCE per attach, not once per frame', () => {
    timer.markAttached(101, 1_000)
    expect(timer.takeLatency(101, 1_100)).toBe(100)
    expect(timer.takeLatency(101, 1_200)).toBeNull()
    expect(timer.takeLatency(101, 1_300)).toBeNull()
  })

  it('measures from the NEWEST attach', () => {
    // The session churns — three attaches in one minute were observed. Each
    // frame belongs to the attach that preceded it.
    timer.markAttached(101, 1_000)
    timer.markAttached(101, 5_000)
    expect(timer.takeLatency(101, 5_400)).toBe(400)
  })

  it('keeps cameras apart', () => {
    timer.markAttached(101, 1_000)
    timer.markAttached(102, 2_000)
    expect(timer.takeLatency(102, 2_500)).toBe(500)
    expect(timer.takeLatency(101, 2_500)).toBe(1_500)
  })

  it('answers null for a device that never attached', () => {
    expect(timer.takeLatency(999, 1_000)).toBeNull()
  })

  it('reports a session that fed the detector NOTHING', () => {
    // The interesting case: a session opened, ran, and detached without one
    // frame reaching the detector.
    timer.markAttached(101, 1_000)
    expect(timer.forget(101)).toBe(true)
    expect(timer.forget(101)).toBe(false)
  })

  it('does not carry a stale attach into the next session', () => {
    timer.markAttached(101, 1_000)
    timer.forget(101)
    expect(timer.takeLatency(101, 9_000)).toBeNull()
  })

  it('never reports a negative latency', () => {
    timer.markAttached(101, 5_000)
    expect(timer.takeLatency(101, 4_000)).toBe(0)
  })
})
