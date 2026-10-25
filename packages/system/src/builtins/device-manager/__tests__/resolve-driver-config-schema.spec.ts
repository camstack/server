/**
 * Unit tests for `resolveDriverConfigSchema` inside `DeviceManagerAddon`.
 *
 * The function is private so we exercise it through the public
 * `getDeviceSettingsAggregate` path, which calls `buildBaseDeviceSection`
 * which calls `resolveDriverConfigSchema`.
 *
 * Three scenarios under test:
 *   'ok'          – cross-process getSettingsSchema returns a schema.
 *   'none'        – cross-process getSettingsSchema returns null (no schema).
 *   'unavailable' – cross-process getSettingsSchema throws a transient
 *                   Moleculer error on every attempt; the base section
 *                   emits a visible "temporarily unavailable" info field
 *                   instead of silently dropping the driver settings.
 */

import { CapabilityRegistry, DeviceRegistry } from '@camstack/system'
import type {
  AddonContext,
  ConfigUISchemaWithValues,
  IDeviceManagerProvider,
  IDeviceOpsProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
} from '@camstack/types'
import { deviceOpsCapability } from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

// ── Fakes ────────────────────────────────────────────────────────────────────

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

function makeEventBus(): IEventBus {
  return { emit: vi.fn(), subscribe: () => () => {}, getRecent: () => [] } as unknown as IEventBus
}

function makeSettings() {
  let addonStore: Record<string, unknown> = {}
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore: vi.fn(async () => ({})),
    writeDeviceStore: vi.fn(async () => {}),
  }
}

/**
 * Build a minimal IDeviceOpsProvider fake whose `getSettingsSchema` is
 * controlled by the caller. All other methods are no-op stubs.
 */
function makeDeviceOpsProvider(
  getSettingsSchema: (input: { deviceId: number }) => Promise<ConfigUISchemaWithValues | null>,
): IDeviceOpsProvider {
  return {
    getDeviceInfo: vi.fn(async () => ({ type: 'camera', name: 'test' }) as never),
    getOnlineStatus: vi.fn(async () => ({ online: true }) as never),
    setName: vi.fn(async () => ({ success: true as const })),
    setConfig: vi.fn(async () => ({ success: true as const })),
    getConfig: vi.fn(async () => ({ values: {} }) as never),
    getSettingsSchema: vi.fn(getSettingsSchema),
    reload: vi.fn(async () => ({ success: true as const })),
    delete: vi.fn(async () => ({ success: true as const })),
  } as unknown as IDeviceOpsProvider
}

// ── Shared setup ─────────────────────────────────────────────────────────────

