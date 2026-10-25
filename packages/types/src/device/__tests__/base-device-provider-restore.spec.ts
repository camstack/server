import { describe, it, expect } from 'vitest'
import { BaseDeviceProvider } from '../base-device-provider.js'
import type { CreateDeviceSpec, SavedDevice } from '../device-management.js'
import type { ConfigUISchema } from '../../interfaces/config-ui.js'
import type { IDevice } from '../device.js'
import type { DeviceConstructor } from '../device-context.js'
import { DeviceType } from '../device-type.js'

/**
 * Boot restore is a fan-out of independent dials, not a queue (D167).
 *
 * Measured on the live hub on 2026-08-15: thirteen Hikvision cameras came back
 * one at a time between t0+41 s and t0+16 m, each blocking the next on its own
 * ISAPI probe and on `UDS request timed out after 60000ms`. A camera does not
 * exist for live view, recording or detection until its `create()` lands, so
 * the LAST camera in the list was unusable for a quarter of an hour on a hub
 * that was otherwise healthy in forty seconds.
 *
 * There is no NVR in front of these cameras and nothing about a vendor
 * dial requires a queue: every top-level row starts at once. Pass 2
 * (hub-adopted children) still waits for a COMPLETE `restored` set so a
 * child of the slowest parent is not dropped.
 */

type CreateCall = { stableId: string }

class FakeDevice {
  constructor(readonly stableId: string) {}
}

interface Harness {
  provider: BaseDeviceProvider
  calls: CreateCall[]
  warnings: string[]
  peakInFlight: () => number
}

function harness(
  opts: {
    onCreate?: (stableId: string) => Promise<void>
    alreadyLive?: readonly string[]
    /** Brought to life by someone else WHILE the row's own dial is in flight. */
    liveDuringDial?: readonly string[]
  } = {},
): Harness {
  const calls: CreateCall[] = []
  const live: string[] = [...(opts.alreadyLive ?? [])]
  let inFlight = 0
  let peak = 0

  const devices = {
    create: async (stableId: string): Promise<IDevice> => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      try {
        await opts.onCreate?.(stableId)
        if (opts.liveDuringDial?.includes(stableId) && !live.includes(stableId)) live.push(stableId)
        // The real registry refuses a second object under an id it already
        // holds — the boot race this file's last test is about.
        if (live.includes(stableId)) {
          throw new Error(
            `Device numeric id 1025 already registered (stableId=${stableId}); attempted to register ${stableId}`,
          )
        }
        calls.push({ stableId })
        live.push(stableId)
        return new FakeDevice(stableId) as unknown as IDevice
      } finally {
        inFlight -= 1
      }
    },
    getAll: async (): Promise<IDevice[]> =>
      live.map((stableId) => new FakeDevice(stableId) as unknown as IDevice),
  }

  class TestProvider extends BaseDeviceProvider {
    protected readonly addonId = 'provider-test'
    protected readonly deviceClasses = {
      [DeviceType.Camera]: FakeDevice as unknown as DeviceConstructor<IDevice>,
    }
    protected readonly providerName = 'test'
    protected async onGetCreationSchema(): Promise<ConfigUISchema | null> {
      return null
    }
    protected async onCreateDevice(): Promise<CreateDeviceSpec> {
      throw new Error('not used')
    }
  }

  const provider = new TestProvider({})
  const warnings: string[] = []
  Reflect.set(provider, '_ctx', {
    logger: {
      debug: () => {},
      info: () => {},
      warn: (message: string) => {
        warnings.push(message)
      },
      error: () => {},
    },
    kernel: { devices },
  })
  return { provider, calls, warnings, peakInFlight: () => peak }
}

function row(id: number, parentDeviceId: number | null = null): SavedDevice {
  return {
    id,
    stableId: `cam-${id}`,
    type: DeviceType.Camera,
    name: `cam ${id}`,
    parentDeviceId,
    // A real restore row carries its persisted config — both entry points
    // (`runWorkerDeviceRestoreWithRetry`, `restoreAddonDevices`) read
    // `deviceManager.loadConfig` per row. An EMPTY blob is quarantined as a
    // leftover (D376), so a fixture that leaves it empty tests a device the
    // provider deliberately refuses.
    config: { host: '192.168.10.40' },
  } as unknown as SavedDevice
}

const settle = (): Promise<void> => new Promise<void>((resolve) => setTimeout(resolve, 5))

describe('BaseDeviceProvider.restoreDevices — top-level rows come back together', () => {
  it('starts every independent device at once — no lane cap', async () => {
    const h = harness({ onCreate: settle })
    await h.provider.restoreDevices([row(1), row(2), row(3), row(4), row(5)])

    expect(h.peakInFlight()).toBe(5)
    expect(h.calls).toHaveLength(5)
  })

  it('a camera that will not answer never delays the ones that would', async () => {
    const h = harness({
      onCreate: async (stableId) => {
        if (stableId === 'cam-1') {
          await settle()
          throw new Error('ISAPI probe timed out')
        }
      },
    })
    await h.provider.restoreDevices([row(1), row(2), row(3)])

    // The casualty is absent; the rest are present. A rejection inside the
    // fan-out must never reject the fan-out.
    expect(h.calls.map((c) => c.stableId).toSorted()).toEqual(['cam-2', 'cam-3'])
  })

  it('hub-adopted children still see the COMPLETE parent set', async () => {
    // Pass 2 spawns a child only when `restored` already holds its parent. Run
    // the passes concurrently and the child of the slowest parent is dropped.
    const h = harness({
      onCreate: async (stableId) => {
        if (stableId === 'cam-1') await settle()
      },
    })
    await h.provider.restoreDevices([row(1), row(2), row(9, 1)])

    expect(h.calls.map((c) => c.stableId).toSorted()).toEqual(['cam-1', 'cam-2', 'cam-9'])
  })

  it('a row the provider already brought to life before restore ran is restored, not re-dialled', async () => {
    // Live on 2026-09-05, every boot of provider-homeassistant: the broker
    // connects during onInitialize, `ensureEventBusDevice` creates
    // `ha:ha_001:events` (1025), and THEN the kernel calls restoreDevices
    // with the persisted row for the same stableId. The registry refuses the
    // second object, the row is counted failed, four retries collide with
    // the device that is already running, and boot ends on an ERROR for a
    // device that was never missing.
    const h = harness({ alreadyLive: ['cam-1'] })
    await h.provider.restoreDevices([row(1), row(2)])
    expect(h.calls.map((c) => c.stableId)).toEqual(['cam-2'])
    expect(h.warnings).toEqual([])
    expect(Reflect.get(h.provider, 'restoreRetryCompletion')).toBeNull()
  })

  it('a row whose device comes to life WHILE its own dial is in flight is restored, not retried', async () => {
    // The live order on 2026-09-05 23:17 (provider-homeassistant 1.2.82, the
    // first fix already deployed): the broker connected DURING the restore
    // pass, `ensureEventBusDevice` registered 1025 after the pass had taken
    // its snapshot and before the row's own `create()` returned. The registry
    // refused the row, and every retry round re-read the same stale snapshot.
    // The collision itself is the proof the device exists: re-read, then.
    const h = harness({ liveDuringDial: ['cam-1'] })
    await h.provider.restoreDevices([row(1), row(2)])
    expect(h.calls.map((c) => c.stableId)).toEqual(['cam-2'])
    expect(h.warnings).toEqual([])
    expect(Reflect.get(h.provider, 'restoreRetryCompletion')).toBeNull()
  })
})
