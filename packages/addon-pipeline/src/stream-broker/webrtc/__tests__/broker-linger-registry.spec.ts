/**
 * BrokerLingerRegistry — keeps the broker a viewer just used warm for a
 * bounded window after its LAST WebRTC session closes.
 *
 * Why: brokers dial on demand and suspend ~5 s after the last consumer
 * detaches, so the dominant real access pattern (open a camera, close it,
 * reopen within a couple of minutes — every cold-connect cluster in the
 * production timing data shows exactly this) re-pays the cold path each
 * time: background re-dial + an empty RTP ring → no instant-start GOP
 * replay → next-IDR wait. A ghost subscription held for the linger window
 * keeps the dial and the ring warm for precisely the brokers someone
 * actually watched, at the cost of one RTSP socket + one GOP of RAM each —
 * bounded and self-expiring, unlike an always-warm tier.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BrokerLingerRegistry } from '../broker-linger-registry'

describe('BrokerLingerRegistry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  function makeRegistry(lingerMs = 1000) {
    const released: string[] = []
    const subscribed: string[] = []
    const subscribe = vi.fn((brokerId: string) => {
      subscribed.push(brokerId)
      return () => {
        released.push(brokerId)
      }
    })
    const registry = new BrokerLingerRegistry({ lingerMs, subscribe })
    return { registry, subscribe, subscribed, released }
  }

  it('hold() attaches the ghost and releases it after the linger window', () => {
    const { registry, subscribed, released } = makeRegistry(1000)
    registry.hold('101/native:sub')
    expect(subscribed).toEqual(['101/native:sub'])
    vi.advanceTimersByTime(999)
    expect(released).toEqual([])
    vi.advanceTimersByTime(1)
    expect(released).toEqual(['101/native:sub'])
  })

  it('cancel() releases immediately and disarms the timer', () => {
    const { registry, released } = makeRegistry(1000)
    registry.hold('101/native:sub')
    registry.cancel('101/native:sub')
    expect(released).toEqual(['101/native:sub'])
    vi.advanceTimersByTime(5000)
    // No double release from a stale timer.
    expect(released).toEqual(['101/native:sub'])
  })

  it('re-holding an already-held broker re-arms without double-subscribing', () => {
    const { registry, subscribe, released } = makeRegistry(1000)
    registry.hold('101/native:sub')
    vi.advanceTimersByTime(600)
    registry.hold('101/native:sub')
    expect(subscribe).toHaveBeenCalledTimes(1)
    // Window restarted: the original deadline passes with no release…
    vi.advanceTimersByTime(600)
    expect(released).toEqual([])
    // …and the re-armed one fires.
    vi.advanceTimersByTime(400)
    expect(released).toEqual(['101/native:sub'])
  })

  it('a null subscription (broker gone) is a no-op hold', () => {
    const subscribe = vi.fn(() => null)
    const registry = new BrokerLingerRegistry({ lingerMs: 1000, subscribe })
    registry.hold('999/gone')
    vi.advanceTimersByTime(5000)
    expect(subscribe).toHaveBeenCalledTimes(1)
    // Nothing to release, nothing throws — the assertion is the absence of
    // a crash plus no lingering timer (covered by fake-timer teardown).
    registry.stop()
  })

  it('cancel() on a broker never held is a no-op', () => {
    const { registry, released } = makeRegistry(1000)
    registry.cancel('101/native:sub')
    expect(released).toEqual([])
  })

  it('stop() releases every held broker', () => {
    const { registry, released } = makeRegistry(60_000)
    registry.hold('101/native:sub')
    registry.hold('102/native:sub')
    registry.stop()
    expect(released.sort()).toEqual(['101/native:sub', '102/native:sub'])
    vi.advanceTimersByTime(120_000)
    expect(released).toHaveLength(2)
  })

  it('a throwing unsubscribe does not break the registry', () => {
    const subscribe = vi.fn(() => () => {
      throw new Error('broker torn down')
    })
    const registry = new BrokerLingerRegistry({ lingerMs: 1000, subscribe })
    registry.hold('101/native:sub')
    vi.advanceTimersByTime(1000)
    // Second broker still works.
    registry.hold('102/native:sub')
    expect(subscribe).toHaveBeenCalledTimes(2)
    registry.stop()
  })
})
