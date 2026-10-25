/**
 * S2 — the hub's `capability:provider-registered` hook must NOT emit `ready`
 * for `platform-probe`.
 *
 * The platform-probe provider registers synchronously from `onInitialize`
 * while its REAL probe (hardware + embedded-Python EP scoring) is still
 * running async. The registration-time `emitReady` flipped the cap `ready`
 * prematurely, so probe-gated consumers (detection-pipeline engine
 * auto-pick) read accelerator-blind results. The addon now owns its own
 * readiness (`autoEmitReadiness=false`, ready on probe-done); the hub hook
 * keeps emitting for every OTHER capability.
 */
import { describe, expect, it } from 'vitest'
import { shouldEmitProviderRegisteredReady } from '../addon-registry.service'

describe('shouldEmitProviderRegisteredReady', () => {
  it('suppresses the registration-time ready for platform-probe', () => {
    expect(shouldEmitProviderRegisteredReady('platform-probe')).toBe(false)
  })

  // device-history's ready is its STORE being open (`onHubReachable`), not its
  // registration. The registration-time emit flipped it ready while the store
  // was still closed, so every producer that declares on `ready`
  // (metrics-native, pipeline-analytics) declared into a provider that could
  // not answer and logged `node metrics history declare failed` on each boot.
  it('suppresses the registration-time ready for device-history (ready = store open)', () => {
    expect(shouldEmitProviderRegisteredReady('device-history')).toBe(false)
  })

  it('keeps the registration-time ready for every other capability', () => {
    for (const cap of [
      'stream-broker',
      'device-manager',
      'settings-store',
      'decoder',
      'device-removal-hook',
    ]) {
      expect(shouldEmitProviderRegisteredReady(cap)).toBe(true)
    }
  })
})
