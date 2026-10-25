/**
 * D13 — `requireDeviceScoped` must resolve a device cap provided by a WRAPPER
 * (system) provider, not just per-device natives. The emulated `autotrack`
 * builtin registers a SINGLETON `ptz-autotrack` wrapper provider (no native)
 * and the operator binds it to a camera; before this fix `requireDeviceScoped`
 * consulted ONLY `registry.getNativeProvider` → null → threw
 * PRECONDITION_FAILED "not registered for device", blocking a wrapper's
 * getStatus / settings methods (first seen on the since-retired virtual
 * doorbell).
 *
 * The fix keeps the fast native path unchanged and falls back to the unified
 * D13 resolver `registry.getProviderForDevice(cap, deviceId)` (native OR
 * device-bound system/wrapper) before the final throw. (There was once a
 * device-link SYNTHESIZE branch between the two; wiring was deleted 2026-08-08.)
 */

import type { CapabilityRegistry } from '@camstack/system'
import type { PtzAutotrackStatus } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { requireDeviceScoped } from '../../api/trpc/cap-mount-helpers.js'

type ProviderSurface = Readonly<Record<string, (i: unknown) => unknown>>

function makeRegistry(opts: {
  getNativeProvider?: (capName: string, deviceId: number) => ProviderSurface | null
  getProviderForDevice?: (capName: string, deviceId: number) => ProviderSurface | null
}): CapabilityRegistry {
  return {
    getNativeProvider<T>(capName: string, deviceId: number): T | null {
      return (opts.getNativeProvider?.(capName, deviceId) ?? null) as T | null
    },
    getProviderForDevice: vi.fn(<T>(capName: string, deviceId: number): T | null => {
      return (opts.getProviderForDevice?.(capName, deviceId) ?? null) as T | null
    }),
    getSingleton<T>(): T | null {
      return null
    },
    listCapabilities: vi.fn(() => []),
    registerProvider: vi.fn(),
    unregisterProvider: vi.fn(),
    getCollection: vi.fn(() => []),
    getCollectionEntries: vi.fn(() => []),
    registerNativeProvider: vi.fn(),
    unregisterNativeProvider: vi.fn(),
    getBindings: vi.fn(() => ({ entries: [] })),
    setActiveSingleton: vi.fn(),
    getSingletonAddonId: vi.fn(() => null),
    getAddonIdForProvider: vi.fn(() => null),
    on: vi.fn(),
    off: vi.fn(),
    dispose: vi.fn(),
  } as unknown as CapabilityRegistry
}

const DEVICE_ID = 101
const CAP_NAME = 'ptz-autotrack' as Parameters<typeof requireDeviceScoped>[1]

describe('requireDeviceScoped — wrapper (system) provider resolution (D13)', () => {
  it('(a) resolves a WRAPPER-only device cap via getProviderForDevice (getStatus)', async () => {
    const wrapperStatus: PtzAutotrackStatus = {
      enabled: true,
      lastChangedAt: 1234,
      currentSettings: null,
      supportedTargetTypes: [],
    }
    const wrapper: ProviderSurface = { getStatus: vi.fn(async () => wrapperStatus) }
    const registry = makeRegistry({
      getNativeProvider: () => null,
      getProviderForDevice: () => wrapper,
    })

    const dispatcher = requireDeviceScoped(registry, CAP_NAME)
    const result = await (
      dispatcher as unknown as { getStatus: (i: { deviceId: number }) => Promise<unknown> }
    ).getStatus({ deviceId: DEVICE_ID })

    expect(result).toEqual(wrapperStatus)
    expect(wrapper.getStatus).toHaveBeenCalledWith({ deviceId: DEVICE_ID })
  })

  it('(a2) resolves WRAPPER-provided settings methods too (not just getStatus)', async () => {
    const patched = { ok: true }
    const wrapper: ProviderSurface = { applyDeviceSettingsPatch: vi.fn(async () => patched) }
    const registry = makeRegistry({
      getNativeProvider: () => null,
      getProviderForDevice: () => wrapper,
    })

    const dispatcher = requireDeviceScoped(registry, CAP_NAME)
    const result = await (
      dispatcher as unknown as {
        applyDeviceSettingsPatch: (i: { deviceId: number; patch: unknown }) => Promise<unknown>
      }
    ).applyDeviceSettingsPatch({ deviceId: DEVICE_ID, patch: { source: 5 } })

    expect(result).toEqual(patched)
    expect(wrapper.applyDeviceSettingsPatch).toHaveBeenCalledWith({
      deviceId: DEVICE_ID,
      patch: { source: 5 },
    })
  })

  it('(b) REGRESSION: a native-provided cap resolves via getNativeProvider (fast path, no getProviderForDevice)', async () => {
    const nativeStatus: PtzAutotrackStatus = {
      enabled: false,
      lastChangedAt: 999,
      currentSettings: null,
      supportedTargetTypes: [],
    }
    const native: ProviderSurface = { getStatus: vi.fn(async () => nativeStatus) }
    const registry = makeRegistry({
      getNativeProvider: () => native,
      getProviderForDevice: () => ({ getStatus: vi.fn(async () => ({ wrong: true })) }),
    })

    const dispatcher = requireDeviceScoped(registry, CAP_NAME)
    const result = await (
      dispatcher as unknown as { getStatus: (i: { deviceId: number }) => Promise<unknown> }
    ).getStatus({ deviceId: DEVICE_ID })

    expect(result).toEqual(nativeStatus)
    expect(native.getStatus).toHaveBeenCalledWith({ deviceId: DEVICE_ID })
    // Fast path: the D13 fallback resolver must NOT be consulted when a native exists.
    expect(registry.getProviderForDevice).not.toHaveBeenCalled()
  })

  it('(c) throws PRECONDITION_FAILED when neither a native nor a wrapper resolves', async () => {
    const registry = makeRegistry({
      getNativeProvider: () => null,
      getProviderForDevice: () => null,
    })

    const dispatcher = requireDeviceScoped(registry, CAP_NAME)
    await expect(
      (
        dispatcher as unknown as { getStatus: (i: { deviceId: number }) => Promise<unknown> }
      ).getStatus({ deviceId: DEVICE_ID }),
    ).rejects.toThrow(/not registered for device 101/)
  })
})
