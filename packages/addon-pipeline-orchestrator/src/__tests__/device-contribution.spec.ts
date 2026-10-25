/**
 * Unit tests for pipeline-orchestrator device-settings contribution.
 *
 * The orchestrator contributes BOTH settings (pipeline routing) and live
 * info (current assignment + runner). This test drives the three methods
 * directly on the addon — the addon is `this`-registered as the cap
 * provider, so its methods satisfy the `DeviceSettingsContribution`
 * interface added by `exposesDeviceSettings: true`.
 */
import {
  type AddonContext,
  EventCategory,
  type IEventBus,
  type IScopedLogger,
} from '@camstack/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DeviceConfigContributions } from '../device-config-contributions.js'
import PipelineOrchestratorAddon from '../index.js'
import { NodeTopologyService } from '../node-topology.js'
import { PipelineSettingsStore } from '../pipeline-settings-store.js'
import { PlacementLedger } from '../placement-ledger.js'

function makeCtx(emit?: ReturnType<typeof vi.fn>) {
  const store: Record<number, Record<string, unknown>> = {}
  const addonStore: Record<string, unknown> = {}
  return {
    ctx: {
      id: 'pipeline-orchestrator',
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
        child: vi.fn(function (this: unknown) {
          return this
        }),
        withTags: vi.fn(function (this: unknown) {
          return this
        }),
      },
      eventBus: { emit: emit ?? vi.fn(), subscribe: () => () => {}, getRecent: () => [] },
      settings: {
        readAddonStore: vi.fn(async () => ({ ...addonStore })),
        writeAddonStore: vi.fn(async (patch: Record<string, unknown>) => {
          Object.assign(addonStore, patch)
        }),
        readDeviceStore: vi.fn(async (deviceId: number) => ({ ...store[deviceId] })),
        writeDeviceStore: vi.fn(async (deviceId: number, patch: Record<string, unknown>) => {
          store[deviceId] = { ...store[deviceId], ...patch }
        }),
      },
    },
    store,
    addonStore,
  }
}

function makeAddon() {
  const addon = new PipelineOrchestratorAddon()
  const emit = vi.fn()
  const { ctx, store } = makeCtx(emit)
  Object.defineProperty(addon, 'ctx', { value: ctx, configurable: true })
  // This harness deliberately skips the full `initialize()` lifecycle (drives
  // the contribution methods directly against a bare ctx injection), so the
  // controllers `onInitialize` normally constructs (S6: `placement-ledger.ts`
  // / `node-topology.ts`; S11 Task 1: `device-config-contributions.ts`)
  // never get built. Construct them here the same way `onInitialize` does —
  // mirrors the pre-S6 behavior where `assignments` / `knownRunnerNodes`
  // were plain field initializers, always present regardless of init state.
  const internals = addon as unknown as {
    ledger: PlacementLedger | null
    topology: NodeTopologyService | null
    settingsStore: PipelineSettingsStore | null
    deviceConfig: DeviceConfigContributions | null
    deviceSettingsSchema: () => ReturnType<PipelineOrchestratorAddon['deviceSettingsSchema']>
    deviceHasOnboardMotionCap: (deviceId: number) => Promise<boolean>
    deviceHasActivitySignalCap?: (deviceId: number) => Promise<boolean>
    deviceHasNativeObjectDetectionCap: (deviceId: number) => Promise<boolean>
    emitCameraUpdated: PipelineOrchestratorAddon['emitCameraUpdated']
  }
  const eventBus = ctx.eventBus as unknown as IEventBus
  const logger = ctx.logger as unknown as IScopedLogger
  internals.ledger = new PlacementLedger({ eventBus, logger })
  internals.topology = new NodeTopologyService({
    readAgentSettingsMap: async () => ({}),
    eventBus,
    logger,
    localNodeId: () => 'hub',
    addonId: () => ctx.id,
  })
  // A real (but unexercised) settings store keeps the addon's internals
  // honest without a `state`/`acquireCapability` fake ctx wire-up.
  internals.settingsStore = new PipelineSettingsStore({
    state: () => {
      throw new Error('state not used in this harness')
    },
    api: () => null,
    acquireCapability: () =>
      Promise.reject(new Error('acquireCapability not used in this harness')),
    getAssignmentNode: () => null,
    hasPackageZone: async () => false,
    logger,
  })
  internals.deviceConfig = new DeviceConfigContributions({
    ctx: () => ctx as unknown as AddonContext,
    topology: internals.topology,
    getAssignment: (deviceId) => internals.ledger!.getAssignment(deviceId),
    deviceSettingsSchema: () => internals.deviceSettingsSchema(),
    deviceHasOnboardMotionCap: (deviceId) => internals.deviceHasOnboardMotionCap(deviceId),
    deviceHasActivitySignalCap: (deviceId) =>
      internals.deviceHasActivitySignalCap?.(deviceId) ?? Promise.resolve(false),
    deviceHasNativeObjectDetectionCap: (deviceId) =>
      internals.deviceHasNativeObjectDetectionCap(deviceId),
    // None of this file's tests call `updateGlobalSettings` — these five
    // are unreachable here and only satisfy the deps type.
    baseUpdateGlobalSettings: () => {
      throw new Error('baseUpdateGlobalSettings not used in this harness')
    },
    resolveGlobalStore: () => {
      throw new Error('resolveGlobalStore not used in this harness')
    },
    setGlobalSettings: () => {
      throw new Error('setGlobalSettings not used in this harness')
    },
    applyRuntimeSettings: () => {
      throw new Error('applyRuntimeSettings not used in this harness')
    },
    redispatchAllActiveCameras: () => {
      throw new Error('redispatchAllActiveCameras not used in this harness')
    },
    clearOnSettingsChange: () => {
      throw new Error('clearOnSettingsChange not used in this harness')
    },
  })
  return { addon, store, emit, ctx }
}

