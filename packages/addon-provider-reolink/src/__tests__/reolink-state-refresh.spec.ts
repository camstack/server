/**
 * D1062: the NVR session's sleep reconcile is driven by the core, through the session's own
 * `refresh()`. It reads the NVR only: a refresh never dials or wakes a child camera.
 */
import { deviceStateRefreshCapability } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { HUB_CHILD_SLEEP_RECONCILE_MS } from '../reolink-hub-session.js'
import { hubChildRefreshPolicy, registerHubChildStateRefresh } from '../reolink-state-refresh.js'

describe('hub child state refresh', () => {
  it('declares a batch, partial-push policy floored at the sleep reconcile cadence', () => {
    expect(hubChildRefreshPolicy('int-1')).toEqual({
      integrationId: 'int-1',
      minIntervalMs: HUB_CHILD_SLEEP_RECONCILE_MS,
      batch: true,
      push: 'partial',
    })
  })

  it('a refresh calls the NVR session and nothing else; no session is a loud failure', async () => {
    const registerNativeCap = vi.fn()
    const refresh = vi.fn(async () => {})
    let live: { refresh: () => Promise<void> } | null = { refresh }
    registerHubChildStateRefresh({
      ctx: { registerNativeCap },
      integrationId: 'int-1',
      hubChild: true,
      session: () => live,
    })
    const [cap, provider] = registerNativeCap.mock.calls[0] ?? []
    expect(cap).toBe(deviceStateRefreshCapability)
    await provider.refresh({ reason: 'schedule' })
    expect(refresh).toHaveBeenCalledTimes(1)

    live = null
    await expect(provider.refresh({ reason: 'schedule' })).rejects.toThrow(/no NVR session/)
  })
})
