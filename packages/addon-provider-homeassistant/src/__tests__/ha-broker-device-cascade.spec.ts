import { describe, it, expect, vi } from 'vitest'
import { cascadeRemoveDevicesForBroker } from '../ha-broker-device-cascade.js'
import type { IScopedLogger, IDeviceRegistry, DeviceManagerApi, IDevice } from '@camstack/types'

const logger: IScopedLogger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return logger
  },
  withTags() {
    return logger
  },
}

/** Minimal stand-in: only `id` and `parentDeviceId` are read by the helper. */
function dev(id: number, parentDeviceId: number | null): IDevice {
  return { id, parentDeviceId } as unknown as IDevice
}

describe('cascadeRemoveDevicesForBroker', () => {
  it('removes only parent devices whose source.brokerId matches', async () => {
    const removed: number[] = []
    const configs: Record<number, Record<string, unknown>> = {
      1: { system: 'homeassistant', brokerId: 'b1', haDeviceId: 'd1' }, // parent of b1 → remove
      2: { system: 'homeassistant', brokerId: 'b1', entityId: 'sensor.x' }, // child (parentDeviceId set) → skip directly (cascades)
      3: { system: 'homeassistant', brokerId: 'b2', haDeviceId: 'd2' }, // other broker → keep
      4: {}, // non-HA → keep
    }
    const reg: Pick<IDeviceRegistry, 'getAllForAddon'> = {
      getAllForAddon: () => [dev(1, null), dev(2, 1), dev(3, null), dev(4, null)],
    }
    const devices: Pick<DeviceManagerApi, 'loadConfig' | 'remove'> = {
      loadConfig: vi.fn(async (id: number) => configs[id] ?? {}),
      remove: vi.fn(async (id: number) => {
        removed.push(id)
      }),
    }
    const count = await cascadeRemoveDevicesForBroker({
      reg,
      devices,
      addonId: 'provider-homeassistant',
      brokerId: 'b1',
      logger,
    })
    expect(removed).toEqual([1]) // only the b1 parent; child 2 cascades via kernel; 3/4 untouched
    expect(count).toBe(1)
  })

  it('best-effort: a failed remove is logged, others continue', async () => {
    const removed: number[] = []
    const reg: Pick<IDeviceRegistry, 'getAllForAddon'> = {
      getAllForAddon: () => [dev(1, null), dev(2, null)],
    }
    const devices: Pick<DeviceManagerApi, 'loadConfig' | 'remove'> = {
      loadConfig: vi.fn(
        async (): Promise<Record<string, unknown>> => ({
          system: 'homeassistant',
          brokerId: 'b1',
          haDeviceId: 'd',
        }),
      ),
      remove: vi.fn(async (id: number) => {
        if (id === 1) throw new Error('boom')
        removed.push(id)
      }),
    }
    const count = await cascadeRemoveDevicesForBroker({
      reg,
      devices,
      addonId: 'a',
      brokerId: 'b1',
      logger,
    })
    expect(removed).toEqual([2])
    expect(count).toBe(1)
  })
})