describe('PipelineOrchestratorAddon — device-settings contribution', () => {
  const CAM_ID = 1
  const UNKNOWN_ID = 999

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('settings contribution splits across the per-feature tabs', async () => {
    const { addon } = makeAddon()
    const contribution = await addon.getDeviceSettingsContribution({ deviceId: CAM_ID })
    expect(contribution).not.toBeNull()
    // The orchestrator used to dump everything under a legacy catch-all
    // `detection` tab; it now splits sections across motion /
    // detection-pipeline / zones — every tab must be one of those (no
    // stray `detection` or empty tab left over from the old layout).
    // Object Detection, Audio classification, Occupancy, and Cluster
    // Assignment all land on `detection-pipeline` as top-tab sections.
    const allowed = new Set(['motion', 'object-detection', 'audio', 'detection-pipeline', 'zones'])
    for (const section of contribution!.sections) {
      expect(allowed.has(section.tab ?? '')).toBe(true)
    }
  })

  it('only the MOTION source reads "Camera sensors" (D672); the root-detector pick is not a contributed field', async () => {
    const { addon } = makeAddon()
    const internals = addon as unknown as {
      deviceHasNativeObjectDetectionCap: (deviceId: number) => Promise<boolean>
    }
    internals.deviceHasNativeObjectDetectionCap = async () => true
    const contribution = await addon.getDeviceSettingsContribution({ deviceId: CAM_ID })
    const fields = contribution!.sections.flatMap((s) => s.fields)
    const motionSources = fields.find((f) => f.key === 'motionSources')
    const options = motionSources && 'options' in motionSources ? (motionSources.options ?? []) : []
    expect(options.find((o) => o.value === 'onboard')?.label).toBe('Camera sensors')
    // One authority, one control (D62): `detectionSources` is the first control
    // of the Steps editor, so NO contributed section may carry it any more —
    // not the old hand-written section, not the cap's Motion field.
    expect(fields.filter((f) => f.key === 'detectionSources')).toEqual([])
    expect(contribution!.sections.map((s) => s.id)).not.toContain('detection-sources')
  })

  it('live contribution is null when there is no assignment for the device', async () => {
    const { addon } = makeAddon()
    expect(await addon.getDeviceLiveContribution({ deviceId: UNKNOWN_ID })).toBeNull()
  })

  it('live contribution exposes assigned runner + reason when the camera is assigned', async () => {
    const { addon } = makeAddon()
    // Seed an assignment via the placement ledger (S6: `placement-ledger.ts`
    // moved `assignments` off the addon class; `seedAssignment` is the raw-
    // write test seam that mirrors the old direct `Map.set`).
    interface OrchestratorInternals {
      ledger: {
        seedAssignment(
          deviceId: number,
          assignment: {
            deviceId: number
            agentNodeId: string
            pinned: boolean
            reason: string
            assignedAt: number
          },
        ): void
      }
    }
    const { ledger } = addon as unknown as OrchestratorInternals
    ledger.seedAssignment(CAM_ID, {
      deviceId: CAM_ID,
      agentNodeId: 'hub',
      pinned: false,
      reason: 'capacity',
      assignedAt: Date.now(),
    })

    const live = await addon.getDeviceLiveContribution({ deviceId: CAM_ID })
    expect(live).not.toBeNull()
    const section = live!.sections[0]!
    expect(section.id).toBe('orchestrator-live')
    const runner = section.fields.find((f) => (f as { key?: string }).key === 'assignedRunner')
    expect((runner as { value?: unknown }).value).toBe('hub')
  })

  it('refuses the retired cameraPipeline key by name and writes nothing (D927)', async () => {
    const { addon, store, emit } = makeAddon()
    await expect(
      addon.applyDeviceSettingsPatch({
        deviceId: CAM_ID,
        patch: { motionFps: 8, cameraPipeline: { steps: [], audio: null } },
      }),
    ).rejects.toThrow(/cameraPipeline refused/)
    expect(store[CAM_ID]?.['motionFps']).toBeUndefined()
    expect(store[CAM_ID]?.['cameraPipeline']).toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it('applyDeviceSettingsPatch writes + emits OrchestrationSettingsUpdated', async () => {
    const { addon, store, emit } = makeAddon()

    await addon.applyDeviceSettingsPatch({ deviceId: CAM_ID, patch: { motionFps: 8 } })
    expect(store[CAM_ID]?.['motionFps']).toBe(8)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'orchestration.settings-updated',
      }),
    )
  })
})

