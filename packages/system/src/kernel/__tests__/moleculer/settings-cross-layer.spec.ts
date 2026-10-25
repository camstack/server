/**
 * E2E tests for addon settings cross-layer communication.
 *
 * Tests that the three-level settings (addon/global/device) work across:
 * 1. Hub-local addon → direct method call
 * 2. Per-addon Moleculer service → settings.* actions
 * 3. Flat persistence cap → delegated to sub-services
 *
 * These tests verify the Sprint 5 + Sprint 6 architecture:
 * - addon-settings singleton capability (replaces $addonHost)
 * - Per-addon Moleculer settings.* actions (via createAddonService)
 * - Flat analysis-data-persistence methods (replaces nested sub-objects)
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { ServiceBroker } from 'moleculer'
import { createAddonService } from '../../moleculer/addon-service-factory.js'
import type { ICamstackAddon, AddonDeclaration, ConfigUISchemaWithValues } from '@camstack/types'

// ── Test addon factory ──────────────────────────────────────────────

function makeSettingsAddon(overrides?: Partial<ICamstackAddon>): ICamstackAddon {
  const store: Record<string, unknown> = { volume: 75, theme: 'dark' }
  const deviceStores = new Map<number, Record<string, unknown>>()

  return {
    manifest: { id: 'test-settings-addon', name: 'Test Settings' },
    initialize: vi.fn().mockResolvedValue(undefined),
    shutdown: vi.fn().mockResolvedValue(undefined),

    getGlobalSettings: vi.fn(
      async (): Promise<ConfigUISchemaWithValues> => ({
        sections: [
          {
            id: 'global',
            title: 'Global',
            fields: [
              { type: 'text', key: 'theme', label: 'Theme', value: store['theme'] },
              { type: 'number', key: 'volume', label: 'Volume', value: store['volume'] },
            ],
          },
        ],
      }),
    ),

    updateGlobalSettings: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(store, patch)
    }),

    getDeviceSettings: vi.fn(async (deviceId: number): Promise<ConfigUISchemaWithValues> => {
      const ds = deviceStores.get(deviceId) ?? {}
      return {
        sections: [
          {
            id: 'device',
            title: `Device ${deviceId}`,
            fields: [
              { type: 'boolean', key: 'enabled', label: 'Enabled', value: ds['enabled'] ?? true },
            ],
          },
        ],
      }
    }),

    updateDeviceSettings: vi.fn(async (deviceId: number, patch: Record<string, unknown>) => {
      const ds = deviceStores.get(deviceId) ?? {}
      Object.assign(ds, patch)
      deviceStores.set(deviceId, ds)
    }),

    ...overrides,
  } as unknown as ICamstackAddon
}

const settingsDeclaration: AddonDeclaration = {
  id: 'test-settings-addon',
  entry: './dist/index.js',
  capabilities: [{ name: 'detector' }],
}

// ── Tests ────────────────────────────────────────────────────────────

describe('Addon settings via Moleculer service', () => {
  let broker: ServiceBroker

  afterEach(async () => {
    if (broker) await broker.stop()
  })

  it('exposes settings.getGlobalSettings action (legacy "getAddonSettings" was collapsed into this pair)', async () => {
    const addon = makeSettingsAddon()
    const providers = new Map<string, unknown>([['detector', { detect: vi.fn() }]])

    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    const schema = createAddonService(addon, settingsDeclaration, { providers })
    broker.createService(schema)
    await broker.start()

    const result = await broker.call('test-settings-addon.settings.getGlobalSettings', {})
    expect(result).toBeDefined()
    expect((result as ConfigUISchemaWithValues).sections[0]?.id).toBe('global')
    expect(addon.getGlobalSettings).toHaveBeenCalled()
  })

  it('exposes settings.updateGlobalSettings action (legacy "updateAddonSettings" was collapsed into this pair)', async () => {
    const addon = makeSettingsAddon()
    const providers = new Map<string, unknown>([['detector', { detect: vi.fn() }]])

    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    broker.createService(createAddonService(addon, settingsDeclaration, { providers }))
    await broker.start()

    const result = await broker.call('test-settings-addon.settings.updateGlobalSettings', {
      patch: { volume: 50 },
    })
    expect(result).toEqual({ success: true })
    expect(addon.updateGlobalSettings).toHaveBeenCalledWith({ volume: 50 })
  })

  it('exposes settings.getDeviceSettings with deviceId', async () => {
    const addon = makeSettingsAddon()
    const providers = new Map<string, unknown>([['detector', { detect: vi.fn() }]])

    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    broker.createService(createAddonService(addon, settingsDeclaration, { providers }))
    await broker.start()

    const result = await broker.call('test-settings-addon.settings.getDeviceSettings', {
      deviceId: 1,
    })
    expect((result as ConfigUISchemaWithValues).sections[0]?.title).toBe('Device 1')
    expect(addon.getDeviceSettings).toHaveBeenCalledWith(1)
  })

  it('exposes settings.updateDeviceSettings with deviceId + patch', async () => {
    const addon = makeSettingsAddon()
    const providers = new Map<string, unknown>([['detector', { detect: vi.fn() }]])

    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    broker.createService(createAddonService(addon, settingsDeclaration, { providers }))
    await broker.start()

    const result = await broker.call('test-settings-addon.settings.updateDeviceSettings', {
      deviceId: 1,
      patch: { enabled: false },
    })
    expect(result).toEqual({ success: true })
    expect(addon.updateDeviceSettings).toHaveBeenCalledWith(1, { enabled: false })
  })

  it('skips settings actions for addon without settings methods', async () => {
    const addon: ICamstackAddon = {
      manifest: { id: 'minimal-addon', name: 'Minimal' },
      initialize: vi.fn().mockResolvedValue(undefined),
      shutdown: vi.fn().mockResolvedValue(undefined),
    } as unknown as ICamstackAddon

    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    const schema = createAddonService(
      addon,
      {
        id: 'minimal-addon',
        entry: './dist/index.js',
        capabilities: [],
      },
      { providers: new Map() },
    )
    broker.createService(schema)
    await broker.start()

    // No settings.* actions should exist
    const actionList = broker.registry.getActionList({})
    const settingsActions = actionList.filter((a: { name: string }) =>
      a.name.startsWith('minimal-addon.settings.'),
    )
    expect(settingsActions).toHaveLength(0)
  })

  it('settings.updateDeviceSettings throws when deviceId missing', async () => {
    const addon = makeSettingsAddon()
    const providers = new Map<string, unknown>([['detector', { detect: vi.fn() }]])

    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    broker.createService(createAddonService(addon, settingsDeclaration, { providers }))
    await broker.start()

    await expect(
      broker.call('test-settings-addon.settings.updateDeviceSettings', { patch: { x: 1 } }),
    ).rejects.toThrow('deviceId is required')
  })

  it('capability actions and settings actions coexist on same service', async () => {
    const detectFn = vi.fn().mockResolvedValue({ detections: ['cat'] })
    const addon = makeSettingsAddon()
    const providers = new Map<string, unknown>([['detector', { detect: detectFn }]])

    broker = new ServiceBroker({ nodeID: 'hub', transporter: 'Fake', logger: false })
    broker.createService(createAddonService(addon, settingsDeclaration, { providers }))
    await broker.start()

    // Capability action works
    const detectResult = await broker.call('test-settings-addon.detector.detect', { frame: 'x' })
    expect(detectResult).toEqual({ detections: ['cat'] })

    // Settings action works alongside
    const settingsResult = await broker.call('test-settings-addon.settings.getGlobalSettings', {})
    expect(settingsResult).toBeDefined()
    expect((settingsResult as ConfigUISchemaWithValues).sections).toHaveLength(1)
  })
})
