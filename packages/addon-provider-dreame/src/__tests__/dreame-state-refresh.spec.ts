import { deviceStateRefreshCapability } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { toNodreameOptions } from '../config.js'
import {
  type DreameRefreshContext,
  dreameRefreshPolicy,
  registerDreameStateRefresh,
} from '../devices/dreame-state-refresh.js'

describe('dreame state refresh (D1062)', () => {
  it('registers device-state-refresh with a partial-push policy and reads through it', async () => {
    const read = vi.fn(async () => {})
    const registerNativeCap = vi.fn()
    registerDreameStateRefresh({
      // Test boundary: only `registerNativeCap` of the device context is used.
      ctx: { registerNativeCap } as unknown as DreameRefreshContext,
      brokerId: 'acct-1',
      minIntervalMs: 180_000,
      read,
    })
    const [cap, provider, options] = registerNativeCap.mock.calls[0] ?? []
    expect(cap).toBe(deviceStateRefreshCapability)
    expect(options).toEqual({ stateRefresh: dreameRefreshPolicy('acct-1', 180_000) })
    expect(options.stateRefresh.push).toBe('partial')
    await provider.refresh({ reason: 'schedule' })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('turns the library fallback poll off — the core is the only scheduler', () => {
    const options = toNodreameOptions({
      username: 'u',
      password: 'p',
      region: 'eu',
      pollIntervalMs: 30_000,
    })
    expect(options.pollIntervalMs).toBe(0)
  })
})