/**
 * `setCameraSensors` (G5, D676) at the DELEGATE: the store write goes THROUGH
 * `applyDeviceSettingsPatch`, so the PARSED value lands and the settings change
 * is announced — the event the bridge's resolver refreshes on. A delegate that
 * stored without announcing left a UI attach inert until a restart, silently,
 * and every narrower spec stayed green (block-2 review, disarm 5).
 */
describe('PipelineOrchestratorAddon.setCameraSensors — one write path with the patch', () => {
  const PIR = { addonId: 'provider-homeassistant', stableId: 'binary_sensor.porch_pir' }
  const CAMERA_103 = { type: 'camera', addonId: 'provider-hikvision', stableId: 'mac-103' }

  function withRegistryDevice(ctx: object, device: typeof CAMERA_103 | null): void {
    Object.defineProperty(ctx, 'api', {
      value: { deviceManager: { getDevice: { query: async () => device } } },
      configurable: true,
    })
  }

  it('stores the PARSED value and announces OrchestrationSettingsUpdated once', async () => {
    const { addon, store, emit, ctx } = makeAddon()
    withRegistryDevice(ctx, CAMERA_103)
    // The numeric id rides along in the ref: the patch gate strips it (R3).
    const sensor = { ...PIR, deviceId: 3299 }
    await expect(
      addon.setCameraSensors({
        deviceId: 103,
        config: { sensors: [{ ...sensor, mode: 'in-addition' }] },
      }),
    ).resolves.toEqual({ success: true })
    expect(store[103]).toEqual({ cameraSensors: { sensors: [{ ...PIR, mode: 'in-addition' }] } })
    expect(emit).toHaveBeenCalledTimes(1)
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({
        category: EventCategory.OrchestrationSettingsUpdated,
        source: { type: 'device', id: 103, nodeId: 'hub' },
        data: { deviceId: 103 },
      }),
    )
  })

  it('null clears through the same path, and is announced', async () => {
    const { addon, store, emit, ctx } = makeAddon()
    withRegistryDevice(ctx, CAMERA_103)
    await addon.setCameraSensors({ deviceId: 103, config: null })
    expect(store[103]).toEqual({ cameraSensors: null })
    expect(emit).toHaveBeenCalledWith(
      expect.objectContaining({ category: EventCategory.OrchestrationSettingsUpdated }),
    )
  })

  it('a refusal stores nothing and announces nothing', async () => {
    const { addon, store, emit, ctx } = makeAddon()
    withRegistryDevice(ctx, { ...CAMERA_103, type: 'sensor' })
    await expect(
      addon.setCameraSensors({
        deviceId: 103,
        config: { sensors: [{ ...PIR, mode: 'in-addition' }] },
      }),
    ).rejects.toThrow('device 103 is not a camera')
    expect(store[103]).toBeUndefined()
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('PipelineOrchestratorAddon — camera detection source (the Steps editor control)', () => {
  const CAM_ID = 7

  function withNativeDetection(
    addon: PipelineOrchestratorAddon,
    ctx: object,
    opts: { readonly native: boolean; readonly geometry?: string },
  ) {
    const internals = addon as unknown as {
      deviceHasNativeObjectDetectionCap: (deviceId: number) => Promise<boolean>
    }
    internals.deviceHasNativeObjectDetectionCap = async () => opts.native
    const setEnabled = vi.fn(async () => ({}))
    Object.defineProperty(ctx, 'api', {
      value: {
        nativeObjectDetection: {
          setEnabled: { mutate: setEnabled },
          getOptions: { query: async () => ({ geometry: opts.geometry ?? 'boxed' }) },
        },
      },
      configurable: true,
    })
    return { setEnabled }
  }

  it('reads the default as pipeline, not explicit, with what the camera can do', async () => {
    const { addon, ctx } = makeAddon()
    withNativeDetection(addon, ctx, { native: true, geometry: 'flag-only' })
    expect(await addon.getCameraDetectionSource({ deviceId: CAM_ID })).toEqual({
      source: 'pipeline',
      explicit: false,
      onboard: { available: true, geometry: 'flag-only' },
    })
  })

  it('a pick is stored as the list the runner reads, and drives the vendor flag', async () => {
    const { addon, ctx, store } = makeAddon()
    const { setEnabled } = withNativeDetection(addon, ctx, { native: true })

    await addon.setCameraDetectionSource({ deviceId: CAM_ID, source: 'onboard' })
    expect(store[CAM_ID]?.['detectionSources']).toEqual(['onboard'])
    expect(setEnabled).toHaveBeenLastCalledWith({ deviceId: CAM_ID, enabled: true })
    expect((await addon.getCameraDetectionSource({ deviceId: CAM_ID })).source).toBe('onboard')

    await addon.setCameraDetectionSource({ deviceId: CAM_ID, source: 'none' })
    expect(store[CAM_ID]?.['detectionSources']).toEqual([])
    expect(setEnabled).toHaveBeenLastCalledWith({ deviceId: CAM_ID, enabled: false })
    expect(await addon.getCameraDetectionSource({ deviceId: CAM_ID })).toMatchObject({
      source: 'none',
      explicit: true,
    })

    await addon.setCameraDetectionSource({ deviceId: CAM_ID, source: 'pipeline' })
    expect(store[CAM_ID]?.['detectionSources']).toEqual(['pipeline'])
  })

  it('refuses onboard on a camera with no onboard detector, and writes nothing', async () => {
    const { addon, ctx, store } = makeAddon()
    const { setEnabled } = withNativeDetection(addon, ctx, { native: false })
    await expect(
      addon.setCameraDetectionSource({ deviceId: CAM_ID, source: 'onboard' }),
    ).rejects.toThrow(/no onboard detector/)
    expect(store[CAM_ID]).toBeUndefined()
    expect(setEnabled).not.toHaveBeenCalled()
  })

  it('a stored legacy two-root list reads as its first element — what the runner runs', async () => {
    const { addon, ctx, store } = makeAddon()
    withNativeDetection(addon, ctx, { native: true })
    store[CAM_ID] = { detectionSources: ['onboard', 'pipeline'] }
    expect((await addon.getCameraDetectionSource({ deviceId: CAM_ID })).source).toBe('onboard')
  })

  it('a patch from a page that predates the move still arms the vendor flag through the same writer', async () => {
    const { addon, ctx, store } = makeAddon()
    const { setEnabled } = withNativeDetection(addon, ctx, { native: true })
    await addon.applyDeviceSettingsPatch({
      deviceId: CAM_ID,
      patch: { detectionSources: ['onboard'] },
    })
    expect(store[CAM_ID]?.['detectionSources']).toEqual(['onboard'])
    expect(setEnabled).toHaveBeenCalledWith({ deviceId: CAM_ID, enabled: true })
  })
})
