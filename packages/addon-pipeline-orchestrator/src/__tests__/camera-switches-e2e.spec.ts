/**
 * The per-camera FUNCTION SWITCH group, driven through the REAL addon (D62).
 *
 * `camera-switch-service.spec.ts` proves the routing against a fake api.
 * These prove the thing that actually matters: **flipping a switch OFF stops
 * the work.** Every assertion below lands on the same gate the pre-existing
 * `bindings-e2e.spec.ts` scenarios assert — the resolved pipeline, the runner
 * attach payload, the audio subscription map — reached this time by pressing
 * the group's button rather than by calling `setWrapperActive` by hand.
 *
 * That is the whole claim of the group: it adds no state, so its buttons must
 * arrive at gates that already existed and are already proven. A switch that
 * saved a boolean and stopped nothing would pass a persistence test and fail
 * every one of these.
 */

import type { StreamSourceEntry } from '@camstack/types'
import { EventCategory } from '@camstack/types'
import { afterEach, describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  enabledNodesFromBroker,
  makeFakeAudioAnalyzer,
  makeFakeBroker,
  makeFakeContext,
  makeFakeRunner,
  makeFakeStreamBrokerCap,
  waitUntil,
  wireRunnerToBroker,
} from './e2e-helpers.js'

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

async function boot(): Promise<BootResult> {
  const broker = makeFakeBroker('hub')
  const runner = makeFakeRunner({ nodeId: 'hub' })
  wireRunnerToBroker(broker, 'hub', runner)

  const streamBrokerCap = makeFakeStreamBrokerCap()
  streamBrokerCap.register(1, 'provider-rtsp', makeCameraStreams())

  const { ctx, eventBus } = makeFakeContext({
    addonConfig: { moleculerBroker: broker },
    initialDeviceSettings: new Map<number, Record<string, unknown>>([
      [1, { ...DEFAULT_DEVICE_SETTINGS }],
    ]),
    initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    providers: {
      'stream-broker': streamBrokerCap,
      'audio-analyzer': makeFakeAudioAnalyzer(),
    },
  })

  const addon = new PipelineOrchestratorAddon()
  await addon.initialize(ctx)
  return { addon, ctx, eventBus, runner }
}

function fireStreamsRegistered(eventBus: BootResult['eventBus'], deviceId = 1): void {
  eventBus.emit({
    id: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date(),
    source: { type: 'device', id: deviceId },
    category: EventCategory.CameraStreamsProfileSlotsChanged,
    data: { deviceId, providerId: 'provider-rtsp' },
  })
}

describe('camera function switches — the group as a surface', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('derives the group from what the deployment actually provides', async () => {
    const b = await boot()
    addon = b.addon
    const group = await addon.getCameraSwitches({ deviceId: 1 })
    expect(group.deviceId).toBe(1)
    expect(group.switches.map((s) => s.id)).toEqual([
      'stream-broker',
      'object-detection',
      'privacy-mask',
      'device-audio',
      'broker-audio',
      'audio-analysis',
      // Added to the catalog on 2026-09-19: detection keeps running and the
      // live boxes keep moving, what stops is the WRITING — a camera that
      // looks busy with an empty timeline was the state an operator could not
      // otherwise explain.
      'event-saving',
      'recording',
      'notifications',
    ])
    // The fake hub in this harness has no `privacy-mask` binding, so the
    // microphone row is present but NOT offered — an absent function is
    // explained, never rendered as a dead control.
    expect(group.switches.find((s) => s.id === 'device-audio')).toMatchObject({
      available: false,
      unavailableReason: 'no-provider',
    })
    // The broker mute IS offered on this camera: its authority is the
    // stream-broker's own store, so it does not depend on a `privacy-mask`
    // binding the way the microphone row above does. That is the whole
    // reason the row exists — a camera whose vendor exposes no microphone
    // control can still be silenced.
    expect(group.switches.find((s) => s.id === 'broker-audio')).toMatchObject({
      available: true,
      enabled: true,
    })
    // Every switch says what it costs — a switch that cannot should not ship.
    expect(group.switches.every((s) => s.costWhenOff.length > 40)).toBe(true)
  })

  it('a camera with everything on reports NOTHING switched off — so quiet means broken', async () => {
    const b = await boot()
    addon = b.addon
    // A fresh camera really does have recording off (`DEFAULT_DEVICE_CONFIG`
    // is `{ enabled: false, bands: [] }`), and the group reports that
    // honestly. Turn it on so the assertion is about the empty case.
    await addon.setCameraSwitch({ deviceId: 1, switchId: 'recording', enabled: true })
    const status = await addon.getCameraStatus({ deviceId: 1 })
    expect(status.switchedOff).toEqual([])
  })
})

