/**
 * D1062 — `online` follows a reachability read the HUB schedules; the camera
 * owns no timer and probes once on activation.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const probe = vi.hoisted(() => vi.fn<(url: string, timeoutMs: number) => Promise<boolean>>())
vi.mock('../rtsp-reachability.js', () => ({ probeRtspReachable: probe }))

import { RtspCamera } from '../rtsp-camera.js'

function makeSubject() {
  const registered: { name: string; provider: unknown; options: unknown }[] = []
  const markOnline = vi.fn()
  const subject = {
    reachabilityPoll: null,
    disabled: false,
    markOnline,
    config: { get: () => [{ id: 'main', url: 'rtsp://192.168.1.50:554/live' }] },
    ctx: {
      stableId: 'rtsp:front',
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
    return call({ deviceId: 3, deviceIds: [3], reason: 'interval' })
  }
  return { subject, registered, markOnline, refresh }
}

describe('RTSP reachability through device-state-refresh (D1062)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    probe.mockReset()
    probe.mockResolvedValue(true)
  })
  afterEach(() => vi.useRealTimers())

  it('declares a polled 30 s read and probes once on activation', async () => {
    const h = makeSubject()
    RtspCamera.prototype['startReachabilityPolling'].call(h.subject)
    expect(h.registered.find((r) => r.name === 'device-state-refresh')?.options).toMatchObject({
      stateRefresh: { minIntervalMs: 30_000, push: 'none', batch: false },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(probe).toHaveBeenCalledWith('rtsp://192.168.1.50:554/live', 5_000)
    expect(h.markOnline).toHaveBeenCalledWith(true)
  })

  it('owns no timer: nothing is probed while time passes', async () => {
    const h = makeSubject()
    RtspCamera.prototype['startReachabilityPolling'].call(h.subject)
    await vi.advanceTimersByTimeAsync(0)
    probe.mockClear()
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(probe).not.toHaveBeenCalled()
  })

  it('a refresh that keeps missing takes the camera offline after three misses', async () => {
    const h = makeSubject()
    RtspCamera.prototype['startReachabilityPolling'].call(h.subject)
    await vi.advanceTimersByTimeAsync(0)
    probe.mockResolvedValue(false)
    await h.refresh()
    await h.refresh()
    expect(h.markOnline).not.toHaveBeenCalledWith(false)
    await h.refresh()
    expect(h.markOnline).toHaveBeenLastCalledWith(false)
  })
})
