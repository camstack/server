import { describe, it, expect, afterEach } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { motionZonesCapability } from '@camstack/types'
import { mountNativeCapService } from '../../moleculer/device-cap-proxy.js'

/**
 * Regression coverage for the cross-process `getStatus` hang.
 *
 * `mountNativeCapService` used to iterate bare `cap.methods` when
 * building the worker-side Moleculer service. The `getStatus` method is
 * auto-injected (the cap carries a `status` block, not an explicit
 * `methods.getStatus`), so its action was never mounted — and the
 * hub-side `buildNativeCapProxy` then retried "service not found"
 * forever via `callWithServiceDiscoveryRetry`, hanging every
 * `ctx.api.<cap>.getStatus` / `motionZones.getStatus` call on a forked
 * camera. The fix walks `expandCapMethods(cap)` instead.
 */
describe('mountNativeCapService — auto-injected method exposure', () => {
  let broker: ServiceBroker

  afterEach(async () => {
    if (broker) await broker.stop()
  })

  it('mounts the auto-injected getStatus action for a status-bearing cap', async () => {
    broker = new ServiceBroker({ nodeID: 'worker', transporter: 'Fake', logger: false })
    // Unique addonId — `mountNativeCapService` dedupes by service name
    // via a module-level Set across the whole test run.
    mountNativeCapService(broker, 'getstatus-addon', motionZonesCapability)
    await broker.start()

    // `getStatus` is NOT in `motionZonesCapability.methods` — it is
    // auto-injected from the `status` block. The handler rejects with
    // "no provider" (no device registered in this unit test), which
    // still proves the ACTION EXISTS. Before the fix this rejected with
    // "is not found" — the symptom that made `buildNativeCapProxy` spin
    // forever.
    await expect(
      broker.call('getstatus-addon.native-provider.motion-zones.getStatus', { deviceId: 1 }),
    ).rejects.toThrow(/no provider/)

    // Explicitly-declared methods stay reachable.
    await expect(
      broker.call('getstatus-addon.native-provider.motion-zones.getOptions', { deviceId: 1 }),
    ).rejects.toThrow(/no provider/)

    // A genuinely-unknown method still surfaces "is not found" — the
    // exposure is scoped to the cap's effective method surface, not a
    // catch-all.
    await expect(
      broker.call('getstatus-addon.native-provider.motion-zones.bogusMethod', { deviceId: 1 }),
    ).rejects.toThrow(/is not found/)
  })
})
