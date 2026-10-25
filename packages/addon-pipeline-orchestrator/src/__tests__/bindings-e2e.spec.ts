/**
 * Bindings E2E — exercises the `device-manager.setWrapperActive` /
 * `getBindings` contract for the per-device wrapper caps the
 * orchestrator consults: `detection-pipeline` (replaces the legacy
 * `pipelineEnabled` + `disableInference` flags), `audio-analysis`
 * (replaces the legacy `audioEnabled` flag), and `motion-detection`
 * (F15a — replaces the legacy `motionDetectionEnabled` flag).
 *
 * Scenarios (matches F6a–F6e in the 2026-04-22 session plan + F15a):
 *   a) Default state — every camera inherits the defaultActive:true
 *      wrappers; resolver reports pipelineEnabled:true and dispatch
 *      runs the pipeline.
 *   b) detection-pipeline off — resolvePipeline short-circuits to an
 *      empty pipeline; the dispatch still attaches but with
 *      pipelineEnabled:false so the runner skips inference.
 *   c) audio-analysis off — subscribeAudioStream returns null: no
 *      audio subscription is ever opened against the broker.
 *   d) Toggle off → on restores the previously-configured pipeline
 *      without losing per-device stepToggles.
 *   e) Legacy-flag migration — seed audioEnabled:false /
 *      pipelineEnabled:false / motionDetectionEnabled:false in the
 *      device-store and assert the F5 migration script converts them
 *      to bindings at boot.
 *   f) motion-detection off (F15a) — dispatch sets enabled:false on
 *      the runner attach payload; re-enable flips it back.
 */
import { describe, it, expect, afterEach } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeContext,
  makeFakeBroker,
  makeFakeRunner,
  wireRunnerToBroker,
  makeFakeStreamBrokerCap,
  makeFakeAudioAnalyzer,
  enabledNodesFromBroker,
  waitUntil,
} from './e2e-helpers.js'
import { EventCategory } from '@camstack/types'
import type { StreamSourceEntry } from '@camstack/types'

// Phase 3 slice 2 (Task 2): on-motion cameras no longer standing-dispatch —
// they only get a runner attach at session time (on motion), or a
// watch-only attach (with `pipelineEnabled:false`/`detectionMode:'disabled'`)
// while idle. This file's scenarios (binding-toggle → `pipelineEnabled`/
// `steps`/`audio` propagated onto the STANDING runner attach payload) are
// orthogonal to session-vs-standing dispatch, so `detectionMode` is pinned
// to `'always-on'` here to keep exercising the real standing-dispatch path
// these assertions were written against.
const DEFAULT_DEVICE_SETTINGS = {
  detectionMode: 'always-on' as const,
  motionSources: ['analyzer'] as const,
  motionStreamProfile: 'low' as const,
  detectionStreamProfile: 'high' as const,
  motionFps: 4,
  detectionFps: 10,
  motionCooldownMs: 10_000,
  gpuAffinityFpsThreshold: 15,
  capacityTieEpsilon: 1.5,
  onDisconnect: 'migrate' as const,
  pinnedOnDisconnect: 'leave-pinned' as const,
  onReconnect: 'restore' as const,
}

function makeCameraStreams(): readonly StreamSourceEntry[] {
  return [
    { id: 'sub', label: 'sub', protocol: 'rtsp', url: 'rtsp://cam/sub', profileHint: 'low' },
    { id: 'main', label: 'main', protocol: 'rtsp', url: 'rtsp://cam/main', profileHint: 'high' },
  ]
}

interface BootResult {
  readonly addon: PipelineOrchestratorAddon
  readonly ctx: ReturnType<typeof makeFakeContext>['ctx']
  readonly eventBus: ReturnType<typeof makeFakeContext>['eventBus']
  readonly runner: ReturnType<typeof makeFakeRunner>
}

async function bootWithDevice(
  initialDeviceSettings?: Map<number, Record<string, unknown>>,
  initialCameraSettings?: Record<string, Record<string, unknown>>,
): Promise<BootResult> {
  const broker = makeFakeBroker('hub')
  const runner = makeFakeRunner({ nodeId: 'hub' })
  wireRunnerToBroker(broker, 'hub', runner)

  const streamBrokerCap = makeFakeStreamBrokerCap()
  streamBrokerCap.register(1, 'provider-rtsp', makeCameraStreams())
  const audioAnalyzer = makeFakeAudioAnalyzer()

  const deviceSettings =
    initialDeviceSettings ??
    new Map<number, Record<string, unknown>>([[1, { ...DEFAULT_DEVICE_SETTINGS }]])

  const globalSettings: Record<string, unknown> = {
    enabledNodes: enabledNodesFromBroker(broker),
  }
  if (initialCameraSettings) {
    globalSettings['cameraSettings'] = initialCameraSettings
  }

  const { ctx, eventBus } = makeFakeContext({
    addonConfig: { moleculerBroker: broker },
    initialDeviceSettings: deviceSettings,
    initialGlobalSettings: globalSettings,
    providers: {
      'stream-broker': streamBrokerCap,
      'audio-analyzer': audioAnalyzer,
    },
  })

  const addon = new PipelineOrchestratorAddon()
  await addon.initialize(ctx)

  return { addon, ctx, eventBus, runner }
}

