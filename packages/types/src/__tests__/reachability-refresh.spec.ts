import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REACHABILITY_FAILURES_TO_OFFLINE } from '../device/reachability-poll.js'
import {
  REACHABILITY_REFRESH_INTERVAL_MS,
  registerReachabilityRefresh,
  type ReachabilityRefreshContext,
} from '../device/reachability-refresh.js'

interface Rig {
  readonly ctx: ReachabilityRefreshContext
  readonly registrations: { readonly name: string; readonly options: unknown }[]
  readonly refresh: () => Promise<unknown>
}

function rig(): Rig {
  const registrations: { name: string; provider: unknown; options: unknown }[] = []
  const ctx: ReachabilityRefreshContext = {
    stableId: 'cam:front',
    id: 77,
    registerNativeCap: (cap, provider, options) => {
      registrations.push({ name: cap.name, provider, options })
    },
  }
  const refresh = async (): Promise<unknown> => {
    const found = registrations.find((r) => r.name === 'device-state-refresh')?.provider
    if (typeof found !== 'object' || found === null || !('refresh' in found)) {
      throw new Error('no refresh provider registered')
    }
    const call: unknown = found.refresh
    if (typeof call !== 'function') throw new Error('refresh is not a function')
    return call({ deviceId: 1, deviceIds: [1], reason: 'interval' })
  }
  return { ctx, registrations, refresh }
}

describe('registerReachabilityRefresh (D1062)', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('declares a polled read at 30 s, grouped by the device by default', () => {
    const r = rig()
    registerReachabilityRefresh({ ctx: r.ctx, probe: async () => true, setOnline: vi.fn() })
    expect(r.registrations[0]?.options).toMatchObject({
      stateRefresh: {
        integrationId: 'cam:front',
        minIntervalMs: REACHABILITY_REFRESH_INTERVAL_MS,
        push: 'none',
        batch: false,
      },
    })
  })

  it('probes once at registration (no blind window) and owns no timer after it', async () => {
    const r = rig()
    const probe = vi.fn(async () => true)
    const setOnline = vi.fn()
    registerReachabilityRefresh({ ctx: r.ctx, probe, setOnline })
    await vi.advanceTimersByTimeAsync(0)
    expect(probe).toHaveBeenCalledTimes(1)
    expect(setOnline).toHaveBeenCalledWith(true)
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('a miss is logged under the device id tag', async () => {
    const r = rig()
    const debug = vi.fn()
    registerReachabilityRefresh({
      ctx: r.ctx,
      probe: async () => false,
      setOnline: vi.fn(),
      logger: { debug },
    })
    await vi.advanceTimersByTimeAsync(0)
    expect(debug).toHaveBeenCalledWith(
      'reachability probe failed',
      expect.objectContaining({ tags: { deviceId: 77 } }),
    )
  })

  it('reattach forgets the misses so far and probes again', async () => {
    const r = rig()
    let reachable = false
    const setOnline = vi.fn()
    const handle = registerReachabilityRefresh({
      ctx: r.ctx,
      probe: async () => reachable,
      setOnline,
    })
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 2; i < REACHABILITY_FAILURES_TO_OFFLINE; i += 1) await r.refresh()
    await handle.reattach()
    expect(setOnline).not.toHaveBeenCalledWith(false)
    await r.refresh()
    expect(setOnline).not.toHaveBeenCalledWith(false)
    reachable = true
    await handle.reattach()
    expect(setOnline).toHaveBeenLastCalledWith(true)
  })

  it('a refresh marks ONLINE on the first success, OFFLINE only after N consecutive misses', async () => {
    const r = rig()
    let reachable = true
    const setOnline = vi.fn()
    registerReachabilityRefresh({ ctx: r.ctx, probe: async () => reachable, setOnline })
    await vi.advanceTimersByTimeAsync(0)
    expect(setOnline).toHaveBeenLastCalledWith(true)
    reachable = false
    for (let i = 1; i < REACHABILITY_FAILURES_TO_OFFLINE; i += 1) await r.refresh()
    expect(setOnline).toHaveBeenCalledTimes(1)
    await r.refresh()
    expect(setOnline).toHaveBeenLastCalledWith(false)
    reachable = true
    await r.refresh()
    expect(setOnline).toHaveBeenLastCalledWith(true)
  })

  it('an unreachable camera is a verdict, never a failed refresh; a throwing probe is a miss', async () => {
    const r = rig()
    const setOnline = vi.fn()
    registerReachabilityRefresh({
      ctx: r.ctx,
      probe: async () => {
        throw new Error('ECONNREFUSED')
      },
      setOnline,
      failuresToOffline: 1,
    })
    await expect(r.refresh()).resolves.toEqual({ ok: true })
    expect(setOnline).toHaveBeenCalledWith(false)
  })

  it('a hung probe is cut at the timeout and counts as a miss', async () => {
    const r = rig()
    const setOnline = vi.fn()
    registerReachabilityRefresh({
      ctx: r.ctx,
      probe: () => new Promise<boolean>(() => {}),
      setOnline,
      failuresToOffline: 1,
      probeTimeoutMs: 1_000,
    })
    const pending = r.refresh()
    await vi.advanceTimersByTimeAsync(1_000)
    await pending
    expect(setOnline).toHaveBeenCalledWith(false)
  })

  it('a disabled device is not probed and stays as it is', async () => {
    const r = rig()
    const probe = vi.fn(async () => false)
    const setOnline = vi.fn()
    registerReachabilityRefresh({
      ctx: r.ctx,
      probe,
      setOnline,
      isEnabled: () => false,
      failuresToOffline: 1,
    })
    await r.refresh()
    expect(probe).not.toHaveBeenCalled()
    expect(setOnline).not.toHaveBeenCalled()
  })

  it('a stopped handle ignores a verdict that lands after removal', async () => {
    const r = rig()
    const setOnline = vi.fn()
    const handle = registerReachabilityRefresh({ ctx: r.ctx, probe: async () => true, setOnline })
    await vi.advanceTimersByTimeAsync(0)
    expect(setOnline).toHaveBeenCalledTimes(1)
    handle.stop()
    await r.refresh()
    expect(setOnline).toHaveBeenCalledTimes(1)
  })
})
