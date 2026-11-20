/**
 * D1062 — `device.online` follows a control-plane reachability read the HUB
 * schedules: the camera registers `device-state-refresh` and owns no timer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AmcrestCamera } from '../amcrest-camera.js'

function makeSubject(getDeviceInfo: () => Promise<{ serialNumber: string | null }>) {
  const registered: { name: string; provider: unknown; options: unknown }[] = []
  const onReachabilityChange = vi.fn()
  const subject = {
    id: 618,
    reachabilityPoll: null,
    identityDeclared: true,
    disabled: false,
    onReachabilityChange,
    ensureClient: () => ({ getDeviceInfo: vi.fn(getDeviceInfo) }),
    ctx: {
      stableId: 'amcrest:front',
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
      registerNativeCap: (cap: { name: string }, provider: unknown, options?: unknown) => {
        registered.push({ name: cap.name, provider, options })
      },
    },
  }
  const refresh = async (): Promise<unknown> => {
    const found = registered.find((r) => r.name === 'device-state-refresh')?.provider
    if (typeof found !== 'object' || found === null || !('refresh' in found)) {
      throw new Error('no refresh provider registered')
    }
    const call: unknown = found.refresh
    if (typeof call !== 'function') throw new Error('refresh is not a function')
    return call({ deviceId: 618, deviceIds: [618], reason: 'interval' })
  }
  return { subject, registered, onReachabilityChange, refresh }
}

describe('Amcrest reachability through device-state-refresh (D1062)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('declares a polled 30 s read and probes once on activation', async () => {
    const h = makeSubject(async () => ({ serialNumber: null }))
    AmcrestCamera.prototype['startReachabilityPolling'].call(h.subject)
    expect(h.registered.find((r) => r.name === 'device-state-refresh')?.options).toMatchObject({
      stateRefresh: { minIntervalMs: 30_000, push: 'none', batch: false },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.onReachabilityChange).toHaveBeenCalledWith(true)
  })

  it('owns no timer: no probe runs while time passes', async () => {
    const getDeviceInfo = vi.fn(async () => ({ serialNumber: null }))
    const h = makeSubject(getDeviceInfo)
    AmcrestCamera.prototype['startReachabilityPolling'].call(h.subject)
    await vi.advanceTimersByTimeAsync(0)
    h.onReachabilityChange.mockClear()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.onReachabilityChange).not.toHaveBeenCalled()
  })

  it('a refresh that keeps missing takes the camera offline after three misses', async () => {
    let up = true
    const h = makeSubject(async () => {
      if (!up) throw new Error('ECONNREFUSED')
      return { serialNumber: null }
    })
    AmcrestCamera.prototype['startReachabilityPolling'].call(h.subject)
    await vi.advanceTimersByTimeAsync(0)
    up = false
    await h.refresh()
    await h.refresh()
    expect(h.onReachabilityChange).not.toHaveBeenCalledWith(false)
    await h.refresh()
    expect(h.onReachabilityChange).toHaveBeenLastCalledWith(false)
  })
})
