import { describe, expect, it, vi } from 'vitest'
import { createKeepAwakeLoop } from '../keep-awake-loop'

interface FakeTimer {
  readonly fn: () => void
  readonly ms: number
  cleared: boolean
}

function harness(opts: { battery?: boolean; wake?: () => Promise<void> } = {}) {
  const timers: FakeTimer[] = []
  const wake = vi.fn(opts.wake ?? (async () => {}))
  const onStart = vi.fn()
  const onStop = vi.fn()
  const onFailure = vi.fn()
  const loop = createKeepAwakeLoop({
    intervalMs: 20_000,
    isBattery: () => opts.battery ?? true,
    wake,
    setTimer: (fn, ms): FakeTimer => {
      const t: FakeTimer = { fn, ms, cleared: false }
      timers.push(t)
      return t
    },
    clearTimer: (h) => {
      h.cleared = true
    },
    onStart,
    onStop,
    onFailure,
  })
  const live = (): FakeTimer[] => timers.filter((t) => !t.cleared)
  return { loop, timers, live, wake, onStart, onStop, onFailure }
}

const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('keep-awake loop', () => {
  it('starts on the first consumer and wakes each interval', async () => {
    const h = harness()
    h.loop.sync(1)
    expect(h.onStart).toHaveBeenCalledWith(1)
    expect(h.live()).toHaveLength(1)
    expect(h.live()[0]?.ms).toBe(20_000)
    h.live()[0]?.fn()
    await flush()
    expect(h.wake).toHaveBeenCalledTimes(1)
  })

  it('never stacks timers on further consumers', () => {
    const h = harness()
    h.loop.sync(1)
    h.loop.sync(2)
    h.loop.sync(3)
    expect(h.timers).toHaveLength(1)
    expect(h.onStart).toHaveBeenCalledTimes(1)
  })

  it('stops when the last consumer leaves, and restarts after', () => {
    const h = harness()
    h.loop.sync(2)
    h.loop.sync(1)
    expect(h.loop.running()).toBe(true)
    h.loop.sync(0)
    expect(h.loop.running()).toBe(false)
    expect(h.live()).toHaveLength(0)
    expect(h.onStop).toHaveBeenCalledTimes(1)
    h.loop.sync(1)
    expect(h.live()).toHaveLength(1)
  })

  it('stop() on teardown clears the timer', () => {
    const h = harness()
    h.loop.sync(1)
    h.loop.stop()
    expect(h.live()).toHaveLength(0)
    h.loop.stop()
    expect(h.onStop).toHaveBeenCalledTimes(1)
  })

  it('is a no-op for a non-battery camera', () => {
    const h = harness({ battery: false })
    h.loop.sync(1)
    expect(h.timers).toHaveLength(0)
    expect(h.onStart).not.toHaveBeenCalled()
  })

  it('swallows wake errors and flags only the first failure of a stretch', async () => {
    let fail = true
    const h = harness({
      wake: async () => {
        if (fail) throw new Error('boom')
      },
    })
    h.loop.sync(1)
    const fire = async (): Promise<void> => {
      h.live().at(-1)?.fn()
      await flush()
    }
    await fire()
    await fire()
    expect(h.onFailure.mock.calls.map((c) => c[1])).toEqual([true, false])
    fail = false
    await fire()
    fail = true
    await fire()
    expect(h.onFailure.mock.calls.map((c) => c[1])).toEqual([true, false, true])
  })
})
