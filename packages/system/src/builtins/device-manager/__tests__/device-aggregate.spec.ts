/**
 * Integration test for the device-settings aggregator on DeviceManagerAddon.
 *
 * Scenario: one camera (`cam-1`) is registered with native bindings for
 * `motion-detection` (provider: `motion-wasm`) and `stream-broker` (provider:
 * `stream-broker`). Both caps have `exposesDeviceSettings: true`, so their
 * providers must implement the three contribution methods. The aggregator
 * enumerates bindings, collects contributions, and tags each editable
 * field with `writerCapName` + `writerAddonId` for round-trip mutations.
 */

import { CapabilityRegistry, DeviceRegistry } from '@camstack/system'
import type {
  AddonContext,
  ConfigUISchemaWithValues,
  IDeviceManagerProvider,
  IEventBus,
  IScopedLogger,
  ProviderRegistration,
} from '@camstack/types'
import {
  deviceExportCapability,
  motionDetectionCapability,
  streamBrokerCapability,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { makeRecordsAccessForOwner } from '../../sqlite-storage/__tests__/support/records-world.js'
import { DeviceManagerAddon, mergeAggregates } from '../device-manager.addon.js'
import { makeSettingsStoreApi } from './settings-store-api.js'

// ── Fakes ───────────────────────────────────────────────────────────────────

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
  const deviceStores: Record<number, Record<string, unknown>> = {}
  return {
    readAddonStore: vi.fn(async () => ({ ...addonStore })),
    writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
      Object.assign(addonStore, patch)
    }),
    readDeviceStore: vi.fn(
      async (deviceId: number): Promise<Record<string, unknown>> => ({
        ...deviceStores[deviceId],
      }),
    ),
    writeDeviceStore: vi.fn(async (deviceId: number, data: Record<string, unknown>) => {
      deviceStores[deviceId] = { ...data }
    }),
  }
}

// Motion-detection provider fake — motion-wasm contributes settings only.
function makeMotionProvider() {
  const stored: Record<number, Record<string, unknown>> = {}
  return {
    analyze: vi.fn(async () => ({
      detected: false,
      regionCount: 0,
      regions: [],
      rawRegions: [],
      frameWidth: 0,
      frameHeight: 0,
      analysisMs: 0,
    })),
    removeCamera: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),

    getDeviceSettingsContribution: vi.fn(
      async ({ deviceId }: { deviceId: number }): Promise<ConfigUISchemaWithValues | null> => ({
        sections: [
          {
            id: 'motion-tuning',
            title: 'Motion Tuning',
            tab: 'motion',
            order: 5,
            fields: [
              {
                type: 'number' as const,
                key: 'threshold',
                label: 'Threshold',
                default: 20,
                value: stored[deviceId]?.['threshold'] ?? 20,
              },
              {
                type: 'number' as const,
                key: 'minArea',
                label: 'Min Area',
                default: 500,
                value: stored[deviceId]?.['minArea'] ?? 500,
              },
            ],
          },
        ],
      }),
    ),
    getDeviceLiveContribution: vi.fn(
      async (_input: { deviceId: number }): Promise<ConfigUISchemaWithValues | null> => null,
    ),
    applyDeviceSettingsPatch: vi.fn(
      async ({ deviceId, patch }: { deviceId: number; patch: Record<string, unknown> }) => {
        stored[deviceId] = { ...stored[deviceId], ...patch }
        return { success: true as const }
      },
    ),
    __stored: stored,
  }
}

