/**
 * Worker native-cap change-listener — regression guard.
 *
 * Device-scoped native caps register lazily as devices come online; for async
 * providers (Reolink Baichuan discovery) that can land AFTER the runner's
 * post-init UDS cap handshake. The runner subscribes via
 * `setWorkerNativeCapsChangeListener` and re-sends `updateCaps` when the set
 * mutates, so a late (cap, deviceId) binding reaches the hub's
 * LocalChildRegistry and stays routable (without it, `stream-catalog` was
 * unroutable → broker catalog empty → no device-settings tab).
 *
 * This locks the notification contract: the listener fires on a mutation and
 * stops firing once cleared. (The `registerNativeCap` → fire path is a single
 * `onWorkerNativeCapsChanged?.()` call exercised end-to-end at runtime.)
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  setWorkerNativeCapsChangeListener,
  clearWorkerNativeCapsForDevice,
} from '../../moleculer/device-cap-proxy.js'

afterEach(() => {
  // Always detach so one test's listener can't leak into the next.
  setWorkerNativeCapsChangeListener(null)
})

describe('worker native-cap change listener', () => {
  it('fires the listener when the native-cap set mutates (device clear)', () => {
    const listener = vi.fn()
    setWorkerNativeCapsChangeListener(listener)
    clearWorkerNativeCapsForDevice(12345)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('stops firing once the listener is cleared (null)', () => {
    const listener = vi.fn()
    setWorkerNativeCapsChangeListener(listener)
    clearWorkerNativeCapsForDevice(12345)
    expect(listener).toHaveBeenCalledTimes(1)

    setWorkerNativeCapsChangeListener(null)
    clearWorkerNativeCapsForDevice(12345)
    expect(listener).toHaveBeenCalledTimes(1) // unchanged — no further calls
  })

  it('replaces the prior listener (single-subscriber semantics)', () => {
    const first = vi.fn()
    const second = vi.fn()
    setWorkerNativeCapsChangeListener(first)
    setWorkerNativeCapsChangeListener(second)
    clearWorkerNativeCapsForDevice(12345)
    expect(first).not.toHaveBeenCalled()
    expect(second).toHaveBeenCalledTimes(1)
  })
})