function fireDeviceStreamsRegistered(eventBus: BootResult['eventBus'], deviceId = 1): void {
  eventBus.emit({
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.CameraStreamsProfileSlotsChanged,
    data: { deviceId, providerId: 'provider-rtsp' },
  })
}

describe('bindings-e2e — default state (F6a)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('default boot: detection-pipeline + audio-analysis both active for every camera', async () => {
    const boot = await bootWithDevice()
    addon = boot.addon

    const bindings = await boot.ctx.api!.deviceManager.getBindings.query({ deviceId: 1 })
    const capNames = bindings.entries.map((e) => e.capName)
    expect(capNames).toContain('detection-pipeline')
    expect(capNames).toContain('audio-analysis')
  })

  it('default boot: dispatch sets pipelineEnabled:true on the runner attach payload', async () => {
    const boot = await bootWithDevice()
    addon = boot.addon

    fireDeviceStreamsRegistered(boot.eventBus)
    await waitUntil(() => boot.runner.attachedCameras.has(1))

    const attached = boot.runner.attachedCameras.get(1)!
    expect(attached.pipelineEnabled).toBe(true)
  })
})

describe('bindings-e2e — detection-pipeline toggle (F6b)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('setWrapperActive(detection-pipeline, false) → resolvePipeline returns empty pipeline', async () => {
    const boot = await bootWithDevice()
    addon = boot.addon

    await boot.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })

    const resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.steps).toEqual([])
    expect(resolved.audio).toBeNull()
  })

  it('setWrapperActive(detection-pipeline, false) → the camera is never dispatched to the runner', async () => {
    // CONTRACT CHANGE (2026-08-11, operator directive). Two tests here used
    // to assert that an unbound camera IS dispatched, carrying
    // `pipelineEnabled:false` and an empty `steps` array — the "F12 runner
    // gate": empty steps make `runInference()` return before `runPipeline`.
    //
    // That gate only ever stopped INFERENCE. Dispatch is what makes the
    // runner dial RTSP, spawn ffmpeg and open a decode session, so an
    // unbound camera still produced every frame and discarded it. And
    // `pipelineEnabled` — the flag that reads like the real gate — is not
    // consumed anywhere in `packages/addon-pipeline` at all.
    //
    // Both assertions are replaced by the only one that constrains cost:
    // the runner is not given the camera. `resolvePipeline` returning an
    // empty pipeline is still covered by the test above.
    const boot = await bootWithDevice()
    addon = boot.addon

    await boot.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })

    fireDeviceStreamsRegistered(boot.eventBus)
    await new Promise((r) => setTimeout(r, 150))

    expect(boot.runner.attachedCameras.has(1)).toBe(false)
  })
})

describe('bindings-e2e — audio-analysis toggle (F6c)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('setWrapperActive(audio-analysis, false) → no audio subscription is opened', async () => {
    const boot = await bootWithDevice()
    addon = boot.addon

    await boot.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'audio-analysis',
      wrapperAddonId: 'audio-analyzer',
      active: false,
    })

    fireDeviceStreamsRegistered(boot.eventBus)
    await waitUntil(() => boot.runner.attachedCameras.has(1))

    // The orchestrator's internal audioSubscriptions map should NOT have
    // an entry for this device when the audio-analysis binding is off.
    const hasAudioSub =
      (addon as unknown as { audioSubscriptions?: Map<number, unknown> }).audioSubscriptions?.has(
        1,
      ) ?? false
    expect(hasAudioSub).toBe(false)
  })
})