// Stream-broker provider fake — contributes settings + live info, scoped
// to devices it has "registered".
function makeBrokerProvider(registered: Set<number>) {
  return {
    createBroker: vi.fn(),
    getBrokerStats: vi.fn(),
    listBrokers: vi.fn(),
    destroyBroker: vi.fn(),
    destroyBrokersForDevice: vi.fn(),
    restartBroker: vi.fn(),
    registerDeviceStreams: vi.fn(),
    unregisterDeviceStreams: vi.fn(),
    getRegisteredDevice: vi.fn(),
    listRegisteredDevices: vi.fn(),
    getStreamUrl: vi.fn(),
    getBroker: vi.fn(),
    grabFrame: vi.fn(),
    setPreBufferDuration: vi.fn(),
    getPreBufferInfo: vi.fn(),
    getRtspPort: vi.fn(),
    getAllRtspEntries: vi.fn(),
    getRtspEntry: vi.fn(),
    regenerateRtspToken: vi.fn(),
    setRtspEnabled: vi.fn(),
    isRtspEnabled: vi.fn(),

    getDeviceSettingsContribution: vi.fn(
      async ({ deviceId }: { deviceId: number }): Promise<ConfigUISchemaWithValues | null> => {
        if (!registered.has(deviceId)) return null
        return {
          sections: [
            {
              id: 'stream-broker-settings',
              title: 'RTSP Restream',
              tab: 'streaming',
              order: 10,
              fields: [
                {
                  type: 'boolean' as const,
                  key: 'rtspEnabled:main',
                  label: 'Main',
                  default: true,
                  value: true,
                },
              ],
            },
          ],
        }
      },
    ),
    getDeviceLiveContribution: vi.fn(
      async ({ deviceId }: { deviceId: number }): Promise<ConfigUISchemaWithValues | null> => {
        if (!registered.has(deviceId)) return null
        return {
          sections: [
            {
              id: 'stream-broker-live',
              title: 'Stream URLs',
              tab: 'streaming',
              order: 20,
              fields: [
                {
                  type: 'text' as const,
                  key: 'rtspUrl:main',
                  label: 'Main URL',
                  readonlyField: true,
                  value: 'rtsp://host:8554/cam-1/main',
                },
              ],
            },
          ],
        }
      },
    ),
    applyDeviceSettingsPatch: vi.fn(async () => ({ success: true as const })),
  }
}

// ── Setup ───────────────────────────────────────────────────────────────────

async function setupScenario() {
  const addon = new DeviceManagerAddon()
  const settings = makeSettings()
  const deviceRegistry = new DeviceRegistry()
  const capabilityRegistry = new CapabilityRegistry(makeLogger())

  const motionProvider = makeMotionProvider()
  const brokerRegistered = new Set<number>()
  const brokerProvider = makeBrokerProvider(brokerRegistered)

  // Declare caps + register providers
  capabilityRegistry.declareCapability(motionDetectionCapability)
  capabilityRegistry.declareCapability(streamBrokerCapability)
  capabilityRegistry.registerProvider(motionDetectionCapability.name, 'motion-wasm', motionProvider)
  capabilityRegistry.registerProvider(streamBrokerCapability.name, 'stream-broker', brokerProvider)

  const { api: settingsStoreApi } = await makeSettingsStoreApi()
  const logger = makeLogger()
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

  // Allocate a numeric id for 'cam-1' so the aggregator endpoints can
  // translate numeric → stableId via persisted meta. Mirrors the real
  // flow (`allocateDeviceId` precedes `registerDevice`).
  const { id: deviceId } = await provider.allocateDeviceId({
    addonId: 'motion-wasm',
    stableId: 'cam-1',
  })
  await provider.registerDevice({
    addonId: 'motion-wasm',
    stableId: 'cam-1',
    id: deviceId,
    type: 'camera',
    name: 'cam-1',
    parentDeviceId: null,
    config: {},
  })

  // Native cap registration now that the numeric id is known.
  capabilityRegistry.registerNativeProvider(
    motionDetectionCapability.name,
    deviceId,
    'motion-wasm',
    motionProvider,
  )
  capabilityRegistry.registerNativeProvider(
    streamBrokerCapability.name,
    deviceId,
    'stream-broker',
    brokerProvider,
  )
  capabilityRegistry.ready()
  brokerRegistered.add(deviceId)

  return {
    provider,
    motionProvider,
    brokerProvider,
    brokerRegistered,
    deviceId,
    capabilityRegistry,
    settings,
    logger,
  }
}

