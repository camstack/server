/**
 * Detection-wiring E2E — exercises the event-bus-driven lifecycle
 * that was migrated from the deleted kernel `DetectionWiringService`
 * into the `pipeline-orchestrator` addon. Every scenario here is a
 * black-box flow:
 *
 *   1. Initialize the orchestrator addon against a fake context with
 *      fake stream-broker / audio-analyzer / analysis-pipeline / runner.
 *   2. Seed per-device settings via `ctx.settings.updateDevice(...)`.
 *   3. Emit the relevant event on the bus (`DeviceStreamsRegistered`,
 *      `OrchestrationSettingsUpdated`, `PipelineInferenceResult`).
 *   4. Assert the orchestrator reacted correctly — camera dispatched,
 *      audio handed to the analyzer, detection result re-emitted, etc.
 *
 * These are the regressions the coverage audit flagged as P0/P1 after
 * the kernel-cleanup refactor:
 *   - P0-1: the audio ATTACH contract. This was the canonical
 *     `pipeline.audio-inference-result` shape until D461 moved the poller,
 *     the accumulator and the event itself into `audio-analyzer`; the frame
 *     is now pinned in `addon-pipeline/src/audio-analyzer/__tests__/
 *     audio-result-event.spec.ts` against the real poller and accumulator,
 *     and what remains here is the handover this addon still owns
 *   - P1-6: admin writes `motionFps → 6` end-to-end
 *   - P1-9: orchestrator subscribes to DeviceStreamsRegistered and
 *           dispatches cameras
 *   - P2-13: mid-stream settings change restarts detection cleanly
 */
import { describe, it, expect, afterEach } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'
import {
  makeFakeContext,
  makeFakeBroker,
  makeFakeRunner,
  wireRunnerToBroker,
  makeFakeStreamBroker,
  makeFakeStreamBrokerCap,
  makeFakeAudioAnalyzer,
  enabledNodesFromBroker,
  waitUntil,
} from './e2e-helpers.js'
import { EventCategory } from '@camstack/types'
import type { StreamSourceEntry, FrameResult, FrameHandle } from '@camstack/types'

// ── Test fixtures ─────────────────────────────────────────────────

/**
 * Standard orchestrator schema defaults used by every scenario.
 *
 * Phase 3 slice 2 (Task 2): on-motion cameras no longer standing-dispatch —
 * these scenarios assert full standing-attach payload shape (`pipelineEnabled`,
 * `motionFps`/`detectionFps`/`motionSources` on the runner attach, dispatch on
 * `DeviceStreamsRegistered`), which is exactly the standing-dispatch contract
 * still owned by `'always-on'` cameras. `detectionMode` is pinned here so
 * these tests keep exercising that path (session-time dispatch for on-motion
 * cameras is covered separately).
 */
const DEFAULT_DEVICE_SETTINGS = {
  detectionMode: 'always-on' as const,
  motionSources: ['analyzer'] as const,
  motionStreamProfile: 'low' as const,
  detectionStreamProfile: 'high' as const,
  motionFps: 4,
  detectionFps: 10,
  motionCooldownMs: 10_000,
  // Balancer + failover globals (resolved at init via `applyRuntimeSettings`)
  gpuAffinityFpsThreshold: 15,
  capacityTieEpsilon: 1.5,
  onDisconnect: 'migrate' as const,
  pinnedOnDisconnect: 'leave-pinned' as const,
  onReconnect: 'restore' as const,
}

/** Fixture: two stream sources with profile hints (low + high). */
function makeCameraStreams(): readonly StreamSourceEntry[] {
  return [
    { id: 'sub', label: 'sub', protocol: 'rtsp', url: 'rtsp://cam/sub', profileHint: 'low' },
    { id: 'main', label: 'main', protocol: 'rtsp', url: 'rtsp://cam/main', profileHint: 'high' },
  ]
}

// ── Suite ─────────────────────────────────────────────────────────

