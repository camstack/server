/**
 * device-settings-contribution-dispatch.spec.ts
 *
 * Regression tests for Bug-3: snapshot `getDeviceSettingsContribution` not
 * found on native provider.
 *
 * Root cause: device-manager.addon.ts used `getProviderForDevice` for the
 * three `exposesDeviceSettings` contribution methods. `getProviderForDevice`
 * returns the native first when present (e.g. Reolink/ONVIF); the native
 * only implements camera-specific operations (getSnapshot, invalidateCache),
 * NOT the contribution methods. The cross-process dispatch then throws
 * "native-provider: method 'getDeviceSettingsContribution' not found on
 * 'snapshot'".
 *
 * Fix: device-manager now uses `getProvider(capName)` — the active system
 * singleton (the wrapper, e.g. SnapshotAddon) — for all contribution method
 * calls. The native is never touched for these methods.
 *
 * Spec: docs/superpowers/plans/2026-05-21-addons-bulk-update-progress.md (Bug-3)
 */

import {
  CapabilityRegistry,
  DeviceManagerAddon,
  DeviceRegistry,
  SqliteSettingsBackend,
} from '@camstack/system'
import type {
  AddonContext,
  ConfigUISchemaWithValues,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
} from '@camstack/types'
import { snapshotCapability } from '@camstack/types'
import { makeRecordsAccessForOwner } from '../../../../packages/system/src/builtins/sqlite-storage/__tests__/support/records-world.js'
import { describe, expect, it, vi } from 'vitest'

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
  return {
    readAddonStore: vi.fn(async () => ({})),
    writeAddonStore: vi.fn(async () => {}),
    readDeviceStore: vi.fn(async () => ({})),
    writeDeviceStore: vi.fn(async () => {}),
  }
}

/**
 * Wrapper provider (SnapshotAddon equivalent): registered as a system
 * singleton via `registerProvider`. Implements ALL three contribution
 * methods plus the cap-specific operations (getSnapshot, invalidateCache).
 */
function makeSnapshotWrapperProvider() {
  return {
    // Cap-specific methods
    getSnapshot: vi.fn(async () => null),
    invalidateCache: vi.fn(async () => undefined),

    // Contribution methods — owned by the wrapper
    getDeviceSettingsContribution: vi.fn(
      async (_input: { deviceId: number }): Promise<ConfigUISchemaWithValues | null> => ({
        sections: [
          {
            id: 'snapshot-settings',
            title: 'Snapshot',
            tab: 'general',
            order: 99,
            fields: [
              {
                type: 'text' as const,
                key: 'preferredStreamId',
                label: 'Preferred Stream',
                default: '',
                value: '',
              },
            ],
          },
        ],
      }),
    ),
    getDeviceLiveContribution: vi.fn(
      async (_input: { deviceId: number }): Promise<ConfigUISchemaWithValues | null> => null,
    ),
    applyDeviceSettingsPatch: vi.fn(async () => ({ success: true as const })),
  }
}

/**
 * Native provider (Reolink/ONVIF/Hikvision equivalent): registered per-device
 * via `registerNativeProvider`. Implements ONLY the camera-specific operations
 * (getSnapshot, invalidateCache). Does NOT implement contribution methods.
 *
 * Calling any of the three contribution methods on this object simulates the
 * "method not found" scenario that was Bug-3.
 */
function makeSnapshotNativeProvider() {
  return {
    getSnapshot: vi.fn(async () => ({
      base64: 'abc123',
      contentType: 'image/jpeg',
    })),
    invalidateCache: vi.fn(async () => undefined),
    // Deliberately omit getDeviceSettingsContribution / getDeviceLiveContribution /
    // applyDeviceSettingsPatch — these don't exist on native providers.
  }
}

/**
 * `ctx.api.settingsStore` — the REAL engine on an in-memory database, wrapped
 * in the tRPC namespace shape the addon reaches for.
 *
 * The real engine rather than a hand-rolled table because the device row store
 * depends on column semantics the engine owns (`NOT NULL DEFAULT`, `BOOLEAN`
 * ↔ `0|1`, JSON columns parsed on read, `ON CONFLICT DO UPDATE SET` touching
 * only the columns a write names).
 *
 * Type boundary: this is narrower than the full `settingsStore` router — a new
 * dependency shows up as a missing-method crash here rather than as silence.
 */
async function makeSettingsStoreApi() {
  const backend = new SqliteSettingsBackend(':memory:')
  await backend.initialize()
  return {
    declareCollection: { mutate: (i: never) => backend.declareCollection(i) },
    get: { query: (i: never) => backend.get(i) },
    set: { mutate: (i: never) => backend.set(i) },
    query: { query: (i: never) => backend.query(i) },
    updateWhere: { mutate: (i: never) => backend.updateWhere(i) },
    delete: { mutate: (i: never) => backend.delete(i) },
    count: { query: (i: never) => backend.count(i) },
  }
}

// ── Scenario setup ────────────────────────────────────────────────────────────