// Boot a DeviceManagerAddon against a pre-populated registry and return its
// IDeviceManagerProvider. Mirrors the init dance in `setupScenario` /
// the D12 test so per-scenario tests don't repeat it.
async function initDeviceManager(
  capabilityRegistry: CapabilityRegistry,
  deviceRegistry: DeviceRegistry,
) {
  const addon = new DeviceManagerAddon()
  const settings = makeSettings()
  const { api: settingsStoreApi } = await makeSettingsStoreApi()
  const records = await makeRecordsAccessForOwner('device-manager')
  const ctx = {
    api: { settingsStore: settingsStoreApi },
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
  return providers[0]!.provider as IDeviceManagerProvider
}

// device-export provider fake — a system COLLECTION cap that gates its
// per-device contribution by the set of devices it has "exposed".
function makeExportProvider(exposed: Set<number>) {
  return {
    exposeDevice: vi.fn(),
    unexposeDevice: vi.fn(),
    getStatus: vi.fn(async () => ({})),
    getDeviceSettingsContribution: vi.fn(
      async ({ deviceId }: { deviceId: number }): Promise<ConfigUISchemaWithValues | null> => {
        if (!exposed.has(deviceId)) return null
        return {
          sections: [
            {
              id: 'device-export-hap',
              title: 'HomeKit Export',
              tab: 'export',
              order: 30,
              fields: [
                {
                  type: 'boolean' as const,
                  key: 'export:hap',
                  label: 'Expose to HomeKit',
                  default: false,
                  value: true,
                },
              ],
            },
          ],
        }
      },
    ),
    getDeviceLiveContribution: vi.fn(
      async (_input: { deviceId: number }): Promise<ConfigUISchemaWithValues | null> => null,
    ),
    applyDeviceSettingsPatch: vi.fn(async () => ({ success: true as const })),
  }
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('DeviceManagerAddon — device-settings aggregator', () => {
  it('merges motion + stream-broker settings contributions with writer tags', async () => {
    const { provider, deviceId } = await setupScenario()

    const aggregate = await provider.getDeviceSettingsAggregate({ deviceId })
    expect(aggregate).not.toBeNull()
    expect(aggregate!.sections.map((s) => s.id)).toEqual([
      'motion-tuning',
      'stream-broker-settings',
    ])

    // Every editable field carries writerCapName + writerAddonId
    const motionField = aggregate!.sections
      .find((s) => s.id === 'motion-tuning')!
      .fields.find((f) => (f as { key?: string }).key === 'threshold') as Record<string, unknown>
    expect(motionField['writerCapName']).toBe('motion-detection')
    expect(motionField['writerAddonId']).toBe('motion-wasm')
    expect(motionField['source']).toBe('settings')
    expect(motionField['readonlyField']).toBeUndefined()

    const brokerField = aggregate!.sections
      .find((s) => s.id === 'stream-broker-settings')!
      .fields.find((f) => (f as { key?: string }).key === 'rtspEnabled:main') as Record<
      string,
      unknown
    >
    expect(brokerField['writerCapName']).toBe('stream-broker')
    expect(brokerField['writerAddonId']).toBe('stream-broker')
  })

  it('live aggregate marks every field readonly regardless of contributor intent', async () => {
    const { provider, deviceId } = await setupScenario()

    const live = await provider.getDeviceLiveInfoAggregate({ deviceId })
    expect(live).not.toBeNull()
    expect(live!.sections).toHaveLength(1)
    const urlField = live!.sections[0]!.fields[0] as Record<string, unknown>
    expect(urlField['readonlyField']).toBe(true)
    expect(urlField['source']).toBe('live')
    expect(urlField['writerCapName']).toBeUndefined()
    expect(urlField['writerAddonId']).toBeUndefined()
  })

  it('a save of the retired linked-devices section is REFUSED by name, never dropped (D655)', async () => {
    const { provider, deviceId, settings, logger } = await setupScenario()
    const before = await settings.readDeviceStore(deviceId)

    // A device page opened before the upgrade still offers the old section.
    await expect(
      provider.updateDeviceField({
        deviceId,
        writerCapName: 'device-manager',
        writerAddonId: 'device-manager',
        key: '_linkedDeviceIds',
        value: ['12'],
      }),
    ).rejects.toThrow(/_linkedDeviceIds can no longer be saved/)

    const batch = await provider.updateDeviceFieldsBatch({
      deviceId,
      changes: [
        {
          writerCapName: 'device-manager',
          writerAddonId: 'device-manager',
          key: '_linkedDeviceTrackedIds',
          value: [],
        },
        {
          writerCapName: 'device-manager',
          writerAddonId: 'device-manager',
          key: '_linkedDevicesMode',
          value: 'manual',
        },
      ],
    })
    expect(batch.failures).toHaveLength(1)
    expect(batch.failures[0]?.error).toMatch(/_linkedDeviceTrackedIds, _linkedDevicesMode/)
    expect(await settings.readDeviceStore(deviceId)).toEqual(before)
    expect(logger.warn).toHaveBeenCalledWith(
      'device-manager: a save of the retired linked-devices section refused',
      expect.objectContaining({ tags: { deviceId } }),
    )
  })

  it('updateDeviceField routes the patch to the provider identified by (capName, addonId)', async () => {
    const { provider, deviceId, motionProvider, brokerProvider } = await setupScenario()

    await provider.updateDeviceField({
      deviceId,
      writerCapName: 'motion-detection',
      writerAddonId: 'motion-wasm',
      key: 'threshold',
      value: 42,
    })

    expect(motionProvider.applyDeviceSettingsPatch).toHaveBeenCalledWith({
      deviceId,
      patch: { threshold: 42 },
    })
    expect(brokerProvider.applyDeviceSettingsPatch).not.toHaveBeenCalled()

    // Round-trip: next getDeviceSettingsAggregate sees the new value
    const aggregate = await provider.getDeviceSettingsAggregate({ deviceId })
    const threshold = aggregate!.sections
      .find((s) => s.id === 'motion-tuning')!
      .fields.find((f) => (f as { key?: string }).key === 'threshold') as Record<string, unknown>
    expect(threshold['value']).toBe(42)
  })

  // The operator's report: "I change the detection source, the field snaps back
  // to the old value, and I have to change it a second time." The write landed;
  // the read-back overran the 1.5 s page budget (a loaded hub, a battery
  // camera) and the contribution cache answered with its LAST answer — the
  // value the write had just replaced. The panel must show the new value or
  // wait for it, never the pre-write one.
  it('a read-back right after a write never shows the pre-write value, even when the provider is slow', async () => {
    const { provider, deviceId, motionProvider } = await setupScenario()
    const thresholdOf = (a: Awaited<ReturnType<typeof provider.getDeviceSettingsAggregate>>) =>
      (
        a!.sections
          .find((s) => s.id === 'motion-tuning')
          ?.fields.find((f) => (f as { key?: string }).key === 'threshold') as
          | Record<string, unknown>
          | undefined
      )?.['value']

    // Prime the cache with the pre-write answer.
    expect(thresholdOf(await provider.getDeviceSettingsAggregate({ deviceId }))).toBe(20)

    // From now on the provider needs longer than the page budget to answer.
    const fast = motionProvider.getDeviceSettingsContribution.getMockImplementation()!
    motionProvider.getDeviceSettingsContribution.mockImplementation(async (input) => {
      const answer = await fast(input)
      await new Promise((resolve) => setTimeout(resolve, 1_800))
      return answer
    })

    await provider.updateDeviceFieldsBatch({
      deviceId,
      changes: [
        {
          writerCapName: 'motion-detection',
          writerAddonId: 'motion-wasm',
          key: 'threshold',
          value: 42,
        },
      ],
    })

    const after = await provider.getDeviceSettingsAggregate({ deviceId })
    expect(thresholdOf(after)).not.toBe(20)
    expect(thresholdOf(after)).toBe(42)
  }, 15_000)

  it('skips providers that return null (device not known to them)', async () => {
    // Simulate the broker "forgetting" the device — its contribution methods
    // return null, so the aggregator drops that section and keeps the rest.
    const { provider, deviceId, brokerRegistered } = await setupScenario()
    brokerRegistered.clear()

    const aggregate = await provider.getDeviceSettingsAggregate({ deviceId })
    expect(aggregate).not.toBeNull()
    expect(aggregate!.sections.map((s) => s.id)).toEqual(['motion-tuning'])
  })

  it('updateDeviceFieldsBatch groups changes per-provider and reports per-group failures', async () => {
    const { provider, deviceId, motionProvider, brokerProvider } = await setupScenario()

    // Force the broker group to fail so we can assert `failures[]` carries it.
    brokerProvider.applyDeviceSettingsPatch.mockRejectedValueOnce(new Error('boom'))

    const result = await provider.updateDeviceFieldsBatch({
      deviceId,
      changes: [
        {
          writerCapName: 'motion-detection',
          writerAddonId: 'motion-wasm',
          key: 'threshold',
          value: 10,
        },
        {
          writerCapName: 'motion-detection',
          writerAddonId: 'motion-wasm',
          key: 'minArea',
          value: 200,
        },
        {
          writerCapName: 'stream-broker',
          writerAddonId: 'stream-broker',
          key: 'rtspEnabled:main',
          value: false,
        },
      ],
    })

    // Motion gets ONE call with the merged patch
    expect(motionProvider.applyDeviceSettingsPatch).toHaveBeenCalledTimes(1)
    expect(motionProvider.applyDeviceSettingsPatch).toHaveBeenCalledWith({
      deviceId,
      patch: { threshold: 10, minArea: 200 },
    })

    // Broker group failed → reported in failures[]
    expect(result.success).toBe(true)
    expect(result.failures).toEqual([
      { writerCapName: 'stream-broker', writerAddonId: 'stream-broker', error: 'boom' },
    ])
  })

  it('updateDeviceField refuses unknown cap or provider', async () => {
    const { provider, deviceId, motionProvider } = await setupScenario()

    // (1) A cap not registered at all → rejected because it does not expose device settings.
    await expect(
      provider.updateDeviceField({
        deviceId,
        writerCapName: 'non-existent',
        writerAddonId: 'x',
        key: 'foo',
        value: 1,
      }),
    ).rejects.toThrow(/does not expose device settings/)

    // (2) Binding-driven model: writerAddonId is informational only — resolution
    // uses the provider bound to the device for that cap (or the global singleton).
    // Passing a stale / mismatched addonId on a cap that HAS a bound native provider
    // still succeeds; the bound provider (motion-wasm) receives the patch.
    await provider.updateDeviceField({
      deviceId,
      writerCapName: 'motion-detection',
      writerAddonId: 'no-such-addon',
      key: 'threshold',
      value: 99,
    })
    expect(motionProvider.applyDeviceSettingsPatch).toHaveBeenCalledWith({
      deviceId,
      patch: { threshold: 99 },
    })
  })

  it('D12: a provider is never invoked for a device it does not own', async () => {
    // Two cameras, each owned by a different vendor addon, both registered as
    // system providers for the SAME cap name (`motion-detection`). No native
    // binding is registered for either device in this scenario — the cap is
    // purely system-scoped so the system pass in `getDeviceAggregate` handles
    // it. The aggregator must only call the provider bound to the device being
    // aggregated; the other vendor's provider must never be invoked.
    //
    // This test FAILS today because the system pass iterates ALL providers for
    // every cap with `exposesDeviceSettings: true` (via `registry.listCapabilities()`)
    // and calls `getDeviceSettingsContribution` on EVERY registered provider —
    // including `other-vendor`'s provider for a device it does not own.

    const addon = new DeviceManagerAddon()
    const settings = makeSettings()
    const deviceRegistry = new DeviceRegistry()
    const capabilityRegistry = new CapabilityRegistry(makeLogger())

    // Provider for cam-1 (motion-wasm) and cam-2 (other-vendor).
    // Both implement the same cap surface — simulating reolink vs hikvision
    // sharing a cap name.
    const cam1Provider = makeMotionProvider()
    const cam2Provider = makeMotionProvider()

    // Declare `motion-detection` and register TWO system providers for it.
    // No native bindings — the system pass is the only aggregation path here.
    capabilityRegistry.declareCapability(motionDetectionCapability)
    capabilityRegistry.registerProvider(motionDetectionCapability.name, 'motion-wasm', cam1Provider)
    capabilityRegistry.registerProvider(
      motionDetectionCapability.name,
      'other-vendor',
      cam2Provider,
    )
    capabilityRegistry.ready()

    const { api: settingsStoreApi } = await makeSettingsStoreApi()
    const records = await makeRecordsAccessForOwner('device-manager')
    const ctx = {
      api: { settingsStore: settingsStoreApi },
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

    // Allocate and register cam-1 (owned by motion-wasm).
    const { id: deviceId } = await provider.allocateDeviceId({
      addonId: 'motion-wasm',
      stableId: 'cam-1',
    })
    await provider.registerDevice({
      addonId: 'motion-wasm',
      stableId: 'cam-1',
      id: deviceId,
      type: 'camera',
      name: 'cam-1',
      parentDeviceId: null,
      config: {},
    })
    // Allocate and register cam-2 (owned by other-vendor).
    const { id: otherId } = await provider.allocateDeviceId({
      addonId: 'other-vendor',
      stableId: 'cam-2',
    })
    await provider.registerDevice({
      addonId: 'other-vendor',
      stableId: 'cam-2',
      id: otherId,
      type: 'camera',
      name: 'cam-2',
      parentDeviceId: null,
      config: {},
    })

    // No native registration — both caps are system providers only.
    // When aggregating cam-1, the system pass runs for `motion-detection`
    // and today fans out to ALL providers: `motion-wasm` AND `other-vendor`.

    // Aggregating cam-1 must NOT touch cam-2's provider (`other-vendor`).
    await provider.getDeviceSettingsAggregate({ deviceId })
    expect(cam2Provider.getDeviceSettingsContribution).not.toHaveBeenCalled()
  })

  it('surfaces a system SINGLETON exposesDeviceSettings cap (stream-broker) that is never bound per-device', async () => {
    // Production shape: `stream-broker` is a system SINGLETON cap registered via
    // `registerProvider` ONLY — it is not a BaseDevice, so it is NEVER registered
    // as a per-device native cap and therefore never appears in
    // `getBindings(deviceId)`. It nonetheless holds per-device state (the cameras
    // whose streams it serves) and gates its contribution by deviceId. The
    // aggregator must still surface its device-settings section.
    //
    // This is the gap behind the missing stream-broker device-settings tab:
    // the prior `device-aggregate` tests only passed because they ALSO registered
    // stream-broker as a per-device native provider — masking the real bug.
    const deviceRegistry = new DeviceRegistry()
    const capabilityRegistry = new CapabilityRegistry(makeLogger())
    const brokerRegistered = new Set<number>()
    const brokerProvider = makeBrokerProvider(brokerRegistered)

    // System singleton registration ONLY — no registerNativeProvider.
    capabilityRegistry.declareCapability(streamBrokerCapability)
    capabilityRegistry.registerProvider(
      streamBrokerCapability.name,
      'stream-broker',
      brokerProvider,
    )
    capabilityRegistry.ready()

    const provider = await initDeviceManager(capabilityRegistry, deviceRegistry)
    const { id: deviceId } = await provider.allocateDeviceId({
      addonId: 'reolink',
      stableId: 'cam-1',
    })
    await provider.registerDevice({
      addonId: 'reolink',
      stableId: 'cam-1',
      id: deviceId,
      type: 'camera',
      name: 'cam-1',
      parentDeviceId: null,
      config: {},
    })
    brokerRegistered.add(deviceId)

    const aggregate = await provider.getDeviceSettingsAggregate({ deviceId })
    expect(aggregate).not.toBeNull()
    expect(aggregate!.sections.map((s) => s.id)).toContain('stream-broker-settings')

    // Editable fields carry writer tags so updateDeviceField routes the mutation
    // back to the broker provider.
    const brokerField = aggregate!.sections
      .find((s) => s.id === 'stream-broker-settings')!
      .fields.find((f) => (f as { key?: string }).key === 'rtspEnabled:main') as Record<
      string,
      unknown
    >
    expect(brokerField['writerCapName']).toBe('stream-broker')
    expect(brokerField['writerAddonId']).toBe('stream-broker')
  })

  it('surfaces the system singleton cap in the LIVE aggregate too (stream URLs)', async () => {
    const deviceRegistry = new DeviceRegistry()
    const capabilityRegistry = new CapabilityRegistry(makeLogger())
    const brokerRegistered = new Set<number>()
    const brokerProvider = makeBrokerProvider(brokerRegistered)

    capabilityRegistry.declareCapability(streamBrokerCapability)
    capabilityRegistry.registerProvider(
      streamBrokerCapability.name,
      'stream-broker',
      brokerProvider,
    )
    capabilityRegistry.ready()

    const provider = await initDeviceManager(capabilityRegistry, deviceRegistry)
    const { id: deviceId } = await provider.allocateDeviceId({
      addonId: 'reolink',
      stableId: 'cam-1',
    })
    await provider.registerDevice({
      addonId: 'reolink',
      stableId: 'cam-1',
      id: deviceId,
      type: 'camera',
      name: 'cam-1',
      parentDeviceId: null,
      config: {},
    })
    brokerRegistered.add(deviceId)

    const live = await provider.getDeviceLiveInfoAggregate({ deviceId })
    expect(live).not.toBeNull()
    expect(live!.sections.map((s) => s.id)).toContain('stream-broker-live')
  })

  it('still surfaces a system COLLECTION exposesDeviceSettings cap (device-export) — regression guard for the exporter exception', async () => {
    // device-export is a system COLLECTION cap that is also non-bound per-device.
    // The unified `collectSystemDeviceContributions` pass must surface it just as
    // the old dedicated exporter pass did; this pins that behavior against regression.
    const deviceRegistry = new DeviceRegistry()
    const capabilityRegistry = new CapabilityRegistry(makeLogger())
    const exposed = new Set<number>()
    const exportProvider = makeExportProvider(exposed)

    capabilityRegistry.declareCapability(deviceExportCapability)
    capabilityRegistry.registerProvider(deviceExportCapability.name, 'export-hap', exportProvider)
    capabilityRegistry.ready()

    const provider = await initDeviceManager(capabilityRegistry, deviceRegistry)
    const { id: deviceId } = await provider.allocateDeviceId({
      addonId: 'reolink',
      stableId: 'cam-1',
    })
    await provider.registerDevice({
      addonId: 'reolink',
      stableId: 'cam-1',
      id: deviceId,
      type: 'camera',
      name: 'cam-1',
      parentDeviceId: null,
      config: {},
    })
    exposed.add(deviceId)

    const aggregate = await provider.getDeviceSettingsAggregate({ deviceId })
    expect(aggregate).not.toBeNull()
    expect(aggregate!.sections.map((s) => s.id)).toContain('device-export-hap')
  })
})

describe('mergeAggregates — section-id dedup', () => {
  const sec = (id: string, tab: string, writer: string) => ({
    id,
    title: id,
    tab,
    order: 10,
    fields: [{ key: 'pipelineNodeId', type: 'select', writerCapName: writer }],
  })

  it('keeps the FIRST occurrence of a duplicated section id and drops later ones', () => {
    // Mirrors the orchestrator bug: the same contribution arrives via the
    // binding pass (camera-pipeline-config) and the system pass
    // (pipeline-orchestrator). Binding-driven part comes first in `parts`.
    const out = mergeAggregates([
      { sections: [sec('cluster-assignment', 'pipeline', 'camera-pipeline-config')] },
      { sections: [sec('cluster-assignment', 'pipeline', 'pipeline-orchestrator')] },
    ])
    const clusters = out.sections.filter((s) => s.id === 'cluster-assignment')
    expect(clusters).toHaveLength(1)
    // First-wins → the device-bound (camera-pipeline-config) writer is kept.
    expect((clusters[0]!.fields[0] as { writerCapName: string }).writerCapName).toBe(
      'camera-pipeline-config',
    )
  })

  it('preserves distinct section ids across parts', () => {
    const out = mergeAggregates([
      { sections: [sec('a', 'pipeline', 'x'), sec('b', 'motion', 'x')] },
      { sections: [sec('c', 'zones', 'y'), sec('a', 'pipeline', 'z')] }, // 'a' duplicate
    ])
    expect(out.sections.map((s) => s.id).toSorted()).toEqual(['a', 'b', 'c'])
  })
})