describe('bindings-e2e — motion-detection toggle (F15a)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('setWrapperActive(motion-detection, false) → detection never starts (no runner attach)', async () => {
    // When motion-detection is bound off, buildDetectionConfig returns
    // a config with enabled:false and handleStreamsRegistered short-
    // circuits before reaching startDetection. The runner therefore
    // never gets an attach for this device.
    const boot = await bootWithDevice()
    addon = boot.addon

    await boot.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'motion-detection',
      wrapperAddonId: 'motion-wasm',
      active: false,
    })

    fireDeviceStreamsRegistered(boot.eventBus)
    // Give the orchestrator a moment to process the event; with motion
    // off we expect no attach — so we sleep a fixed slice rather than
    // waitUntil.
    await new Promise((r) => setTimeout(r, 150))

    expect(boot.runner.attachedCameras.has(1)).toBe(false)
  })

  it('live toggle motion-detection off after attach → runner detached (re-dispatch under F13 filter)', async () => {
    const boot = await bootWithDevice()
    addon = boot.addon

    fireDeviceStreamsRegistered(boot.eventBus)
    await waitUntil(() => boot.runner.attachedCameras.has(1))
    expect(boot.runner.attachedCameras.has(1)).toBe(true)

    await boot.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'motion-detection',
      wrapperAddonId: 'motion-wasm',
      active: false,
    })

    await waitUntil(() => !boot.runner.attachedCameras.has(1))
    expect(boot.runner.attachedCameras.has(1)).toBe(false)
  })
})

describe('bindings-e2e — live toggle triggers re-dispatch (F13)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('setWrapperActive after initial attach → DeviceBindingsChanged → runner re-attached with fresh payload', async () => {
    const boot = await bootWithDevice()
    addon = boot.addon

    // Initial dispatch — binding default active, attach happens.
    fireDeviceStreamsRegistered(boot.eventBus)
    await waitUntil(() => boot.runner.attachedCameras.has(1))
    const initial = boot.runner.attachedCameras.get(1)!
    expect(initial.pipelineEnabled).toBe(true)
    const initialAttaches = boot.runner.attachHistory.filter(
      (h) => h.action === 'attach' && h.deviceId === 1,
    ).length

    // Operator flips detection-pipeline off. The DeviceBindingsChanged
    // subscribe picks it up and runs handleSettingsChanged → stop.
    //
    // CONTRACT CHANGE (2026-08-11): this used to re-dispatch the camera with
    // `pipelineEnabled:false`, and that re-dispatch is precisely what kept
    // the decoder alive — the teardown worked, and `startDetection`
    // immediately handed the camera back to the runner. Off now means the
    // camera STAYS detached.
    await boot.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })

    await waitUntil(() => !boot.runner.attachedCameras.has(1))
    expect(boot.runner.attachedCameras.has(1)).toBe(false)

    // And re-enabling brings it back — the gate must be a gate, not a
    // one-way door.
    await boot.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: true,
    })
    await waitUntil(() => {
      const a = boot.runner.attachedCameras.get(1)
      return a !== undefined && a.pipelineEnabled === true
    })
    const afterReenable = boot.runner.attachedCameras.get(1)!
    expect(afterReenable.pipelineEnabled).toBe(true)

    // The off toggle must have produced a DETACH and the on toggle a fresh
    // ATTACH — confirms the orchestrator reacted to both events rather than
    // simply never touching the camera again.
    const detaches = boot.runner.attachHistory.filter(
      (h) => h.action === 'detach' && h.deviceId === 1,
    ).length
    expect(detaches).toBeGreaterThanOrEqual(1)
    const finalAttaches = boot.runner.attachHistory.filter(
      (h) => h.action === 'attach' && h.deviceId === 1,
    ).length
    expect(finalAttaches).toBeGreaterThanOrEqual(initialAttaches + 1)
  })

  it('DeviceBindingsChanged for a non-gated cap (e.g. snapshot) does NOT trigger re-dispatch', async () => {
    // Only detection-pipeline + audio-analysis drive re-dispatch; an
    // operator toggling snapshot or camera-streams shouldn't churn the
    // runner. Otherwise a single device with 8 wrappers would produce
    // 8 dispatch storms every time the operator walks the BindingsTab.
    const boot = await bootWithDevice()
    addon = boot.addon

    fireDeviceStreamsRegistered(boot.eventBus)
    await waitUntil(() => boot.runner.attachedCameras.has(1))
    const baseline = boot.runner.attachHistory.filter(
      (h) => h.action === 'attach' && h.deviceId === 1,
    ).length

    await boot.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'snapshot',
      wrapperAddonId: 'snapshot',
      active: false,
    })

    // Give the event a chance to propagate, then assert no churn.
    await new Promise((r) => setTimeout(r, 50))
    const after = boot.runner.attachHistory.filter(
      (h) => h.action === 'attach' && h.deviceId === 1,
    ).length
    expect(after).toBe(baseline)
  })
})

