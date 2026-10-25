/**
 * EventLoopStallMonitor — the stream-broker process shows multi-second
 * event-loop stalls in production: every camera's source-RTP watchdog fires
 * in the SAME second (a whole-process silence, not N camera outages), and a
 * measured 6.8 s offer→answer block sat between two log lines with no await
 * between them, releasing in one burst. Nothing names these stalls today —
 * they surface only as their downstream symptoms (slow connects, watchdog
 * storms). The monitor samples timer drift and reports any tick that arrives
 * later than `thresholdMs` past its schedule, so a stall becomes one WARN
 * with its duration instead of a fleet-wide mystery.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventLoopStallMonitor } from '../event-loop-stall-monitor'

describe('EventLoopStallMonitor', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function advanceTick(
    _monitor: EventLoopStallMonitor,
    wallMs: number,
    clock: { now: number },
  ): void {
    // Simulate one interval tick that ARRIVES after `wallMs` of wall time:
    // the fake timer fires on schedule, but the injected clock says more
    // time passed — exactly what a blocked loop looks like from inside.
    clock.now += wallMs
    vi.advanceTimersByTime(100)
  }

  it('reports nothing while ticks arrive on schedule', () => {
    const clock = { now: 0 }
    const onStall = vi.fn()
    const monitor = new EventLoopStallMonitor({
      intervalMs: 100,
      thresholdMs: 250,
      now: () => clock.now,
      onStall,
    })
    monitor.start()
    for (let i = 0; i < 10; i++) advanceTick(monitor, 100, clock)
    expect(onStall).not.toHaveBeenCalled()
    monitor.stop()
  })

  it('reports a stall with its measured duration when a tick arrives late', () => {
    const clock = { now: 0 }
    const onStall = vi.fn()
    const monitor = new EventLoopStallMonitor({
      intervalMs: 100,
      thresholdMs: 250,
      now: () => clock.now,
      onStall,
    })
    monitor.start()
    advanceTick(monitor, 100, clock)
    // A 7-second freeze: the next tick arrives 6900 ms late.
    advanceTick(monitor, 7000, clock)
    expect(onStall).toHaveBeenCalledTimes(1)
    expect(onStall).toHaveBeenCalledWith(6900)
    monitor.stop()
  })

  it('tolerates jitter below the threshold', () => {
    const clock = { now: 0 }
    const onStall = vi.fn()
    const monitor = new EventLoopStallMonitor({
      intervalMs: 100,
      thresholdMs: 250,
      now: () => clock.now,
      onStall,
    })
    monitor.start()
    advanceTick(monitor, 340, clock) // 240 ms late — under threshold
    expect(onStall).not.toHaveBeenCalled()
    advanceTick(monitor, 351, clock) // 251 ms late — over
    expect(onStall).toHaveBeenCalledWith(251)
    monitor.stop()
  })

  it('stop() silences it — no report after stop', () => {
    const clock = { now: 0 }
    const onStall = vi.fn()
    const monitor = new EventLoopStallMonitor({
      intervalMs: 100,
      thresholdMs: 250,
      now: () => clock.now,
      onStall,
    })
    monitor.start()
    monitor.stop()
    clock.now += 10_000
    vi.advanceTimersByTime(1_000)
    expect(onStall).not.toHaveBeenCalled()
  })

  it('a throwing onStall does not break subsequent sampling', () => {
    const clock = { now: 0 }
    const onStall = vi.fn(() => {
      throw new Error('logger down')
    })
    const monitor = new EventLoopStallMonitor({
      intervalMs: 100,
      thresholdMs: 250,
      now: () => clock.now,
      onStall,
    })
    monitor.start()
    advanceTick(monitor, 5000, clock)
    advanceTick(monitor, 5000, clock)
    expect(onStall).toHaveBeenCalledTimes(2)
    monitor.stop()
  })

  it('start() is idempotent — one sampler, not two', () => {
    const clock = { now: 0 }
    const onStall = vi.fn()
    const monitor = new EventLoopStallMonitor({
      intervalMs: 100,
      thresholdMs: 250,
      now: () => clock.now,
      onStall,
    })
    monitor.start()
    monitor.start()
    advanceTick(monitor, 5000, clock)
    expect(onStall).toHaveBeenCalledTimes(1)
    monitor.stop()
  })
})
