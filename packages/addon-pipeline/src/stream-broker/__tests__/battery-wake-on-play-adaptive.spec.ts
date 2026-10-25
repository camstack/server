import { DeviceFeature, type AddonApi, type IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { StreamBrokerManager } from '../stream-broker/stream-broker-manager.js'

/**
 * Wake-on-play for ADAPTIVE targets (live-hub regression, 2026-08-15,
 * device 106 "Baby monitor").
 *
 * An adaptive WebRTC target resolves to the sentinel brokerId
 * `<deviceId>/adaptive` — a name no broker is EVER registered under, because
 * `BrokerWebrtcServer.resolveBrokerId` maps it through `selectBestBroker` at
 * offer time. `wakeBatteryDeviceOnPlay` used to poll
 * `hasRegisteredBroker('106/adaptive')` through the whole settle window: the
 * wake ACK'd, the catalog reconcile published real brokers
 * (`106/native:main`, …), and the loop still exhausted after 20 s and threw
 * "waking" — so the offer never reached the adaptive selection that would
 * have succeeded.
 *
 * The contract pinned here: for `camStreamId === undefined` (adaptive), the
 * demand is satisfied by ANY broker registered for the device; for a pinned
 * cam-stream it stays the exact brokerId.
 */

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

interface ManagerInternals {
  brokers: Map<string, object>
  reconcileDeviceCatalog: (deviceId: number) => Promise<void>
}

function makeManager(options: {
  readonly awoke: boolean
  /** When true, the catalog reconcile publishes a broker (any profile). */
  readonly reconcilePublishesBroker: boolean
}): {
  manager: StreamBrokerManager
  internals: ManagerInternals
  wakeCalls: () => number
} {
  const manager = new StreamBrokerManager(makeLogger())
  let wakeCalls = 0
  const api = {
    deviceManager: {
      getDevice: {
        query: async () => ({
          id: 640,
          features: [DeviceFeature.BatteryOperated],
        }),
      },
    },
    deviceState: {
      getCapSlice: {
        query: async () => ({
          percentage: 99,
          charging: 'dc',
          sleeping: true,
          lastUpdated: Date.now(),
          lastContactAt: Date.now(),
        }),
      },
    },
    battery: {
      wakeForStream: {
        mutate: async () => {
          wakeCalls += 1
          return { awoke: options.awoke, durationMs: 100 }
        },
      },
    },
  }
  manager.setApiAccess(api as unknown as AddonApi, 'hub')

  const internals = manager as unknown as ManagerInternals
  // The settle loop's reconcile is what turns a woken camera into published
  // cam-streams; here it mints the broker directly, one poll late — exactly
  // what the live hub did at 15:12:50, mid-window.
  internals.reconcileDeviceCatalog = async () => {
    if (options.reconcilePublishesBroker) {
      internals.brokers.set('106/native:sub', {})
    }
  }
  return { manager, internals, wakeCalls: () => wakeCalls }
}

describe('wakeBatteryDeviceOnPlay — adaptive targets', () => {
  it('returns without waking when ANY broker for the device already exists', async () => {
    const { manager, internals, wakeCalls } = makeManager({
      awoke: true,
      reconcilePublishesBroker: false,
    })
    internals.brokers.set('106/native:main', {})

    await manager.wakeBatteryDeviceOnPlay(106, '106/adaptive', undefined)

    expect(wakeCalls()).toBe(0)
  })

  it('a wake settles as soon as the reconcile publishes ANY device broker', async () => {
    const { manager, wakeCalls } = makeManager({ awoke: true, reconcilePublishesBroker: true })

    // Would run the full 20 s settle and throw 'waking' before the fix;
    // now the first reconcile publishes `106/native:sub` and the demand is
    // satisfied even though `106/adaptive` never literally exists.
    await manager.wakeBatteryDeviceOnPlay(106, '106/adaptive', undefined)

    expect(wakeCalls()).toBe(1)
  })

  it('a pinned cam-stream still waits for ITS brokerId, not a sibling', async () => {
    vi.useFakeTimers()
    try {
      const { manager, internals } = makeManager({ awoke: true, reconcilePublishesBroker: true })
      internals.reconcileDeviceCatalog = async () => {
        // The reconcile publishes a DIFFERENT profile than the one demanded.
        internals.brokers.set('106/native:main', {})
      }

      const demand = manager.wakeBatteryDeviceOnPlay(106, '106/native:sub', 'native:sub')
      const assertion = expect(demand).rejects.toThrow(/waking|sleeping/)
      // Burn through the whole 20 s settle window without real waiting.
      await vi.advanceTimersByTimeAsync(25_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})
