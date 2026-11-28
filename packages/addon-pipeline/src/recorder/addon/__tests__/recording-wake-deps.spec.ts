import { describe, expect, it } from 'vitest'
import { DeviceFeature } from '@dominevo/types'
import { recordingWakeDeps, type RecordingWakeApi } from '../recording-wake-deps.js'

/**
 * The recorder wakes a camera that SLEEPS (#459, Q2): the class is
 * `DeviceFeature.Sleeps`, the facts are the `low-power-sleep` slice, the wake
 * is `lowPowerSleep.wakeUp`. A device that only reports a battery is
 * not a sleeper, and its battery slice carries no sleep the recorder believes.
 */
interface Calls {
  readonly wakes: Array<{ deviceId: number; timeoutMs?: number }>
  readonly sliceCaps: string[]
}

function api(features: readonly string[] | null | 'throws', calls: Calls): RecordingWakeApi {
  return {
    deviceManager: {
      getDevice: {
        query: async () => {
          if (features === 'throws') throw new Error('hub unreachable')
          return features === null ? null : { features: [...features] }
        },
      },
    },
    deviceState: {
      getCapSlice: {
        query: async (input: { capName: string }) => {
          calls.sliceCaps.push(input.capName)
          return input.capName === 'low-power-sleep'
            ? { sleeping: true, lastContactAt: 1234, lastUpdated: 1 }
            : { percentage: 50, sleeping: false, lastContactAt: 1, lastUpdated: 1 }
        },
      },
    },
    lowPowerSleep: {
      wakeUp: {
        mutate: async (input: { deviceId: number; timeoutMs?: number }) => {
          calls.wakes.push(input)
          return { awoke: true, durationMs: 10 }
        },
      },
    },
  }
}

const fresh = (): Calls => ({ wakes: [], sliceCaps: [] })

describe('recordingWakeDeps', () => {
  it('a camera that sleeps is a sleeper', async () => {
    const deps = recordingWakeDeps(api([DeviceFeature.Sleeps], fresh()), 1000, () => 0)
    await expect(deps.isBatteryDevice(7)).resolves.toBe(true)
  })

  it('a device that only reports a battery is not a sleeper', async () => {
    const deps = recordingWakeDeps(api([DeviceFeature.BatteryOperated], fresh()), 1000, () => 0)
    await expect(deps.isBatteryDevice(7)).resolves.toBe(false)
  })

  it('a failed or empty registry read is unknown (D49)', async () => {
    await expect(
      recordingWakeDeps(api('throws', fresh()), 1000, () => 0).isBatteryDevice(7),
    ).resolves.toBeNull()
    await expect(
      recordingWakeDeps(api(null, fresh()), 1000, () => 0).isBatteryDevice(7),
    ).resolves.toBeNull()
  })

  it('reads the facts from the low-power-sleep slice, never battery', async () => {
    const calls = fresh()
    const facts = await recordingWakeDeps(
      api([DeviceFeature.Sleeps], calls),
      1000,
      () => 0,
    ).readBatteryFacts(7)
    expect(calls.sliceCaps).toEqual(['low-power-sleep'])
    expect(facts).toEqual({ sleeping: true, lastContactAt: 1234 })
  })

  it('wakes through lowPowerSleep.wakeUp with the device and the timeout', async () => {
    const calls = fresh()
    await recordingWakeDeps(api([DeviceFeature.Sleeps], calls), 1000, () => 0).wakeUp(7, 9000)
    expect(calls.wakes).toEqual([{ deviceId: 7, timeoutMs: 9000 }])
  })
})