async function setupBug3Scenario() {
  const addon = new DeviceManagerAddon()
  const settings = makeSettings()
  const deviceRegistry = new DeviceRegistry()
  const capabilityRegistry = new CapabilityRegistry(makeLogger())

  const wrapperProvider = makeSnapshotWrapperProvider()
  const nativeProvider = makeSnapshotNativeProvider()

  // Declare the snapshot capability (kind:'wrapper', defaultActive:true,
  // exposesDeviceSettings:true, mode:'singleton').
  capabilityRegistry.declareCapability(snapshotCapability)

  // Register the WRAPPER as the system singleton — this is what SnapshotAddon does.
  capabilityRegistry.registerProvider(snapshotCapability.name, 'snapshot-addon', wrapperProvider)

  // Register the default wrapper so auto-bind picks it up in getBindings step 2.
  capabilityRegistry.registerWrapper(snapshotCapability.name, 'snapshot-addon', {
    defaultActive: true,
  })

  // The device ledger lives in a `settings-store` collection, so the addon
  // refuses to serve a fleet it cannot persist.
  const settingsStore = await makeSettingsStoreApi()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore },
    id: 'device-manager',
    logger: makeLogger(),
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

  // Allocate and register the device.
  const { id: deviceId } = await provider.allocateDeviceId({
    addonId: 'reolink-addon',
    stableId: 'cam-reolink-1',
  })
  await provider.registerDevice({
    addonId: 'reolink-addon',
    stableId: 'cam-reolink-1',
    id: deviceId,
    type: 'camera',
    name: 'Reolink Camera',
    parentDeviceId: null,
    config: {},
  })

  // Register the NATIVE provider for the device — this is what a Reolink/ONVIF
  // driver does. The native does NOT implement contribution methods.
  capabilityRegistry.registerNativeProvider(
    snapshotCapability.name,
    deviceId,
    'reolink-addon',
    nativeProvider,
  )

  capabilityRegistry.ready()

  return { provider, wrapperProvider, nativeProvider, deviceId }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('device-manager contribution dispatch — Bug-3 regression (snapshot wrapper vs native)', () => {
  it('routes getDeviceSettingsContribution to the wrapper, never to the native', async () => {
    const { provider, wrapperProvider, nativeProvider, deviceId } = await setupBug3Scenario()

    // This MUST NOT throw "method not found on native" — the fix routes to the wrapper.
    const aggregate = await provider.getDeviceSettingsAggregate({ deviceId })

    expect(aggregate).not.toBeNull()
    // The wrapper's contribution section must be present.
    const snapshotSection = aggregate!.sections.find((s) => s.id === 'snapshot-settings')
    expect(snapshotSection).toBeDefined()
    expect(snapshotSection!.title).toBe('Snapshot')

    // Wrapper was called exactly once.
    expect(wrapperProvider.getDeviceSettingsContribution).toHaveBeenCalledTimes(1)
    expect(wrapperProvider.getDeviceSettingsContribution).toHaveBeenCalledWith({ deviceId })

    // Native was NOT called — it doesn't implement contribution methods.
    expect(nativeProvider.getSnapshot).not.toHaveBeenCalled()
  })

  it('routes getDeviceLiveContribution to the wrapper, never to the native', async () => {
    const { provider, wrapperProvider, nativeProvider, deviceId } = await setupBug3Scenario()

    // This MUST NOT throw "method not found on native".
    const liveAggregate = await provider.getDeviceLiveInfoAggregate({ deviceId })

    // The wrapper returns null for live contributions in our fake (acceptable).
    // Key assertion: the wrapper was invoked, and no error was thrown.
    expect(wrapperProvider.getDeviceLiveContribution).toHaveBeenCalledTimes(1)
    expect(wrapperProvider.getDeviceLiveContribution).toHaveBeenCalledWith({ deviceId })

    // Native was NOT called for live contributions.
    expect(nativeProvider.getSnapshot).not.toHaveBeenCalled()
    // liveAggregate may be null (wrapper returned null for live) — that's fine.
    // The important thing is no throw occurred.
    expect(() => liveAggregate).not.toThrow()
  })

  it('routes applyDeviceSettingsPatch to the wrapper, never to the native', async () => {
    const { provider, wrapperProvider, nativeProvider, deviceId } = await setupBug3Scenario()

    // First get the aggregate to confirm the contribution fields are tagged correctly.
    const aggregate = await provider.getDeviceSettingsAggregate({ deviceId })
    expect(aggregate).not.toBeNull()

    const field = aggregate!.sections
      .find((s) => s.id === 'snapshot-settings')
      ?.fields.find((f) => (f as Record<string, unknown>)['key'] === 'preferredStreamId') as
      | Record<string, unknown>
      | undefined

    expect(field).toBeDefined()
    expect(field!['writerCapName']).toBe('snapshot')

    // Now apply a settings patch — must go to the wrapper, NOT the native.
    await provider.updateDeviceField({
      deviceId,
      writerCapName: 'snapshot',
      writerAddonId: field!['writerAddonId'] as string,
      key: 'preferredStreamId',
      value: 'high',
    })

    // Wrapper's applyDeviceSettingsPatch was called with the correct patch.
    expect(wrapperProvider.applyDeviceSettingsPatch).toHaveBeenCalledWith({
      deviceId,
      patch: { preferredStreamId: 'high' },
    })

    // Native was NOT called for the settings write.
    expect(nativeProvider.getSnapshot).not.toHaveBeenCalled()
  })

  it('does not throw when both a native and a wrapper provider are registered for the same cap', async () => {
    // This is the exact Bug-3 scenario: native registered for device, wrapper
    // registered as system singleton. Before the fix, calling
    // getDeviceSettingsAggregate would throw because getProviderForDevice
    // returned the native which lacks contribution methods.
    const { provider, deviceId } = await setupBug3Scenario()

    // Must complete without throwing.
    await expect(provider.getDeviceSettingsAggregate({ deviceId })).resolves.not.toBeNull()

    await expect(provider.getDeviceLiveInfoAggregate({ deviceId })).resolves.toBeDefined()
  })
})
