import { describe, it, expect, vi } from 'vitest'
import { reconcileBroker } from '../ha-reconcile-broker.js'
import type { HaDiscoveredDevice } from '../ha-discovery-types.js'

const BROKER_ID = 'ha_001'

function discoveredFixture(): readonly HaDiscoveredDevice[] {
  return [
    {
      haDeviceId: 'ha-dev-1',
      name: 'Plug',
      area: null,
      manufacturer: null,
      model: null,
      swVersion: null,
      integration: null,
      entityCount: 0,
      entities: [],
      alreadyAdopted: false,
      adoptedCamDeviceId: null,
    },
  ]
}

describe('reconcileBroker (per-tick orchestration)', () => {
  it('fetches discovery ONCE and runs BOTH reconcilers with the shared snapshot', async () => {
    const discovered = discoveredFixture()
    const fetch = vi.fn(async () => discovered)
    const reconcileContainers = vi.fn(async () => {})
    const reconcileStandalone = vi.fn(async () => {})

    await reconcileBroker(BROKER_ID, { fetch, reconcileContainers, reconcileStandalone })

    // Fix 2: a single tick fetches the inventory exactly once.
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith(BROKER_ID)

    // Fix 1: BOTH reconcile paths run (on-connect = HA restart re-sync covers
    // standalone entities too, not only Containers).
    expect(reconcileContainers).toHaveBeenCalledTimes(1)
    expect(reconcileStandalone).toHaveBeenCalledTimes(1)

    // Both receive the SAME shared snapshot from the single fetch.
    expect(reconcileContainers).toHaveBeenCalledWith(BROKER_ID, discovered)
    expect(reconcileStandalone).toHaveBeenCalledWith(BROKER_ID, discovered)
  })

  it('skips BOTH reconcilers and reports the error when the single fetch fails', async () => {
    const error = new Error('ws down')
    const fetch = vi.fn(async () => {
      throw error
    })
    const reconcileContainers = vi.fn(async () => {})
    const reconcileStandalone = vi.fn(async () => {})
    const onFetchError = vi.fn()

    await expect(
      reconcileBroker(BROKER_ID, { fetch, reconcileContainers, reconcileStandalone, onFetchError }),
    ).resolves.toBeUndefined()

    expect(reconcileContainers).not.toHaveBeenCalled()
    expect(reconcileStandalone).not.toHaveBeenCalled()
    expect(onFetchError).toHaveBeenCalledWith(BROKER_ID, error)
  })

  it('runs the standalone reconciler even when the container reconciler throws (isolated)', async () => {
    const discovered = discoveredFixture()
    const fetch = vi.fn(async () => discovered)
    const reconcileContainers = vi.fn(async () => {
      throw new Error('container boom')
    })
    const reconcileStandalone = vi.fn(async () => {})

    await expect(
      reconcileBroker(BROKER_ID, { fetch, reconcileContainers, reconcileStandalone }),
    ).resolves.toBeUndefined()

    expect(reconcileStandalone).toHaveBeenCalledTimes(1)
  })

  it('does not propagate a standalone reconciler failure (sweep stays best-effort)', async () => {
    const discovered = discoveredFixture()
    const fetch = vi.fn(async () => discovered)
    const reconcileContainers = vi.fn(async () => {})
    const reconcileStandalone = vi.fn(async () => {
      throw new Error('standalone boom')
    })

    await expect(
      reconcileBroker(BROKER_ID, { fetch, reconcileContainers, reconcileStandalone }),
    ).resolves.toBeUndefined()

    expect(reconcileContainers).toHaveBeenCalledTimes(1)
  })
})
