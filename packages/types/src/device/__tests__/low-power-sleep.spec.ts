import { describe, expect, it, vi } from 'vitest'
import { deviceSleeps, sleepSliceOfBattery } from '../low-power-sleep.js'
import { resyncThroughAdoption, type AdoptionResyncClient } from '../resync-through-adoption.js'
import { DeviceFeature } from '../device-type.js'

describe('deviceSleeps', () => {
  it('a battery sensor that reports charge does not sleep', () => {
    expect(deviceSleeps([DeviceFeature.BatteryOperated])).toBe(false)
  })

  it('a device carrying the derived sleeps feature does', () => {
    expect(deviceSleeps([DeviceFeature.BatteryOperated, DeviceFeature.Sleeps])).toBe(true)
  })
})

describe('sleepSliceOfBattery', () => {
  it('carries the sleep inputs and nothing else', () => {
    expect(
      sleepSliceOfBattery({
        level: 40,
        charging: 'none',
        sleeping: true,
        lastUpdated: 5,
        lastContactAt: 3,
      }),
    ).toEqual({ sleeping: true, lastContactAt: 3, lastUpdated: 5 })
  })
})

describe('resyncThroughAdoption', () => {
  it('asks the owning addon through deviceManager.adoptionResync', async () => {
    const mutate = vi.fn(async () => ({ changed: true, rebuiltChildren: 1, removedChildren: 0 }))
    const client: AdoptionResyncClient = { adoptionResync: { mutate } }
    const provider = resyncThroughAdoption(client, 7)
    await expect(provider.resync({ deviceId: 7, resetToSource: true })).resolves.toEqual({
      changed: true,
      rebuiltChildren: 1,
      removedChildren: 0,
    })
    expect(mutate).toHaveBeenCalledWith({ camDeviceId: 7, resetToSource: true })
  })

  it('refuses another device', async () => {
    const client: AdoptionResyncClient = { adoptionResync: { mutate: vi.fn() } }
    await expect(resyncThroughAdoption(client, 7).resync({ deviceId: 8 })).rejects.toThrow(
      /mismatch/,
    )
  })
})