describe('camera function switches — OFF stops the work', () => {
  let addon: PipelineOrchestratorAddon | null = null
  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  // ── object detection ────────────────────────────────────────────────

  it('object-detection OFF → the resolved pipeline is empty', async () => {
    const b = await boot()
    addon = b.addon

    await addon.setCameraSwitch({ deviceId: 1, switchId: 'object-detection', enabled: false })

    const resolved = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(resolved.steps).toEqual([])
    expect(resolved.audio).toBeNull()
  })

  it('object-detection OFF → the RUNNER is never handed the camera at all', async () => {
    // CONTRACT CHANGE (2026-08-11, operator directive): this test used to
    // assert the opposite — that the runner IS attached, with
    // `pipelineEnabled:false` and empty steps. That was a real design, and
    // its own comment named its limit: "the gate that actually stops
    // inference lives in the runner: an empty steps array makes
    // `runInference()` return before `runPipeline`".
    //
    // Stopping INFERENCE is not stopping WORK. An attached camera dials its
    // RTSP, spawns ffmpeg and opens a decode session no matter how empty its
    // steps are, so a switched-off camera kept paying for every frame it
    // produced and then threw them away. Measured on camera 3218 with the
    // switch off: `ffmpeg source: streaming`, `RTSP client connected`,
    // `session-decode-coordinator … waitedMs=40001`.
    //
    // `pipelineEnabled` was supposed to be the real gate and never became
    // one: nothing in `packages/addon-pipeline` reads it. The switch now
    // gates the PRODUCER in the orchestrator instead, so the frames are
    // never made.
    const b = await boot()
    addon = b.addon

    await addon.setCameraSwitch({ deviceId: 1, switchId: 'object-detection', enabled: false })
    fireStreamsRegistered(b.eventBus)
    await new Promise((r) => setTimeout(r, 150))

    expect(b.runner.attachedCameras.has(1)).toBe(false)
  })

  it('object-detection OFF is reported as SWITCHED OFF, not as a broken camera', async () => {
    const b = await boot()
    addon = b.addon
    await addon.setCameraSwitch({ deviceId: 1, switchId: 'object-detection', enabled: false })

    const status = await addon.getCameraStatus({ deviceId: 1 })
    expect(status.switchedOff).toContain('object-detection')
  })

  // ── the BROKER's audio plane (D83) ──────────────────────────────────

  it('broker-audio OFF writes the BROKER and reads back off — through the real addon', async () => {
    const b = await boot()
    addon = b.addon

    const after = await addon.setCameraSwitch({
      deviceId: 1,
      switchId: 'broker-audio',
      enabled: false,
    })
    expect(after.switches.find((s) => s.id === 'broker-audio')?.enabled).toBe(false)

    // Read fresh, through a second round trip: the group must recompose from
    // the broker's answer, never from the value the caller passed in.
    const reread = await addon.getCameraSwitches({ deviceId: 1 })
    expect(reread.switches.find((s) => s.id === 'broker-audio')?.enabled).toBe(false)
  })

  it('broker-audio OFF is reported as SWITCHED OFF, not as a broken camera', async () => {
    const b = await boot()
    addon = b.addon
    await addon.setCameraSwitch({ deviceId: 1, switchId: 'broker-audio', enabled: false })

    const status = await addon.getCameraStatus({ deviceId: 1 })
    // Disabled must never look like broken.
    expect(status.switchedOff).toContain('broker-audio')
    // The `audio` BLOCK's agreement with this is asserted in
    // `camera-status-audio-enabled.spec.ts` and NOT here: this harness
    // assigns no audio node, so `status.audio` is null and any assertion on
    // it would pass against the lie rather than against the fix — the exact
    // vacuous-guard failure D62's enforcement notes call out.
  })

  it('broker-audio back ON restores the plane', async () => {
    const b = await boot()
    addon = b.addon
    await addon.setCameraSwitch({ deviceId: 1, switchId: 'broker-audio', enabled: false })
    await addon.setCameraSwitch({ deviceId: 1, switchId: 'broker-audio', enabled: true })

    const status = await addon.getCameraStatus({ deviceId: 1 })
    expect(status.switchedOff).not.toContain('broker-audio')
  })

  it('object-detection back ON restores exactly what was resolving before', async () => {
    const b = await boot()
    addon = b.addon
    const before = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })

    await addon.setCameraSwitch({ deviceId: 1, switchId: 'object-detection', enabled: false })
    await addon.setCameraSwitch({ deviceId: 1, switchId: 'object-detection', enabled: true })

    const after = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })
    expect(after).toEqual(before)
    expect(
      (await addon.getCameraSwitches({ deviceId: 1 })).switches.find(
        (s) => s.id === 'object-detection',
      )?.enabled,
    ).toBe(true)
  })

  // ── audio ───────────────────────────────────────────────────────────

  it('audio-analysis OFF → no audio subscription is ever opened', async () => {
    const b = await boot()
    addon = b.addon

    await addon.setCameraSwitch({ deviceId: 1, switchId: 'audio-analysis', enabled: false })
    fireStreamsRegistered(b.eventBus)
    await waitUntil(() => b.runner.attachedCameras.has(1))

    const subs = (addon as unknown as { audioSubscriptions?: Map<number, unknown> })
      .audioSubscriptions
    expect(subs?.has(1) ?? false).toBe(false)
  })

  it('audio-analysis OFF is reported as SWITCHED OFF, not as a broken camera', async () => {
    const b = await boot()
    addon = b.addon
    await addon.setCameraSwitch({ deviceId: 1, switchId: 'audio-analysis', enabled: false })

    const status = await addon.getCameraStatus({ deviceId: 1 })
    expect(status.switchedOff).toContain('audio-analysis')
  })

  // ── the camera itself ───────────────────────────────────────────────

  it('the camera switch OFF marks the device disabled — what releases its brokers', async () => {
    const b = await boot()
    addon = b.addon
    await addon.setCameraSwitch({ deviceId: 1, switchId: 'stream-broker', enabled: false })

    const device = await b.ctx.api!.deviceManager.getDevice.query({ deviceId: 1 })
    expect(device?.disabled).toBe(true)

    const group = await addon.getCameraSwitches({ deviceId: 1 })
    expect(group.switches.find((s) => s.id === 'stream-broker')?.enabled).toBe(false)
  })

  // ── recording ───────────────────────────────────────────────────────

  it('recording OFF flips `enabled` and leaves the authored bands untouched', async () => {
    const b = await boot()
    addon = b.addon
    const bands = [{ days: [], start: '00:00', end: '23:59', mode: 'continuous' as const }]
    await b.ctx.api!.recordingArchive.setDeviceConfig.mutate({
      deviceId: 1,
      config: { enabled: true, bands },
    })

    await addon.setCameraSwitch({ deviceId: 1, switchId: 'recording', enabled: false })

    const config = await b.ctx.api!.recordingArchive.getDeviceConfig.query({ deviceId: 1 })
    expect(config.enabled).toBe(false)
    // Clearing bands to express "off" would destroy the operator's schedule,
    // and turning the camera back on would then silently record nothing.
    expect(config.bands).toEqual(bands)
  })

  // ── notifications ───────────────────────────────────────────────────

  it('notifications OFF writes the permanent per-camera mute', async () => {
    const b = await boot()
    addon = b.addon
    await addon.setCameraSwitch({ deviceId: 1, switchId: 'notifications', enabled: false })

    const mutes = await b.ctx.api!.notificationRules.listDeviceMutes.query({})
    expect(mutes.mutedDeviceIds).toEqual([1])

    const status = await addon.getCameraStatus({ deviceId: 1 })
    expect(status.switchedOff).toContain('notifications')
  })

  // ── independence ────────────────────────────────────────────────────

  it('the switches are independent — turning off recording leaves detection alone', async () => {
    const b = await boot()
    addon = b.addon
    const before = await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })

    await addon.setCameraSwitch({ deviceId: 1, switchId: 'recording', enabled: false })

    expect(await addon.resolvePipeline({ deviceId: 1, agentNodeId: 'hub' })).toEqual(before)
    const group = await addon.getCameraSwitches({ deviceId: 1 })
    expect(group.switches.find((s) => s.id === 'object-detection')?.enabled).toBe(true)
    expect((await addon.getCameraStatus({ deviceId: 1 })).switchedOff).toEqual(['recording'])
  })
})
