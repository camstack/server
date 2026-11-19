import { deviceStateRefreshCapability } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import {
  type DreameRefreshContext,
  dreameRefreshPolicy,
  registerDreameStateRefresh,
} from '../devices/dreame-state-refresh.js'
import { DreameFacadeResolver } from '../dreame-gateway.js'

function refreshContext(): {
  readonly ctx: DreameRefreshContext
  readonly registerNativeCap: ReturnType<typeof vi.fn>
  readonly unregisterNativeCap: ReturnType<typeof vi.fn>
} {
  const registerNativeCap = vi.fn()
  const unregisterNativeCap = vi.fn()
  return { ctx: { registerNativeCap, unregisterNativeCap }, registerNativeCap, unregisterNativeCap }
}

describe('dreame state refresh (D1062)', () => {
  it('registers device-state-refresh with a partial-push policy and reads through it', async () => {
    const read = vi.fn(async () => {})
    const { ctx, registerNativeCap } = refreshContext()
    registerDreameStateRefresh({
      ctx,
      brokerId: 'acct-1',
      minIntervalMs: 180_000,
      intervals: new DreameFacadeResolver(),
      read,
    })
    const [cap, provider, options] = registerNativeCap.mock.calls[0] ?? []
    expect(cap).toBe(deviceStateRefreshCapability)
    expect(options).toEqual({ stateRefresh: dreameRefreshPolicy('acct-1', 180_000) })
    expect(options.stateRefresh.push).toBe('partial')
    await provider.refresh({ reason: 'schedule' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it("the operator's pollIntervalMs drives the policy and re-registers it when it changes", () => {
    const intervals = new DreameFacadeResolver()
    intervals.setPollInterval('acct-1', 600_000)
    const { ctx, registerNativeCap, unregisterNativeCap } = refreshContext()
    const stop = registerDreameStateRefresh({
      ctx,
      brokerId: 'acct-1',
      minIntervalMs: 180_000,
      intervals,
      read: async () => {},
    })
    expect(registerNativeCap.mock.calls[0]?.[2]).toEqual({
      stateRefresh: dreameRefreshPolicy('acct-1', 180_000, 600_000),
    })

    intervals.setPollInterval('acct-1', 900_000)
    expect(unregisterNativeCap).toHaveBeenCalledWith(deviceStateRefreshCapability.name)
    expect(registerNativeCap.mock.calls[1]?.[2]).toEqual({
      stateRefresh: dreameRefreshPolicy('acct-1', 180_000, 900_000),
    })

    intervals.setPollInterval('acct-1', 900_000)
    expect(registerNativeCap).toHaveBeenCalledTimes(2)

    stop()
    intervals.setPollInterval('acct-1', 0)
    expect(registerNativeCap).toHaveBeenCalledTimes(2)
  })
})