async function setupWithOpsProvider(
  opsProvider: IDeviceOpsProvider,
): Promise<{ provider: IDeviceManagerProvider; deviceId: number; logger: IScopedLogger }> {
  const addon = new DeviceManagerAddon()
  const settings = makeSettings()
  const deviceRegistry = new DeviceRegistry()
  const logger = makeLogger()
  const capabilityRegistry = new CapabilityRegistry(logger)

  const { api: settingsStoreApi } = await makeSettingsStoreApi()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: settingsStoreApi },
    id: 'device-manager',
    logger,
    eventBus: makeEventBus(),
    addonConfig: {},
    dataDir: '/tmp',
    settings,
    records,
    kernel: { deviceRegistry, capabilityRegistry },
  }

  const initResult = await addon.initialize(ctx as unknown as AddonContext)
  let providers: readonly ProviderRegistration[] = []
  if (Array.isArray(initResult)) {
    providers = initResult as readonly ProviderRegistration[]
  } else if (initResult && typeof initResult === 'object' && 'providers' in initResult) {
    providers = (initResult.providers ?? []) as readonly ProviderRegistration[]
  }
  const provider = providers[0]!.provider as IDeviceManagerProvider

  // Register device — no hub-local IDevice instance, so the device-manager
  // must go through the cross-process (native ops provider) path.
  const { id: deviceId } = await provider.allocateDeviceId({
    addonId: 'test-addon',
    stableId: 'device-1',
  })
  await provider.registerDevice({
    addonId: 'test-addon',
    stableId: 'device-1',
    id: deviceId,
    type: 'camera',
    name: 'Test Camera',
    parentDeviceId: null,
    config: {},
  })

  // Register the device-ops native provider so resolveDriverConfigSchema
  // finds it via capabilityRegistry.getNativeProvider('device-ops', deviceId).
  capabilityRegistry.declareCapability(deviceOpsCapability)
  capabilityRegistry.registerNativeProvider(
    deviceOpsCapability.name,
    deviceId,
    'test-addon',
    opsProvider,
  )
  capabilityRegistry.ready()

  // Also populate remoteNativeCaps so resolveNativeDeviceOwner finds the
  // device (required for buildBaseDeviceSection to proceed past the early
  // null guard).  We trigger this by emitting the DeviceBindingsChanged event
  // that the device-manager listens to.
  // Simpler: set it directly via the kernel deviceRegistry mock—but since
  // the capability registry's getNativeProvider is the actual path tested,
  // and the device registry mock doesn't have the hub-local IDevice,
  // `resolveNativeDeviceOwner` must also find an entry.  We stub it by
  // registering a system-scoped provider so `getNativeAddonId` returns
  // the addonId for deviceId.
  return { provider, deviceId, logger }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('resolveDriverConfigSchema — cross-process branch', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  it("status 'ok': includes driver sections when getSettingsSchema resolves", async () => {
    const opsProvider = makeDeviceOpsProvider(async () => ({
      sections: [
        {
          id: 'driver-general',
          title: 'Driver Settings',
          tab: 'general',
          order: 1,
          fields: [
            {
              type: 'text' as const,
              key: 'host',
              label: 'Host',
              default: '',
              value: '192.168.10.1',
            },
          ],
        },
      ],
    }))
    const { provider, deviceId } = await setupWithOpsProvider(opsProvider)

    const aggregate = await provider.getDeviceSettingsAggregate({ deviceId })
    expect(aggregate).not.toBeNull()
    const sectionIds = aggregate!.sections.map((s: { id: string }) => s.id)
    expect(sectionIds).toContain('driver-general')
    expect(sectionIds).not.toContain('driver-settings-unavailable')
  })

  it("status 'none': omits driver sections when getSettingsSchema returns null", async () => {
    const opsProvider = makeDeviceOpsProvider(async () => null)
    const { provider, deviceId } = await setupWithOpsProvider(opsProvider)

    const aggregate = await provider.getDeviceSettingsAggregate({ deviceId })
    // Identity left Config; with no driver schema the base contribution is
    // null. Other system contributors may still fill the aggregate — none
    // of them may invent a driver section here.
    const sectionIds = (aggregate?.sections ?? []).map((s: { id: string }) => s.id)
    expect(sectionIds).not.toContain('driver-general')
    expect(sectionIds).not.toContain('driver-settings-unavailable')
    expect(sectionIds).not.toContain('device-identity')
  })

  it("status 'unavailable': emits warning placeholder when all retries throw a transient error", async () => {
    const transientError = Object.assign(
      new Error("Service 'test-addon.device-ops.getSettingsSchema' is not available."),
      { retryable: true },
    )
    const getSettingsSchema = vi.fn(async () => {
      throw transientError
    })
    const opsProvider = makeDeviceOpsProvider(getSettingsSchema)
    const { provider, deviceId, logger } = await setupWithOpsProvider(opsProvider)

    // Run aggregate — the retry loop delays with setTimeout; advance timers
    // so the retries complete without real wall-clock time.
    const aggregatePromise = provider.getDeviceSettingsAggregate({ deviceId })
    // Advance past 2 retry delays (750 ms each)
    await vi.advanceTimersByTimeAsync(2000)
    const aggregate = await aggregatePromise

    // Identity left Config; the unavailable placeholder is the base
    // contribution when the worker cannot answer.
    expect(aggregate).not.toBeNull()
    const sectionIds = aggregate!.sections.map((s: { id: string }) => s.id)
    expect(sectionIds).toContain('driver-settings-unavailable')
    expect(sectionIds).not.toContain('device-identity')

    // The placeholder must carry an 'info' field with variant 'warning'.
    const unavailableSection = aggregate!.sections.find(
      (s: { id: string }) => s.id === 'driver-settings-unavailable',
    )!
    const infoField = (unavailableSection.fields as Array<{ type: string; variant?: string }>)[0]!
    expect(infoField.type).toBe('info')
    expect(infoField.variant).toBe('warning')

    // getSettingsSchema should have been called 3 times (1 initial + 2 retries).
    expect(getSettingsSchema).toHaveBeenCalledTimes(3)

    // A warn-level log must have been emitted.
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('temporarily unavailable'),
      expect.any(Object),
    )
  })

  it('does not retry on non-transient errors (breaks out immediately)', async () => {
    const nonTransientError = new Error('Internal provider error — not retryable')
    // No `retryable` flag, no matching code, no matching message substring.
    const getSettingsSchema = vi.fn(async () => {
      throw nonTransientError
    })
    const opsProvider = makeDeviceOpsProvider(getSettingsSchema)
    const { provider, deviceId } = await setupWithOpsProvider(opsProvider)

    const aggregatePromise = provider.getDeviceSettingsAggregate({ deviceId })
    await vi.advanceTimersByTimeAsync(2000)
    const aggregate = await aggregatePromise

    // Still treated as unavailable after the single (non-retried) failure.
    const sectionIds = aggregate!.sections.map((s: { id: string }) => s.id)
    expect(sectionIds).toContain('driver-settings-unavailable')

    // Only called once — no retries for non-transient errors.
    expect(getSettingsSchema).toHaveBeenCalledTimes(1)
  })
})
