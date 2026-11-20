/**
 * D1062 — `device.online` follows a control-plane read the HUB schedules; the
 * camera owns no timer, and the OSD snapshot rides the same read once it is old.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HikvisionCamera } from '../hikvision-camera.js'

function makeSubject(osdFetchedAt: number) {
  const registered: { name: string; provider: unknown; options: unknown }[] = []
  const markOnline = vi.fn()
  const getDeviceInfo = vi.fn(async () => ({}))
  const refreshOsdSnapshot = vi.fn(async () => {})
  const subject = {
    reachabilityPoll: null,
    disabled: false,
    osdFetchedAt,
    markOnline,
    refreshOsdSnapshot,
    ensureClient: () => ({ getDeviceInfo }),
    ctx: {
      stableId: 'hik:front',
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
    return call({ deviceId: 101, deviceIds: [101], reason: 'interval' })
  }
  return { subject, registered, markOnline, getDeviceInfo, refreshOsdSnapshot, refresh }
}

describe('Hikvision reachability through device-state-refresh (D1062)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('declares a polled 30 s read and probes once on activation', async () => {
    const h = makeSubject(Date.now())
    HikvisionCamera.prototype['startReachabilityPolling'].call(h.subject)
    expect(h.registered.find((r) => r.name === 'device-state-refresh')?.options).toMatchObject({
      stateRefresh: { minIntervalMs: 30_000, push: 'none', batch: false },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(h.markOnline).toHaveBeenCalledWith(true)
  })

  it('owns no timer: nothing is probed and the OSD is not re-read while time passes', async () => {
    const h = makeSubject(Date.now())
    HikvisionCamera.prototype['startReachabilityPolling'].call(h.subject)
    await vi.advanceTimersByTimeAsync(0)
    h.getDeviceInfo.mockClear()
    await vi.advanceTimersByTimeAsync(20 * 60_000)
    expect(h.getDeviceInfo).not.toHaveBeenCalled()
    expect(h.refreshOsdSnapshot).not.toHaveBeenCalled()
  })

  it('a read refreshes the OSD snapshot only once it is older than five minutes', async () => {
    const h = makeSubject(Date.now())
    HikvisionCamera.prototype['startReachabilityPolling'].call(h.subject)
    await vi.advanceTimersByTimeAsync(0)
    await h.refresh()
    expect(h.refreshOsdSnapshot).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(301_000)
    await h.refresh()
    expect(h.refreshOsdSnapshot).toHaveBeenCalledOnce()
  })
})
