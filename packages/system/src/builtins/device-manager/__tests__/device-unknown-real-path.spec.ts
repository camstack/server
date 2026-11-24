/**
 * D1099 — the REAL write path: `setCapSlice` resolves a child device's
 * integration from its own row, else its parent's, and the gate holds the
 * child's offline until the integration's first read. (The mirror-level spec
 * names the integration by hand; this one drives the addon.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  __resetStateRefreshPolicyRegistryForTests,
  getStateRefreshPolicyRegistry,
} from '../../../kernel/state-refresh-policies.js'
import {
  FakeDevice,
  type Harness,
  asDevice,
  registerCamera,
  setup,
} from './device-manager-harness.js'

const ADDON = 'provider-ha'
const POLICY = {
  integrationId: 'ha-1',
  minIntervalMs: 3_600_000,
  batch: true,
  push: 'none',
} as const

async function registerChild(
  h: Harness,
  stableId: string,
  parentDeviceId: number,
): Promise<number> {
  const dev = new FakeDevice(stableId)
  h.registry.register(ADDON, asDevice(dev))
  await h.provider.allocateDeviceId({ addonId: ADDON, stableId })
  await h.provider.registerDevice({
    addonId: ADDON,
    stableId,
    id: dev.id,
    type: 'sensor',
    name: stableId,
    parentDeviceId,
    config: {},
  })
  return dev.id
}

beforeEach(() => {
  __resetStateRefreshPolicyRegistryForTests()
  // The scheduler's first read is a timer; never advanced, the first read never lands.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
})
afterEach(() => {
  vi.useRealTimers()
  __resetStateRefreshPolicyRegistryForTests()
})

describe('setCapSlice resolves a child to its integration through the parent row (D1099)', () => {
  it('holds a child offline while the broker policy awaits its first read', async () => {
    const h = await setup()
    const broker = await registerCamera(h, ADDON, 'broker')
    await h.provider.setIntegrationId({ deviceId: broker, integrationId: 'ha-1' })
    // The child carries NO integrationId of its own — only its parent does.
    const child = await registerChild(h, 'child-1', broker)
    getStateRefreshPolicyRegistry().set('in-process', {
      deviceId: broker,
      addonId: ADDON,
      policy: POLICY,
    })

    await h.setCapSlice(child, 'device-status', { online: true, lastChangedAt: 1_000 })
    await h.setCapSlice(child, 'device-status', { online: false, lastChangedAt: 2_000 })

    expect(await h.capSlice(child, 'device-status')).toMatchObject({ online: true, unknown: true })
  })

  it('a child with no integration on its row or its parent stays ungated (legacy rows)', async () => {
    const h = await setup()
    const broker = await registerCamera(h, ADDON, 'broker')
    const child = await registerChild(h, 'child-1', broker)
    getStateRefreshPolicyRegistry().set('in-process', {
      deviceId: broker,
      addonId: ADDON,
      policy: POLICY,
    })

    await h.setCapSlice(child, 'device-status', { online: false, lastChangedAt: 2_000 })

    expect(await h.capSlice(child, 'device-status')).toMatchObject({ online: false })
  })
})
