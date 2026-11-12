/**
 * `deviceAdoption.adopt` is the operator re-adding hardware they just deleted.
 *
 * `createDevice` and `adoptDevice` already suspend the removal fence for that
 * call. `adoptionAdopt` did not: the provider allocates the id itself, and
 * `allocateDeviceId` refused the pair for the whole 5-minute TTL. An allocate
 * that is NOT that operator action stays refused.
 */
import type { ICapabilityRegistry, IDeviceManagerProvider } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { asDevice, FakeDevice, setup } from './device-manager-harness.js'

const ADDON = 'provider-dreame'
const STABLE = 'dreame:int_0009:2045106661'
const OTHER = 'dreame:int_0009:other'

interface AdoptedDevice {
  readonly childNativeId: string
  readonly parentDeviceId: number
  readonly accessoryDeviceIds: readonly number[]
}

/**
 * The addon only calls `waitForProvider`, `setStatusOverlay` and
 * `unregisterAllNativeForDevice` on this path. The registry class is not what
 * is under test, so the double is asserted at that boundary.
 */
function adoptionRegistry(
  adopt: (
    provider: IDeviceManagerProvider,
  ) => Promise<{ readonly adopted: readonly AdoptedDevice[] }>,
  holder: { provider: IDeviceManagerProvider | null },
): ICapabilityRegistry {
  const registry = {
    waitForProvider: async () => ({
      adopt: async () => {
        const provider = holder.provider
        if (provider === null) throw new Error('device-manager provider is not ready')
        return adopt(provider)
      },
    }),
    unregisterAllNativeForDevice: vi.fn(),
    setStatusOverlay: vi.fn(),
  }
  return registry as unknown as ICapabilityRegistry
}

async function bringUp(h: Awaited<ReturnType<typeof setup>>, stableId: string): Promise<number> {
  const { id } = await h.provider.allocateDeviceId({ addonId: ADDON, stableId })
  await h.provider.persistConfig({ deviceId: id, data: { host: '192.168.10.40' } })
  h.registry.register(ADDON, asDevice(new FakeDevice(stableId, id)))
  await h.provider.registerDevice({
    addonId: ADDON,
    stableId,
    id,
    type: 'camera',
    name: stableId,
    parentDeviceId: null,
    features: [],
    config: {},
  })
  return id
}

describe('deviceAdoption.adopt lifts the removal fence', () => {
  it('adopts a device that was removed moments ago, and still refuses an unrelated allocate', async () => {
    const holder: { provider: IDeviceManagerProvider | null } = { provider: null }
    const h = await setup({
      capabilityRegistry: adoptionRegistry(async (provider) => {
        const allocated = await provider.allocateDeviceId({ addonId: ADDON, stableId: STABLE })
        return {
          adopted: [
            {
              childNativeId: '2045106661',
              parentDeviceId: allocated.id,
              accessoryDeviceIds: [],
            },
          ],
        }
      }, holder),
    })
    holder.provider = h.provider

    const removed = await bringUp(h, STABLE)
    const otherId = await bringUp(h, OTHER)
    await h.provider.removeDevice({ deviceId: removed })
    await h.provider.removeDevice({ deviceId: otherId })

    await expect(h.provider.allocateDeviceId({ addonId: ADDON, stableId: OTHER })).rejects.toThrow(
      /removed/i,
    )

    const adopted = await h.provider.adoptionAdopt({
      addonId: ADDON,
      integrationId: 'int_0009',
      childNativeIds: ['2045106661'],
    })
    expect(adopted.adopted[0]?.parentDeviceId).toBeGreaterThan(0)

    await expect(h.provider.allocateDeviceId({ addonId: ADDON, stableId: OTHER })).rejects.toThrow(
      /removed/i,
    )
  })
})
