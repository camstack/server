import {
  deviceSleeps,
  LowPowerSleepStatusSchema,
  lowPowerSleepCapability,
  type AddonApi,
} from '@camstack/types'
import type { RecordingWakeDeps } from './battery-wake.js'
import { withDeadline } from './with-deadline.js'

/** The part of a registry device the wake reads. */
export interface RecordingWakeDeviceFacts {
  readonly features: readonly string[]
}

/** A type alias, not an interface: tRPC's input carries an index signature. */
export type RecordingWakeDeviceQuery = { readonly deviceId: number }

/**
 * The three hub calls a recording wake makes, and nothing else. A structural
 * subset that the real `AddonApi` satisfies.
 */
export interface RecordingWakeApi {
  readonly deviceManager: {
    readonly getDevice: {
      readonly query: (input: RecordingWakeDeviceQuery) => Promise<RecordingWakeDeviceFacts | null>
    }
  }
  readonly deviceState: Pick<AddonApi['deviceState'], 'getCapSlice'>
  readonly lowPowerSleep: Pick<AddonApi['lowPowerSleep'], 'wakeForStream'>
}

/**
 * The recorder's wake deps, read from the hub (#459, Q2): the class is
 * `DeviceFeature.Sleeps` from the DEVICE registry (never the published
 * cam-streams: there are none — that is precisely why we are here), the facts
 * are the `low-power-sleep` slice, and the wake is that cap's `wakeForStream`.
 *
 * BOUNDED. The two reads sit on the attach critical path, ahead of every
 * broker call, and an unbounded UDS round-trip here delays the writer spawn
 * for a camera that does not even sleep. A read that times out yields `null`
 * -> UNKNOWN -> no wake, the same safe outcome as a read that failed (D49).
 */
export function recordingWakeDeps(
  api: RecordingWakeApi,
  readTimeoutMs: number,
  nowMs: () => number,
): RecordingWakeDeps {
  return {
    isBatteryDevice: async (id) => {
      const dev = await withDeadline(
        api.deviceManager.getDevice.query({ deviceId: id }),
        readTimeoutMs,
        'getDevice',
      ).catch(() => null)
      if (!dev) return null
      return deviceSleeps(dev.features)
    },
    readBatteryFacts: async (id) => {
      const slice = await withDeadline(
        api.deviceState.getCapSlice.query({ deviceId: id, capName: lowPowerSleepCapability.name }),
        readTimeoutMs,
        'getCapSlice',
      ).catch(() => null)
      const parsed = LowPowerSleepStatusSchema.safeParse(slice)
      if (!parsed.success) return null
      return { sleeping: parsed.data.sleeping, lastContactAt: parsed.data.lastContactAt }
    },
    wakeForStream: async (id, timeoutMs) =>
      api.lowPowerSleep.wakeForStream.mutate({ deviceId: id, timeoutMs }),
    nowMs,
  }
}
