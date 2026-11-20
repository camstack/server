/**
 * D1062 — `online` follows a control-plane read the HUB schedules; the camera
 * owns no timer, registers once, and probes at once on every (re)attach.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OnvifCamera } from '../onvif-camera.js'

function makeSubject(getDeviceInfo: () => Promise<unknown>) {
  const registered: { name: string; provider: unknown; options: unknown }[] = []
  const markOnline = vi.fn()
  const subject = {
    reachabilityPoll: null,
    disabled: false,
    client: { getDeviceInfo: vi.fn(getDeviceInfo) },
    markOnline,
    ctx: {
      stableId: 'onvif:front',
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
    return call({ deviceId: 9, deviceIds: [9], reason: 'interval' })
  }
  return { subject, registered, markOnline, refresh }
}

describe('ONVIF reachability through device-state-refresh (D1062)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('declares a polled 30 s read and probes once on attach', async () => {
    const h = makeSubject(async () => ({}))
    OnvifCamera.prototype['startReachabilityPolling'].call(h.subject)
    expect(h.registered.find((r) => r.name === 'device-state-refresh')?.options).toMatchObject({
      stateRefresh: { minIntervalMs: 30_000, push: 'none', batch: false },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.markOnline).toHaveBeenCalledWith(true)
  })

  it('a reconnect registers nothing new and probes at once', async () => {
    const h = makeSubject(async () => ({}))
    OnvifCamera.prototype['startReachabilityPolling'].call(h.subject)
    await vi.advanceTimersByTimeAsync(0)
    OnvifCamera.prototype['startReachabilityPolling'].call(h.subject)
    await vi.advanceTimersByTimeAsync(0)
    expect(h.registered.filter((r) => r.name === 'device-state-refresh')).toHaveLength(1)
    expect(h.subject.client.getDeviceInfo).toHaveBeenCalledTimes(2)
  })

  it('owns no timer: nothing is probed while time passes', async () => {
    const h = makeSubject(async () => ({}))
    OnvifCamera.prototype['startReachabilityPolling'].call(h.subject)
    await vi.advanceTimersByTimeAsync(0)
    h.subject.client.getDeviceInfo.mockClear()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(h.subject.client.getDeviceInfo).not.toHaveBeenCalled()
  })

  it('a refresh that keeps missing takes the camera offline after three misses', async () => {
    let up = true
    const h = makeSubject(async () => {
      if (!up) throw new Error('ECONNREFUSED')
      return {}
    })
    OnvifCamera.prototype['startReachabilityPolling'].call(h.subject)
    await vi.advanceTimersByTimeAsync(0)
    up = false
    await h.refresh()
    await h.refresh()
    expect(h.markOnline).not.toHaveBeenCalledWith(false)
    await h.refresh()
    expect(h.markOnline).toHaveBeenLastCalledWith(false)
  })
})