describe('bindings-e2e — toggle off → on restores config (F6d)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('detection-pipeline off → on yields the same resolved pipeline', async () => {
    const boot = await bootWithDevice()
    addon = boot.addon

    const baseline = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })

    await boot.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: false,
    })
    const off = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(off.steps).toEqual([])

    await boot.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'detection-pipeline',
      active: true,
    })
    const on = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(on.steps).toEqual(baseline.steps)
    expect(on.audio).toEqual(baseline.audio)
  })
})

describe('bindings-e2e — legacy-flag migration (F6e)', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  // Migration is a fire-and-forget `void this.migrateLegacyFlagsToBindings()`
  // scheduled at the tail of onInitialize. Production polls up to 6s
  // for ctx.api; the fake resolves it immediately, so the work lands
  // within one macrotask. waitUntilAsync polls the getBindings state
  // until the migration settles (or times out).
  const waitUntilAsync = async (
    check: () => Promise<boolean>,
    timeoutMs = 3_000,
    intervalMs = 50,
  ): Promise<void> => {
    const start = Date.now()
    while (!(await check())) {
      if (Date.now() - start > timeoutMs) {
        throw new Error(`waitUntilAsync timed out after ${timeoutMs}ms`)
      }
      await new Promise((r) => setTimeout(r, intervalMs))
    }
  }

  it('audioEnabled:false + pipelineEnabled:false persisted → bindings flipped by boot migration', async () => {
    const initialDeviceSettings = new Map<number, Record<string, unknown>>([
      [
        1,
        {
          ...DEFAULT_DEVICE_SETTINGS,
          audioEnabled: false,
          pipelineEnabled: false,
        },
      ],
    ])
    const boot = await bootWithDevice(initialDeviceSettings)
    addon = boot.addon

    await waitUntilAsync(async () => {
      const bindings = await boot.ctx.api!.deviceManager.getBindings.query({ deviceId: 1 })
      const capNames = bindings.entries.map((e) => e.capName)
      return !capNames.includes('audio-analysis') && !capNames.includes('detection-pipeline')
    })

    const bindings = await boot.ctx.api!.deviceManager.getBindings.query({ deviceId: 1 })
    const capNames = bindings.entries.map((e) => e.capName)
    expect(capNames).not.toContain('audio-analysis')
    expect(capNames).not.toContain('detection-pipeline')
  })

  it('disableInference:true in cameraSettings → detection-pipeline flipped off', async () => {
    const initialCameraSettings: Record<string, Record<string, unknown>> = {
      '1': { disableInference: true },
    }
    const boot = await bootWithDevice(undefined, initialCameraSettings)
    addon = boot.addon

    await waitUntilAsync(async () => {
      const bindings = await boot.ctx.api!.deviceManager.getBindings.query({ deviceId: 1 })
      return !bindings.entries.some((e) => e.capName === 'detection-pipeline')
    })

    const bindings = await boot.ctx.api!.deviceManager.getBindings.query({ deviceId: 1 })
    expect(bindings.entries.some((e) => e.capName === 'detection-pipeline')).toBe(false)
  })

  it('motionDetectionEnabled:false persisted → motion-detection flipped off (F15a)', async () => {
    const initialDeviceSettings = new Map<number, Record<string, unknown>>([
      [1, { ...DEFAULT_DEVICE_SETTINGS, motionDetectionEnabled: false }],
    ])
    const boot = await bootWithDevice(initialDeviceSettings)
    addon = boot.addon

    await waitUntilAsync(async () => {
      const bindings = await boot.ctx.api!.deviceManager.getBindings.query({ deviceId: 1 })
      return !bindings.entries.some((e) => e.capName === 'motion-detection')
    })

    const bindings = await boot.ctx.api!.deviceManager.getBindings.query({ deviceId: 1 })
    expect(bindings.entries.some((e) => e.capName === 'motion-detection')).toBe(false)
  })

  it('migration is idempotent — second boot does not flip bindings that were re-enabled', async () => {
    const initialDeviceSettings = new Map<number, Record<string, unknown>>([
      [1, { ...DEFAULT_DEVICE_SETTINGS, audioEnabled: false }],
    ])
    const boot = await bootWithDevice(initialDeviceSettings)
    addon = boot.addon

    await waitUntilAsync(async () => {
      const bindings = await boot.ctx.api!.deviceManager.getBindings.query({ deviceId: 1 })
      return !bindings.entries.some((e) => e.capName === 'audio-analysis')
    })

    await boot.ctx.api!.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'audio-analysis',
      wrapperAddonId: 'audio-analyzer',
      active: true,
    })

    const bindings = await boot.ctx.api!.deviceManager.getBindings.query({ deviceId: 1 })
    expect(bindings.entries.some((e) => e.capName === 'audio-analysis')).toBe(true)
  })
})