describe('PipelineOrchestratorAddon — detection wiring E2E', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  // P1-9: event-driven dispatch flow ────────────────────────────────
  it('dispatches a camera when DeviceStreamsRegistered fires with resolved settings from the store', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    const initialDeviceSettings = new Map<number, Record<string, unknown>>([
      [1, { ...DEFAULT_DEVICE_SETTINGS }],
    ])
    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings,
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // Fire the device-streams-registered event — the orchestrator's
    // subscribe handler should resolve settings and dispatch.
    eventBus.emit({
      id: 'evt-1',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 1, providerId: 'provider-rtsp' },
    })

    await waitUntil(() => runner.attachedCameras.has(1))

    const attached = runner.attachedCameras.get(1)!
    expect(attached.deviceId).toBe(1)
    expect(attached.motionFps).toBe(DEFAULT_DEVICE_SETTINGS.motionFps)
    expect(attached.detectionFps).toBe(DEFAULT_DEVICE_SETTINGS.detectionFps)
    expect(attached.motionCooldownMs).toBe(DEFAULT_DEVICE_SETTINGS.motionCooldownMs)
    expect(attached.motionSources).toEqual(['analyzer'])
    expect(attached.pipelineEnabled).toBe(true)
    // Cam-stream-keyed brokerId: motion goes to `1/sub` (low profile),
    // detection to `1/main` (high profile). The orchestrator translates
    // CamProfile → camStreamId via the slot map before passing to the
    // pipeline-runner.
    expect(attached.motionStreamId).toBe('sub')
    expect(attached.detectionStreamId).toBe('main')
  })

  // Regression: a TRANSIENT profile-slot read failure (broker discovery
  // timeout) must NOT stop active detection — only a SUCCESSFUL empty read does.
  it('keeps active detection on a transient slot-read failure; stops only on a genuine empty read', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map<number, Record<string, unknown>>([
        [1, { ...DEFAULT_DEVICE_SETTINGS }],
      ]),
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    let seq = 0
    const emitSlots = () =>
      eventBus.emit({
        id: `evt-slots-${seq++}`,
        timestamp: new Date(),
        source: { type: 'device', id: 1 },
        category: EventCategory.CameraStreamsProfileSlotsChanged,
        data: { deviceId: 1, providerId: 'provider-rtsp' },
      })

    emitSlots()
    await waitUntil(() => runner.attachedCameras.has(1))
    expect(runner.attachedCameras.has(1)).toBe(true)

    // Transient read failure (discovery timeout) — detection must be KEPT.
    streamBrokerCap.listAllProfileSlots = () => {
      throw new Error('discovery deadline exceeded for stream-broker.listAllProfileSlots')
    }
    emitSlots()
    await new Promise((r) => setTimeout(r, 60))
    expect(runner.attachedCameras.has(1)).toBe(true)

    // Genuine SUCCESSFUL empty read (real slot loss) — detection must STOP.
    streamBrokerCap.listAllProfileSlots = () => []
    emitSlots()
    await waitUntil(() => !runner.attachedCameras.has(1), 2000)
    expect(runner.attachedCameras.has(1)).toBe(false)
  })

  /**
   * The `object-detection` switch must stop the PRODUCER, not just the
   * consumer.
   *
   * `pipelineEnabled` is derived from the `detection-pipeline` wrapper
   * binding and was carried all the way into the runner's attach payload —
   * where nothing ever read it (`grep pipelineEnabled packages/addon-pipeline`
   * is empty). So a camera with object detection switched off still got a
   * standing attach, still dialled RTSP and still ran a decode session; only
   * the inference was missing. Observed on camera 3218 with the switch off:
   * `ffmpeg source: streaming`, `RTSP client connected`, then
   * `session-decode-coordinator … waitedMs=40001`.
   *
   * Asserted on `attachedCameras` rather than on the payload's flag for
   * exactly that reason: asserting `pipelineEnabled === false` is what a
   * dead flag passes. The only honest question is whether the runner was
   * handed a camera at all.
   */
  it('never attaches a camera whose object-detection switch is off, and detaches one when it is turned off', async () => {
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
      providers: { 'stream-broker': streamBrokerCap },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    eventBus.emit({
      id: 'evt-sw-1',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 1, providerId: 'provider-rtsp' },
    })

    // Baseline: switch ON → the runner is given the camera.
    await waitUntil(() => runner.attachedCameras.has(1))

    // Operator turns object detection off. `setCameraSwitch` routes this to
    // `setWrapperActive` (D62 — the switch writes the authority that already
    // owned the function), which drops the `detection-pipeline` row from
    // `getBindings` and emits `DeviceBindingsChanged`.
    await ctx.api.deviceManager.setWrapperActive.mutate({
      deviceId: 1,
      capName: 'detection-pipeline',
      wrapperAddonId: 'pipeline-executor',
      active: false,
    })

    // The live session must DIE — not merely stop producing detections.
    await waitUntil(() => !runner.attachedCameras.has(1), 2000)
    expect(runner.attachedCameras.has(1)).toBe(false)

    // …and a fresh dispatch trigger must not resurrect it. Without the gate
    // this is where the decoder came back: `handleSettingsChanged` tore the
    // session down and `startDetection` immediately re-attached it.
    eventBus.emit({
      id: 'evt-sw-2',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 1, providerId: 'provider-rtsp' },
    })
    await new Promise((r) => setTimeout(r, 120))
    expect(runner.attachedCameras.has(1)).toBe(false)
  })

  // P1-6: settings flow end-to-end (motionFps) ───────────────────────
  it('respects an admin-written motionFps when the orchestration-settings-updated event fires', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    const initialDeviceSettings = new Map<number, Record<string, unknown>>([
      [1, { ...DEFAULT_DEVICE_SETTINGS }],
    ])
    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings,
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // First dispatch at default motionFps = 4
    eventBus.emit({
      id: 'evt-1',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 1, providerId: 'provider-rtsp' },
    })
    await waitUntil(() => runner.attachedCameras.has(1))
    expect(runner.attachedCameras.get(1)!.motionFps).toBe(4)

    // Admin writes a new motionFps to the per-device store
    await ctx.settings!.writeDeviceStore(1, { motionFps: 6 })

    // Simulate the device-management router emitting the
    // orchestration-settings-updated event that the orchestrator
    // subscribes to. The handler should stop + restart detection.
    eventBus.emit({
      id: 'evt-2',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.OrchestrationSettingsUpdated,
      data: { deviceId: 1, addonId: 'pipeline-orchestrator' },
    })

    await waitUntil(() => {
      const cfg = runner.attachedCameras.get(1)
      return cfg !== undefined && cfg.motionFps === 6
    })
    expect(runner.attachedCameras.get(1)!.motionFps).toBe(6)
  })

  // P2-13: settings change mid-stream restarts detection cleanly ─────
  it('stops + restarts detection cleanly on mid-stream settings change (old audio sub released)', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)
    const fakeAudioBroker = makeFakeStreamBroker('1')
    streamBrokerCap.attachBroker('1/sub', fakeAudioBroker)

    const audioAnalyzer = makeFakeAudioAnalyzer({
      resolver: async () => ({ minConfidence: 0.3, allowedClasses: ['speech'] }),
      classifications: [{ className: 'speech', score: 0.91 }],
    })

    const initialDeviceSettings = new Map<number, Record<string, unknown>>([
      [1, { ...DEFAULT_DEVICE_SETTINGS }],
    ])
    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings,
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: {
        'stream-broker': streamBrokerCap,
        'audio-analyzer': audioAnalyzer,
      },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    eventBus.emit({
      id: 'evt-1',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 1, providerId: 'provider-rtsp' },
    })
    await waitUntil(() => audioAnalyzer.attaches.length === 1)

    // Re-fire settings-updated — the old audio attachment should be released
    // (a `detachDevice` for the device) and a new one installed.
    eventBus.emit({
      id: 'evt-2',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.OrchestrationSettingsUpdated,
      data: { deviceId: 1, addonId: 'pipeline-orchestrator' },
    })
    // D461 retarget: the released thing is no longer a broker subscription the
    // orchestrator holds — it is an attachment the ANALYZER holds, and the
    // release is an RPC that can fail. So the restart must show BOTH halves,
    // not just a steady-state count: a detach of the old, then a fresh attach.
    // An attach without the detach is the orphan this test is named for, and
    // on the real broker it holds the source dial open for good.
    await waitUntil(() => audioAnalyzer.attaches.length === 2, 2000)
    expect(audioAnalyzer.detaches).toContain(1)
    expect(audioAnalyzer.attaches.length - audioAnalyzer.detaches.length).toBe(1)
  })

  // P0-1 (D461 retarget): the ATTACH contract ────────────────────────
  //
  // What used to sit here were two tests asserting the canonical
  // `pipeline.audio-inference-result` frame — the orchestrator drained the
  // chunk plane, accumulated the ~1 s window and emitted the event, so this
  // was the right place for them. It does none of that now: `audio-analyzer`
  // pulls its own audio and emits its own result. Asserting the frame here
  // would mean asserting it against `makeFakeAudioAnalyzer`, a fake standing in
  // for exactly the code that moved — which is how a suite goes green over a
  // live gap. Both properties moved WITH the code, to
  // `packages/addon-pipeline/src/audio-analyzer/__tests__/audio-result-event.spec.ts`,
  // where they run against the real poller and the real accumulator.
  //
  // What the orchestrator still guarantees, and what this test pins, is the
  // handover: the analyzer is told WHICH camera, on WHICH broker, acquired
  // from WHICH ingest node, under WHICH resolved settings. Every one of those
  // is a decision this addon still owns, and each is silently wrong in a
  // different way — a wrong brokerId meters another camera's audio, a wrong
  // ingest node pins the pull at a node with no broker, wrong settings apply
  // another camera's thresholds.
  it('hands the analyzer the resolved settings, the audio brokerId and the ingest node', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)
    const audioBroker = makeFakeStreamBroker('1')
    streamBrokerCap.attachBroker('1/sub', audioBroker)

    const settings = { minConfidence: 0.42, allowedClasses: ['speech'] }
    const audioAnalyzer = makeFakeAudioAnalyzer({ resolver: async () => settings })

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map<number, Record<string, unknown>>([
        [1, { ...DEFAULT_DEVICE_SETTINGS }],
      ]),
      providers: {
        'stream-broker': streamBrokerCap,
        'audio-analyzer': audioAnalyzer,
      },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    eventBus.emit({
      id: 'evt-1',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 1, providerId: 'provider-rtsp' },
    })
    await waitUntil(() => audioAnalyzer.attaches.length === 1)

    const attach = audioAnalyzer.attaches[0]!
    expect(attach.deviceId).toBe(1)
    // The audio rides the camera's audio stream, which falls back to the
    // motion profile ('sub') when no `audioStreamId` is configured.
    expect(attach.brokerId).toBe('1/sub')
    // Source acquisition lives on `clusterRoles.ingestNode`, which defaults to
    // the hub — the analyzer pins every broker call to it.
    expect(attach.ingestNodeId).toBe('hub')
    // Resolved ONCE here, by the addon that owns the audio policy, and carried
    // on the attach. The analyzer does not re-resolve per window.
    expect(attach.settings).toEqual(settings)
  })

  // P1-9 companion: orchestrator re-emits detection.result from
  // PipelineInferenceResult events ─────────────────────────────────
  it('consumes pipeline.inference-result and re-emits detection.result with the runner frame', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    const { ctx, eventBus, captured } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map([[1, { ...DEFAULT_DEVICE_SETTINGS }]]),
      providers: {
        'stream-broker': streamBrokerCap,
      },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const frame: FrameResult = {
      kind: 'frame',
      frameId: 'f1',
      deviceId: 1,
      timestamp: Date.now(),
      width: 1280,
      height: 720,
      detections: [
        {
          id: 'd1',
          kind: 'first-level',
          macroClass: 'person',
          score: 0.9,
          bbox: { x: 10, y: 20, width: 100, height: 200 },
          labels: [],
        },
      ],
      debug: { totalInferenceMs: 12 },
    }

    const capturedBefore = captured.length
    eventBus.emit({
      id: 'evt-infer',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.PipelineInferenceResult,
      data: { deviceId: 1, frame, nodeId: 'hub' },
    })

    await waitUntil(() =>
      captured.slice(capturedBefore).some((e) => e.category === EventCategory.DetectionResult),
    )
    const reEmit = captured
      .slice(capturedBefore)
      .find((e) => e.category === EventCategory.DetectionResult)!
    const data = reEmit.data as { frame: FrameResult; analysisResults: readonly unknown[] }
    expect(data.frame.deviceId).toBe(1)
    expect(data.frame.detections).toHaveLength(1)
    expect(data.analysisResults).toEqual([])
  })

  // Task 7: frameHandle propagation through handleInferenceResult ───
  it('forwards frameHandle from PipelineInferenceResult onto the re-emitted DetectionResult event', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    const { ctx, eventBus, captured } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map([[1, { ...DEFAULT_DEVICE_SETTINGS }]]),
      providers: { 'stream-broker': streamBrokerCap },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const frame: FrameResult = {
      kind: 'frame',
      frameId: 'f-handle-prop',
      deviceId: 1,
      timestamp: Date.now(),
      width: 1280,
      height: 720,
      detections: [
        {
          id: 'd1',
          kind: 'first-level',
          macroClass: 'person',
          score: 0.9,
          bbox: { x: 1, y: 2, width: 3, height: 4 },
          labels: [],
        },
      ],
      debug: { totalInferenceMs: 9 },
    }

    const frameHandle: FrameHandle = {
      shmId: 'csf.handle-prop.1',
      slot: 2,
      seq: 42,
      width: 1280,
      height: 720,
      format: 'rgb',
      pts: 123.456,
      byteLength: 1280 * 720 * 3,
      nodeId: 'hub',
      slotCount: 8,
    }

    const capturedBefore = captured.length
    eventBus.emit({
      id: 'evt-handle-prop',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.PipelineInferenceResult,
      data: { deviceId: 1, frame, nodeId: 'hub', frameHandle },
    })

    await waitUntil(() =>
      captured.slice(capturedBefore).some((e) => e.category === EventCategory.DetectionResult),
    )
    const reEmit = captured
      .slice(capturedBefore)
      .find((e) => e.category === EventCategory.DetectionResult)!
    const data = reEmit.data as {
      frame: FrameResult
      analysisResults: readonly unknown[]
      frameHandle?: FrameHandle
    }
    expect(data.frameHandle).toEqual(frameHandle)
  })

  // Discarded-detection diagnostic: an ALL-DISCARDED frame must still be
  // re-emitted — it is the single most interesting case for the viewer's
  // ghost-box overlay, and the zero-detections early return used to
  // swallow it.
  it('re-emits detection.result for a zero-detection frame that carries a discard trail', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    const { ctx, eventBus, captured } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map([[1, { ...DEFAULT_DEVICE_SETTINGS }]]),
      providers: { 'stream-broker': streamBrokerCap },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const frame: FrameResult = {
      kind: 'frame',
      frameId: 'f-all-discarded',
      deviceId: 1,
      timestamp: Date.now(),
      width: 1280,
      height: 720,
      detections: [],
      discarded: [
        {
          bbox: [10, 20, 110, 220],
          macroClass: 'person',
          score: 0.5,
          reason: 'below-threshold',
        },
      ],
      debug: { totalInferenceMs: 7 },
    }

    const capturedBefore = captured.length
    eventBus.emit({
      id: 'evt-all-discarded',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.PipelineInferenceResult,
      data: { deviceId: 1, frame, nodeId: 'hub' },
    })

    await waitUntil(() =>
      captured.slice(capturedBefore).some((e) => e.category === EventCategory.DetectionResult),
    )
    const reEmit = captured
      .slice(capturedBefore)
      .find((e) => e.category === EventCategory.DetectionResult)!
    const data = reEmit.data as { frame: FrameResult }
    expect(data.frame.detections).toHaveLength(0)
    expect(data.frame.discarded).toHaveLength(1)
    expect(data.frame.discarded?.[0]?.reason).toBe('below-threshold')
  })

  it('still does NOT re-emit a zero-detection frame WITHOUT a discard trail', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    const { ctx, eventBus, captured } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map([[1, { ...DEFAULT_DEVICE_SETTINGS }]]),
      providers: { 'stream-broker': streamBrokerCap },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const frame: FrameResult = {
      kind: 'frame',
      frameId: 'f-plain-empty',
      deviceId: 1,
      timestamp: Date.now(),
      width: 1280,
      height: 720,
      detections: [],
      debug: { totalInferenceMs: 7 },
    }

    const capturedBefore = captured.length
    eventBus.emit({
      id: 'evt-plain-empty',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.PipelineInferenceResult,
      data: { deviceId: 1, frame, nodeId: 'hub' },
    })

    // No positive signal to wait for — give the async handler a beat, then
    // assert the empty frame was swallowed as before.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(
      captured.slice(capturedBefore).some((e) => e.category === EventCategory.DetectionResult),
    ).toBe(false)
  })

  // P2-10: addon init ordering — orchestrator before stream-broker
  it('still dispatches when stream-broker registers AFTER the orchestrator initializes', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    const initialDeviceSettings = new Map<number, Record<string, unknown>>([
      [1, { ...DEFAULT_DEVICE_SETTINGS }],
    ])
    // Init the orchestrator WITHOUT any registered providers — the
    // kernel would load stream-broker later in the boot sequence.
    const { ctx, eventBus, registeredProviders } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings,
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: {},
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    // stream-broker registers itself AFTER init.
    registeredProviders.set('stream-broker', streamBrokerCap)

    // Now emit the device-registered event — the orchestrator should
    // resolve `stream-broker` late via the capability registry and
    // dispatch the camera normally.
    eventBus.emit({
      id: 'evt-1',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 1, providerId: 'provider-rtsp' },
    })
    await waitUntil(() => runner.attachedCameras.has(1))
    expect(runner.attachedCameras.get(1)).toBeDefined()
  })

  // P2-10 variant: orchestrator before analysis-pipeline
  it('handles the optional analysis-pipeline being absent on inference results', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)
    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    // No `analysis-pipeline` provider registered — the orchestrator
    // must still re-emit detection.result without crashing.
    const { ctx, eventBus, captured } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map([[1, { ...DEFAULT_DEVICE_SETTINGS }]]),
      providers: { 'stream-broker': streamBrokerCap },
    })
    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    const frame: FrameResult = {
      kind: 'frame',
      frameId: 'f1',
      deviceId: 1,
      timestamp: Date.now(),
      width: 1280,
      height: 720,
      detections: [
        {
          id: 'd1',
          kind: 'first-level',
          macroClass: 'person',
          score: 0.9,
          bbox: { x: 0, y: 0, width: 10, height: 10 },
          labels: [],
        },
      ],
      debug: { totalInferenceMs: 5 },
    }

    const capturedBefore = captured.length
    eventBus.emit({
      id: 'evt-infer',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.PipelineInferenceResult,
      data: { deviceId: 1, frame, nodeId: 'hub' },
    })
    await waitUntil(() =>
      captured.slice(capturedBefore).some((e) => e.category === EventCategory.DetectionResult),
    )
    const re = captured
      .slice(capturedBefore)
      .find((e) => e.category === EventCategory.DetectionResult)!
    const data = re.data as { analysisResults: readonly unknown[] }
    expect(data.analysisResults).toEqual([])
  })

  // P2-11: single-node dispatch — hub-only deploy routes through ctx.api.pipelineRunner
  it('dispatches locally when only the hub runner is available', async () => {
    const localRunner = makeFakeRunner({ nodeId: 'hub' })
    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    const broker = makeFakeBroker('hub')
    wireRunnerToBroker(broker, 'hub', localRunner)

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map([[1, { ...DEFAULT_DEVICE_SETTINGS }]]),
      initialGlobalSettings: { enabledNodes: ['hub'] },
      providers: { 'stream-broker': streamBrokerCap },
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    eventBus.emit({
      id: 'evt-1',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 1, providerId: 'provider-rtsp' },
    })

    await waitUntil(() => localRunner.attachedCameras.has(1))
    expect(localRunner.attachedCameras.get(1)!.deviceId).toBe(1)
  })

  // ── Motion-source default behaviour ─────────────────────────────────
  //
  // When the user has NOT explicitly set `motionSource`, the orchestrator
  // should prefer `onboard` if the device's camera addon registered a
  // native `motion` or `native-object-detection` cap. Cameras that do
  // motion detection on-device shouldn't have the frame-diff analyzer
  // running on top — duplicates work and wakes battery cams. When the
  // user DID set motionSource explicitly, their choice wins.

  it("defaults motionSource to 'onboard' when a native motion cap is registered and the user hasn't chosen one", async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    // Settings WITHOUT a motionSource key — so the schema default would
    // normally yield 'analyzer'. The onboard-cap detection should
    // override that default.
    const settingsNoMotionSource = { ...DEFAULT_DEVICE_SETTINGS } as Partial<
      typeof DEFAULT_DEVICE_SETTINGS
    >
    delete settingsNoMotionSource.motionSources

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map([[1, settingsNoMotionSource as Record<string, unknown>]]),
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
      // Seed a fake motion native provider for device 1 — just needs to
      // be non-null; the orchestrator only checks its presence.
      nativeProviders: new Map([
        ['motion:1', { isDetected: async () => false, getStatus: async () => null }],
      ]),
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    eventBus.emit({
      id: 'evt-1',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 1, providerId: 'provider-rtsp' },
    })

    await waitUntil(() => runner.attachedCameras.has(1))
    expect(runner.attachedCameras.get(1)!.motionSources).toEqual(['onboard'])
  })

  it('honours an explicit user motionSource even when a native motion cap is registered', async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    // User explicitly picked 'analyzer' — the choice must stick.
    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map([
        [1, { ...DEFAULT_DEVICE_SETTINGS, motionSources: ['analyzer'] }],
      ]),
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
      nativeProviders: new Map([
        ['motion:1', { isDetected: async () => false, getStatus: async () => null }],
      ]),
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    eventBus.emit({
      id: 'evt-1',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 1, providerId: 'provider-rtsp' },
    })

    await waitUntil(() => runner.attachedCameras.has(1))
    expect(runner.attachedCameras.get(1)!.motionSources).toEqual(['analyzer'])
  })

  it("falls back to the schema default 'analyzer' when no native motion cap is registered", async () => {
    const broker = makeFakeBroker('hub')
    const runner = makeFakeRunner({ nodeId: 'hub' })
    wireRunnerToBroker(broker, 'hub', runner)

    const streams = makeCameraStreams()
    const streamBrokerCap = makeFakeStreamBrokerCap()
    streamBrokerCap.register(1, 'provider-rtsp', streams)

    const settingsNoMotionSource = { ...DEFAULT_DEVICE_SETTINGS } as Partial<
      typeof DEFAULT_DEVICE_SETTINGS
    >
    delete settingsNoMotionSource.motionSources

    const { ctx, eventBus } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialDeviceSettings: new Map([[1, settingsNoMotionSource as Record<string, unknown>]]),
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
      providers: { 'stream-broker': streamBrokerCap },
      // No native-cap seed — getNativeProvider throws, resolver treats
      // the absence as "no onboard cap" and falls through to the default.
    })

    addon = new PipelineOrchestratorAddon()
    await addon.initialize(ctx)

    eventBus.emit({
      id: 'evt-1',
      timestamp: new Date(),
      source: { type: 'device', id: 1 },
      category: EventCategory.CameraStreamsProfileSlotsChanged,
      data: { deviceId: 1, providerId: 'provider-rtsp' },
    })

    await waitUntil(() => runner.attachedCameras.has(1))
    expect(runner.attachedCameras.get(1)!.motionSources).toEqual(['analyzer'])
  })
})
