/**
 * Tests for `DeviceManagerAddon.dispatchDeviceAction` (via the public
 * `runDeviceAction` cap method).
 *
 * Three cases:
 *   1. Hub-local device in the registry → calls `device.runDeviceAction`.
 *   2. No hub-local device, `device-ops` native provider present → calls `ops.runAction`.
 *   3. Neither present → throws.
 */

import { DeviceRegistry } from '@camstack/system'
import type {
  AddonContext,
  IDevice,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceManagerAddon } from '../device-manager.addon.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  return {
    emit: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    getRecent: vi.fn(() => []),
  } as unknown as IEventBus
}

function makeSettings() {
  const addonStore: Record<string, unknown> = {}
  const deviceStores: Record<number, Record<string, unknown>> = {}
  const runtimeStores: Record<number, Record<string, unknown>> = {}
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore: vi.fn(async (id: number) => ({ ...deviceStores[id] })),
    writeDeviceStore: vi.fn(async (id: number, data: Record<string, unknown>) => {
      deviceStores[id] = { ...data }
    }),
    clearDeviceStore: vi.fn(async (id: number) => {
      delete deviceStores[id]
    }),
    readDeviceRuntimeState: vi.fn(async (id: number) => ({ ...runtimeStores[id] })),
    writeDeviceRuntimeState: vi.fn(async (id: number, data: Record<string, unknown>) => {
      runtimeStores[id] = { ...data }
    }),
    clearDeviceRuntimeState: vi.fn(async (id: number) => {
      delete runtimeStores[id]
    }),
  }
}

let deviceIdSeq = 500

function makeFakeDevice(overrides: Partial<{ id: number }> = {}): IDevice {
  const id = overrides.id ?? deviceIdSeq++
  const config = {
    entries: () => [],
    get: vi.fn(),
    set: vi.fn(async () => {}),
    setAll: vi.fn(async () => {}),
    onChange: () => () => {},
    values: {},
  }
  return {
    id,
    stableId: `fake-${id}`,
    type: 'generic' as const,
    name: `Fake ${id}`,
    location: null,
    disabled: false,
    parentDeviceId: null,
    online: true,
    features: [],
    config,
    ctx: {} as unknown as IDevice['ctx'],
    removeDevice: vi.fn(async () => {}),
    markOnline: vi.fn(),
    getSettingsUISchema: vi.fn(() => ({ sections: [] })),
    applySettingsPatch: vi.fn(async () => {}),
    runDeviceAction: vi.fn(async (_action: string, _input: unknown) => 'hub-local-result'),
  } as unknown as IDevice
}

/**
 * Build the addon + provider under test.
 *
 * @param deviceRegistry  Hub device registry. Register devices BEFORE calling setup.
 * @param capabilityRegistry  Optional mock for the capability registry (for device-ops path).
 */
async function setup(
  deviceRegistry: DeviceRegistry | null,
  capabilityRegistry?: {
    getNativeProvider: ReturnType<typeof vi.fn>
    getDefinition?: ReturnType<typeof vi.fn>
    getSingleton?: ReturnType<typeof vi.fn>
    getProviderByAddon?: ReturnType<typeof vi.fn>
    getProviderForDevice?: ReturnType<typeof vi.fn>
    waitForProvider?: ReturnType<typeof vi.fn>
    listCapabilities?: ReturnType<typeof vi.fn>
    listNativeDeviceIds?: ReturnType<typeof vi.fn>
  },
): Promise<IDeviceManagerProvider> {
  const addon = new DeviceManagerAddon()
  const { api: settingsStoreApi } = await makeSettingsStoreApi()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: settingsStoreApi },
    id: 'device-manager',
    logger: makeLogger(),
    eventBus: makeEventBus(),
    addonConfig: {},
    dataDir: '/tmp',
    settings: makeSettings(),
    records,
    kernel: {
      deviceRegistry,
      // The addon installs the claimed-status overlay at init (D663, S3): every
      // registry handed to it must take one.
      ...(capabilityRegistry
        ? { capabilityRegistry: { setStatusOverlay: vi.fn(), ...capabilityRegistry } }
        : {}),
    },
  }

  const initResult = await addon.initialize(ctx as unknown as AddonContext)

  let providers: readonly ProviderRegistration[] | undefined
  if (Array.isArray(initResult)) providers = initResult
  else if (initResult) providers = initResult.providers

  const first = providers?.[0]
  if (!first) throw new Error('DeviceManagerAddon did not return provider registrations')
  return first.provider as IDeviceManagerProvider
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

describe('DeviceManagerAddon — runDeviceAction', () => {
  it('routes to hub-local device.runDeviceAction when device is in the registry', async () => {
    const registry = new DeviceRegistry()
    const device = makeFakeDevice()
    registry.register('test-addon', device)

    const provider = await setup(registry)

    const result = await provider.runDeviceAction({
      deviceId: device.id,
      action: 'reboot',
      input: { delay: 5 },
    })

    expect(device.runDeviceAction).toHaveBeenCalledWith('reboot', { delay: 5 })
    expect(result).toBe('hub-local-result')
  })

  it('routes through device-ops.runAction when device is not hub-local but native provider exists', async () => {
    const registry = new DeviceRegistry()
    // No device registered — simulates forked worker device
    const runActionMock = vi.fn(async () => 'cross-process-result')
    const fakeOps = { runAction: runActionMock }

    const capabilityRegistry = {
      getNativeProvider: vi.fn((_capName: string, _deviceId: number) => fakeOps),
    }

    const provider = await setup(registry, capabilityRegistry)

    const result = await provider.runDeviceAction({
      deviceId: 42,
      action: 'identify',
      input: null,
    })

    expect(capabilityRegistry.getNativeProvider).toHaveBeenCalledWith('device-ops', 42)
    expect(runActionMock).toHaveBeenCalledWith({ deviceId: 42, action: 'identify', input: null })
    expect(result).toBe('cross-process-result')
  })

  it('throws when neither hub-local device nor device-ops native provider is available', async () => {
    const registry = new DeviceRegistry()
    // No device registered, and getNativeProvider returns null
    const capabilityRegistry = {
      getNativeProvider: vi.fn(() => null),
    }

    const provider = await setup(registry, capabilityRegistry)

    await expect(
      provider.runDeviceAction({ deviceId: 99, action: 'ping', input: {} }),
    ).rejects.toThrow(/device "99" not found for runDeviceAction/)
  })
})
