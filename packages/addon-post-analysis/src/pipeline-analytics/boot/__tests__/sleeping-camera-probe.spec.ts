import { describe, expect, it } from 'vitest'
import { DeviceFeature } from '@camstack/types'
import { sleepingCameraProbe, type SleepingCameraProbeClient } from '../sleeping-camera-probe.js'

/**
 * The linked-camera shelf wakes a camera on an unknown state only when it
 * SLEEPS (#459, Q2). A device that merely reports a battery is not woken: it
 * carries `battery-operated`, never `sleeps`.
 */
function client(features: readonly string[] | null): SleepingCameraProbeClient {
  return {
    getDevice: {
      query: async () => (features === null ? null : { features: [...features] }),
    },
  }
}

describe('sleepingCameraProbe', () => {
  it('a camera that sleeps may be woken', async () => {
    const probe = sleepingCameraProbe(client([DeviceFeature.BatteryOperated, DeviceFeature.Sleeps]))
    await expect(probe(7)).resolves.toBe(true)
  })

  it('a device that only REPORTS a battery is not a sleeper', async () => {
    const probe = sleepingCameraProbe(client([DeviceFeature.BatteryOperated]))
    await expect(probe(7)).resolves.toBe(false)
  })

  it('an unknown device is unknown, never a sleeper (D49)', async () => {
    await expect(sleepingCameraProbe(client(null))(7)).resolves.toBeUndefined()
  })
})
