/**
 * Integration-light tests for the orchestrator's camera-status aggregator cap:
 * `getCameraStatus` and `getCameraStatuses`.
 *
 * These tests verify:
 *   (a) Normal path: all stages present → payload shape conforms to CameraStatus.
 *   (b) Degradation: one stage rejects + another times out → those blocks are null,
 *       others populated, and the call resolves (never throws).
 *   (c) Bulk: `getCameraStatuses` with two deviceIds → array of two CameraStatus.
 *   (d) A stage that was CUT SHORT is named in `degraded` and logged at `warn`
 *       with `tags.deviceId` — a `null` block that means "we could not read
 *       this" must never be indistinguishable from one that means "there is
 *       nothing here".
 *
 * The `ctx.api` stubs mirror the same tRPC-shaped `{ query, mutate }` leaf pattern
 * used in the existing e2e-helpers fake context (see e2e-helpers.ts).
 */

import type {
  AddonApi,
  CameraStatus,
  CameraSwitchDerivationInput,
  IScopedLogger,
  PipelineAssignment,
  RunnerCameraConfig,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CameraStatusServiceDeps } from '../camera-status-service.js'
import { CameraStatusService } from '../camera-status-service.js'
import PipelineOrchestratorAddon from '../index.js'
import type { AudioNodeAssignment } from '../orchestrator-types.js'
import { RepeatWarnSampler } from '../repeat-warn-sampler.js'
import { healthyAuthorities } from './camera-status-switch-authorities.js'
import { enabledNodesFromBroker, makeFakeBroker, makeFakeContext } from './e2e-helpers.js'

// ── Helpers ────────────────────────────────────────────────────────────────────

/** tRPC leaf that resolves with a fixed value. */
function okLeaf<T>(val: T): {
  query: (input?: unknown) => Promise<T>
  mutate: (input?: unknown) => Promise<T>
} {
  return {
    query: () => Promise.resolve(val),
    mutate: () => Promise.resolve(val),
  }
}

/** tRPC leaf that rejects with a fixed error. */
function rejectLeaf(msg: string): { query: () => Promise<never>; mutate: () => Promise<never> } {
  return {
    query: () => Promise.reject(new Error(msg)),
    mutate: () => Promise.reject(new Error(msg)),
  }
}

/** Minimal profile-slot list for deviceId 10. */
const DEVICE_ID = 10
const FAKE_SLOTS = [
  {
    deviceId: DEVICE_ID,
    profile: 'high' as const,
    brokerId: `${DEVICE_ID}/high`,
    sourceCamStreamId: 'native:main',
    status: 'streaming' as const,
    codec: 'H264',
    resolution: { width: 1920, height: 1080 },
  },
]

/** Minimal BrokerStats for one profile slot. */
const FAKE_BROKER_STATS = {
  status: 'streaming',
  inputFps: 15,
  encodedSubscribers: 2,
  uptimeMs: 60_000,
  bitrateKbps: 4000,
  idrIntervalMs: 2000,
  codec: 'H264',
  totalBytes: 1_000_000,
  packetCount: 5000,
  rtspClients: 0,
  pipeClients: 0,
  preBufferSec: 5,
  preBufferMs: 5000,
  preBufferPackets: 75,
}

/** Minimal BrokerClients response. */
const FAKE_BROKER_CLIENTS = {
  rtsp: [],
  audio: [],
  encoded: [],
  pipeClients: 0,
  encodedSubscribers: 2,
}

/** Minimal EngineProvisioning. */
const FAKE_PROVISIONING = {
  runtimeId: 'onnx' as const,
  device: 'cpu',
  state: 'ready' as const,
}

/** Minimal engine selection. */
const FAKE_ENGINE = { runtime: 'python' as const, backend: 'onnx', format: 'onnx' as const }

/** Minimal CameraMetrics (runner). */
const FAKE_CAMERA_METRICS = {
  detectionMode: 'on-motion' as const,
  configuredFps: 10,
  actualFps: 9,
  queueDepth: 1,
  avgInferenceTimeMs: 35,
  droppedFrames: 0,
  phase: 'active' as const,
}

/** Minimal recording status. */
const FAKE_RECORDING_STATUS = {
  deviceId: DEVICE_ID,
  enabled: true,
  activeMode: 'continuous' as const,
  nodeId: 'hub',
  storageBytes: 1_024,
}

/**
 * Build a fake `ctx.api` with all stage stubs wired to return happy-path data.
 * Pass overrides to replace individual leaves (e.g. to inject a rejection or hang).
 */
function makeFakeApi(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    streamBroker: {
      listAllProfileSlots: okLeaf(FAKE_SLOTS),
      getBrokerStats: okLeaf(FAKE_BROKER_STATS),
      listClients: okLeaf(FAKE_BROKER_CLIENTS),
      getAllRtspEntries: okLeaf([
        {
          brokerId: `${DEVICE_ID}/high`,
          url: `rtsp://localhost/stream`,
          mutedUrl: `rtsp://localhost/stream-muted`,
          enabled: true,
        },
      ]),
    },
    decoder: {
      listActiveSessions: okLeaf([
        { sessionId: 'sess-1', codec: 'H264', outputFormat: 'yuv420', createdAtMs: Date.now() },
      ]),
      getInfo: okLeaf({ id: 'decoder-nodeav', name: 'node-av decoder' }),
    },
    pipelineExecutor: {
      getEngineProvisioning: okLeaf(FAKE_PROVISIONING),
      getSelectedEngine: okLeaf(FAKE_ENGINE),
      // getSchema is needed by some orchestrator paths — provide a minimal stub.
      getSchema: okLeaf({ slots: [], availableEngines: [], selectedEngine: FAKE_ENGINE }),
    },
    pipelineRunner: {
      getCameraMetrics: okLeaf(FAKE_CAMERA_METRICS),
      attachCamera: okLeaf({ success: true as const }),
      detachCamera: okLeaf({ success: true as const }),
      getLocalLoad: okLeaf({
        nodeId: 'hub',
        attachedCameras: 1,
        activeCameras: 1,
        avgInferenceFps: 10,
        avgInferenceTimeMs: 35,
        queueDepthTotal: 0,
        hardware: { hasGpu: false },
      }),
      reportMotion: okLeaf({ success: true as const }),
      // Fixed 2026-09-14: this namespace REPLACES (not merges with) the base
      // fake context's `pipelineRunner`, and was missing `getLocalCameras` —
      // the orchestrator's background placement-reconcile timer calls it on
      // every tick, so any test in this file that boots the addon and lives
      // long enough for that timer to fire threw an unhandled rejection
      // (`Cannot read properties of undefined (reading 'query')` at
      // reconcile-controller.ts:346) that vitest attributed to whichever test
      // happened to be running at the time. Test-fake gap, not a flake — see
      // the same omission below in the "unknown/empty data" override.
      getLocalCameras: okLeaf([]),
    },
    recordingArchive: {
      getStatus: okLeaf(FAKE_RECORDING_STATUS),
    },
    // deviceManager stub — needed for orchestrator init.
    deviceManager: {
      listAll: okLeaf([]),
      getBindings: okLeaf({ deviceId: DEVICE_ID, entries: [] }),
      setWrapperActive: okLeaf(undefined),
    },
    // audioAnalyzer / audioAnalysis stubs.
    audioAnalyzer: {
      analyseChunk: okLeaf(null),
      classify: okLeaf({ labels: [], rawLabels: [], inferenceMs: 0 }),
      isReady: okLeaf(false),
      dispose: okLeaf(undefined),
    },
    audioAnalysis: {
      resolveDeviceSettings: okLeaf(null),
    },
    audioClassifier: {
      isReady: okLeaf(true),
    },
    notificationOutput: {
      send: okLeaf(undefined),
      sendTest: okLeaf(undefined),
    },
  }

  // Apply overrides at the top level — callers can replace whole namespaces.
  for (const [key, value] of Object.entries(overrides)) {
    base[key] = value
  }
  return base
}

/**
 * Reach into the orchestrator's `PlacementLedger` (S6 extraction —
 * `placement-ledger.ts`) to seed assignment/config state directly, mirroring
 * what the old direct `assignments.set`/`cameraConfigs.set` casts did before
 * that state moved off the addon class.
 */
interface TestOrchestratorInternals {
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
    setConfig(
      deviceId: number,
      config: {
        deviceId: number
        motionFps: number
        motionSources: string[]
        detectionMode: string
        audioMode: string
        motionCooldownMs: number
        detectionFps: number
        motionStreamId: string
        detectionStreamId: string
        pipelineEnabled: boolean
        onboardMotionDrivesAnalyzer: boolean
        occupancyRecheckEnabled: boolean
        occupancyRecheckSec: number
        occupancyRecheckFrames: number
        deviceKey?: string
      },
    ): void
  }
}

/**
 * Boot the orchestrator with a minimal fake broker + the given fakeApi,
 * then manually inject a pipeline assignment for the test device so
 * `getCameraStatus` can find it via the placement ledger.
 */
async function bootWithAssignment(
  fakeApi: Record<string, unknown>,
  deviceId: number = DEVICE_ID,
  deviceKey?: string,
): Promise<{ addon: PipelineOrchestratorAddon }> {
  const broker = makeFakeBroker('hub')
  const { ctx } = makeFakeContext({
    addonConfig: { moleculerBroker: broker },
    initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
  })

  // Patch the fake context's api with our custom stub.
  // The ctx.api is cast via `as` in makeFakeContext; we can reassign safely.
  // MERGE, never replace: `makeFakeContext` supplies the doors every boot path
  // needs (notably `settingsStore`, which the orchestrator's durable stores
  // declare against). A wholesale replacement drops them and the addon fails
  // to initialize for a reason that has nothing to do with the test.
  ;(ctx as { api: Record<string, unknown> }).api = {
    ...(ctx.api as unknown as Record<string, unknown>),
    ...fakeApi,
  }

  const addon = new PipelineOrchestratorAddon()
  await addon.initialize(ctx)

  // Manually inject a pipeline assignment so getCameraStatus can find it.
  // We reach into the placement ledger via `dispatchCamera` path equivalent:
  // inject directly using the public test hook that `ledger` exposes.
  // The safest way: call getPipelineAssignment first to confirm it's empty,
  // then simulate what dispatchCamera would have left behind by calling the
  // public `assignPipeline` path (which writes to settings + sets the map).
  // However, `assignPipeline` tries to re-dispatch which requires a runner —
  // instead, use the fact that the ledger's raw `seedAssignment`/`setConfig`
  // seams are writable directly. Given the orchestrator's architecture, the
  // cleanest approach for tests is a direct cast to the ledger.
  const addonInternal = addon as unknown as TestOrchestratorInternals

  addonInternal.ledger.seedAssignment(deviceId, {
    deviceId,
    agentNodeId: 'hub',
    pinned: false,
    reason: 'capacity',
    assignedAt: Date.now(),
  })

  addonInternal.ledger.setConfig(deviceId, {
    deviceId,
    motionFps: 4,
    motionSources: ['analyzer'],
    detectionMode: 'on-motion',
    audioMode: 'always-on',
    motionCooldownMs: 10_000,
    detectionFps: 10,
    motionStreamId: 'sub',
    detectionStreamId: 'main',
    pipelineEnabled: true,
    onboardMotionDrivesAnalyzer: false,
    occupancyRecheckEnabled: true,
    occupancyRecheckSec: 30,
    occupancyRecheckFrames: 4,
    ...(deviceKey ? { deviceKey } : {}),
  })

  return { addon }
}

// ── Test suites ────────────────────────────────────────────────────────────────

describe('PipelineOrchestrator — getCameraStatus (normal path)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('returns a populated CameraStatus payload with all blocks present', async () => {
    const { addon: a } = await bootWithAssignment(makeFakeApi())
    addon = a

    const status: CameraStatus = await addon.getCameraStatus({ deviceId: DEVICE_ID })

    expect(status.deviceId).toBe(DEVICE_ID)
    expect(typeof status.fetchedAt).toBe('number')
    expect(status.fetchedAt).toBeGreaterThan(0)

    // assignment block is always present
    expect(status.assignment.detectionNodeId).toBe('hub')
    expect(status.assignment.pinned.detection).toBe(false)
    expect(status.assignment.pinned.decoder).toBe(false)
    expect(status.assignment.pinned.audio).toBe(false)

    // source block is always present
    expect(status.source.streams).toBeDefined()

    // broker block should be populated (happy path)
    expect(status.broker).not.toBeNull()
    expect(Array.isArray(status.broker?.profiles)).toBe(true)

    // decoder block should be populated
    expect(status.decoder).not.toBeNull()
    // Only the node: no fabricated frame / session counters (they read 0
    // forever and raised a false "decode path stalled" on every camera).
    expect(status.decoder).toEqual({ nodeId: 'hub' })

    // motion block — derived from cached RunnerCameraConfig
    expect(status.motion).not.toBeNull()
    expect(status.motion?.enabled).toBe(true)
    expect(status.motion?.fps).toBe(4)

    // detection block should be populated
    expect(status.detection).not.toBeNull()
    expect(status.detection?.nodeId).toBe('hub')
    expect(status.detection?.phase).toBe('active')
    expect(status.detection?.provisioning.state).toBe('ready')

    // recording block should be populated
    expect(status.recording).not.toBeNull()
    expect(status.recording?.mode).toBe('continuous')
    expect(status.recording?.active).toBe(true)
    expect(status.recording?.storageBytes).toBe(1_024)
  })

  it('reports the node default engine when the camera has no deviceKey', async () => {
    // FAKE_ENGINE.backend = 'onnx'; no deviceKey on the config → the reported
    // engine falls back to the node's `getSelectedEngine`.
    const { addon: a } = await bootWithAssignment(makeFakeApi())
    addon = a

    const status: CameraStatus = await addon.getCameraStatus({ deviceId: DEVICE_ID })

    expect(status.detection?.engine).toEqual({ backend: 'onnx', device: '' })
  })

  it('reports the camera-elected deviceKey pool, NOT the node default engine', async () => {
    // Regression for the multi-device status-reporting bug: a camera pinned to
    // `edgetpu:usb` had its sessions routed to the Coral pool via
    // `runPipeline({deviceKey})`, but `getCameraStatus` reported the node's
    // `getSelectedEngine` (`onnx`/`openvino:npu`), masking WHICH device ran the
    // session (and, when that pool failed to init, masking that it produced
    // nothing). The status must reflect the camera's own deviceKey.
    const { addon: a } = await bootWithAssignment(makeFakeApi(), DEVICE_ID, 'edgetpu:usb')
    addon = a

    const status: CameraStatus = await addon.getCameraStatus({ deviceId: DEVICE_ID })

    // Node default engine is `onnx` (FAKE_ENGINE) — the report must NOT be that.
    expect(status.detection?.engine).toEqual({ backend: 'edgetpu', device: 'usb' })
  })
})

describe('PipelineOrchestrator — getCameraStatus (degradation)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('one stage rejects + another hangs → those blocks are null, others populated, call resolves', async () => {
    // broker stage rejects; recording stage hangs (simulates timeout at 3s,
    // but boundedStage timeout is 3000ms — we use a much shorter timeout in
    // the test by overriding the implementation via the hang leaf).
    // To make the test fast, we need the hang to resolve quickly.
    // We'll rely on the fact that the boundedStage timeout is 3s, but since
    // we don't want a 3s test, we test with a reject + a manual null override
    // instead of a real hang.
    //
    // For the true hang + timeout test, we replace the timeout value by
    // testing with a stage that rejects (reject = fast) + a stage that
    // returns null explicitly (simulating a pre-null result).
    const fakeApi = makeFakeApi({
      // broker stage → rejects
      streamBroker: {
        listAllProfileSlots: rejectLeaf('broker unavailable'),
        getBrokerStats: rejectLeaf('broker unavailable'),
        listClients: rejectLeaf('broker unavailable'),
        getAllRtspEntries: rejectLeaf('broker unavailable'),
      },
      // recording stage → rejects (simulates timeout / node offline)
      recordingArchive: {
        getStatus: rejectLeaf('recording node offline'),
      },
    })

    const { addon: a } = await bootWithAssignment(fakeApi)
    addon = a

    const status: CameraStatus = await addon.getCameraStatus({ deviceId: DEVICE_ID })

    // The call must NEVER throw even when stages fail.
    expect(status.deviceId).toBe(DEVICE_ID)

    // broker and source stages use listAllProfileSlots — both degrade to null/empty.
    expect(status.broker).toBeNull()

    // recording stage degraded to null
    expect(status.recording).toBeNull()

    // motion block is orchestrator-local — never null when a config is cached
    expect(status.motion).not.toBeNull()

    // detection block used pipelineExecutor + pipelineRunner — should be populated
    expect(status.detection).not.toBeNull()
    expect(status.detection?.nodeId).toBe('hub')

    // assignment always present
    expect(status.assignment.detectionNodeId).toBe('hub')
  })

  it('returns null blocks for stages that receive unknown/empty data', async () => {
    const fakeApi = makeFakeApi({
      pipelineExecutor: {
        getEngineProvisioning: rejectLeaf('executor offline'),
        getSelectedEngine: rejectLeaf('executor offline'),
        getSchema: okLeaf({ slots: [], availableEngines: [], selectedEngine: FAKE_ENGINE }),
      },
      pipelineRunner: {
        getCameraMetrics: okLeaf(null),
        attachCamera: okLeaf({ success: true as const }),
        detachCamera: okLeaf({ success: true as const }),
        getLocalLoad: okLeaf({
          nodeId: 'hub',
          attachedCameras: 1,
          activeCameras: 1,
          avgInferenceFps: 10,
          avgInferenceTimeMs: 35,
          queueDepthTotal: 0,
          hardware: { hasGpu: false },
        }),
        reportMotion: okLeaf({ success: true as const }),
        // See the same fix + rationale on the base `pipelineRunner` above.
        getLocalCameras: okLeaf([]),
      },
    })

    const { addon: a } = await bootWithAssignment(fakeApi)
    addon = a

    const status: CameraStatus = await addon.getCameraStatus({ deviceId: DEVICE_ID })

    expect(status.deviceId).toBe(DEVICE_ID)
    // detection block — executor rejected but pipelineRunner returned null metrics;
    // the detection stage catches exceptions and falls back to a degraded result
    // with zeros. Since getEngineProvisioning rejects, provisioning.state = 'idle'.
    // The stage itself resolves (errors are caught internally), so detection is
    // not null but has degraded fields.
    expect(typeof status.fetchedAt).toBe('number')
    // broker + recording are unaffected — happy path
    expect(status.broker).not.toBeNull()
    expect(status.recording).not.toBeNull()
  })

  it('TIMEOUT branch: stage that never resolves → that block is null, others populated, call resolves', async () => {
    // This test exercises boundedStage's TIMEOUT path (not just rejection):
    // the recording stage returns a never-resolving promise; fake timers
    // advance past STAGE_TIMEOUT_MS (3 000 ms) so the timeout fires
    // and boundedStage resolves to null for that stage. The other stages
    // complete normally — the overall getCameraStatus call must resolve (not throw).
    vi.useFakeTimers()
    try {
      const hangLeaf: {
        query: (input?: unknown) => Promise<never>
        mutate: (input?: unknown) => Promise<never>
      } = {
        query: () =>
          new Promise<never>(() => {
            /* intentionally never resolves */
          }),
        mutate: () =>
          new Promise<never>(() => {
            /* intentionally never resolves */
          }),
      }

      const fakeApi = makeFakeApi({
        recordingArchive: { getStatus: hangLeaf },
      })

      const { addon: a } = await bootWithAssignment(fakeApi)
      addon = a

      // Start the call — it will be awaiting the recording stage's timeout.
      const statusPromise: Promise<CameraStatus> = addon.getCameraStatus({ deviceId: DEVICE_ID })

      // Advance fake timers past the STAGE_TIMEOUT_MS (3 000 ms).
      // advanceTimersByTimeAsync flushes microtasks for each tick,
      // allowing the setTimeout → resolve(null) → Promise.race chain
      // inside boundedStage to settle without touching recurring timers.
      await vi.advanceTimersByTimeAsync(4_000)

      const status = await statusPromise

      // The call must resolve (never throw) even with a hung stage.
      expect(status.deviceId).toBe(DEVICE_ID)

      // recording block timed out → null
      expect(status.recording).toBeNull()

      // …and the null is NAMED. A timed-out stage and a stage that simply has
      // nothing to report both produce `null`; without this marker a 3 s hang
      // is invisible on the wire, which is how two cameras spent every status
      // call stalled without anyone noticing.
      expect(status.degraded).toContainEqual(
        expect.objectContaining({ stage: 'recording', reason: 'timeout' }),
      )

      // Other stages (broker, motion, detection) should be populated since
      // they resolved normally before or independent of the timeout.
      expect(status.broker).not.toBeNull()
      expect(status.motion).not.toBeNull()
      expect(status.detection).not.toBeNull()

      // assignment is always present
      expect(status.assignment.detectionNodeId).toBe('hub')
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('PipelineOrchestrator — getCameraStatuses (bulk)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('returns an array of 2 CameraStatus for 2 deviceIds', async () => {
    const DEVICE_ID_2 = 20
    const { addon: a } = await bootWithAssignment(makeFakeApi())
    addon = a

    // Inject a second assignment for device 20.
    const addonInternal = addon as unknown as TestOrchestratorInternals

    addonInternal.ledger.seedAssignment(DEVICE_ID_2, {
      deviceId: DEVICE_ID_2,
      agentNodeId: 'hub',
      pinned: true,
      reason: 'manual',
      assignedAt: Date.now(),
    })
    addonInternal.ledger.setConfig(DEVICE_ID_2, {
      deviceId: DEVICE_ID_2,
      motionFps: 2,
      motionSources: ['onboard'],
      detectionMode: 'always-on',
      audioMode: 'always-on',
      motionCooldownMs: 5_000,
      detectionFps: 5,
      motionStreamId: 'sub',
      detectionStreamId: 'main',
      pipelineEnabled: true,
      onboardMotionDrivesAnalyzer: true,
      occupancyRecheckEnabled: true,
      occupancyRecheckSec: 15,
      occupancyRecheckFrames: 2,
    })

    const statuses = await addon.getCameraStatuses({ deviceIds: [DEVICE_ID, DEVICE_ID_2] })

    expect(Array.isArray(statuses)).toBe(true)
    expect(statuses).toHaveLength(2)

    const ids = statuses.map((s) => s.deviceId)
    expect(ids).toContain(DEVICE_ID)
    expect(ids).toContain(DEVICE_ID_2)

    // Each entry must have the required top-level shape.
    for (const s of statuses) {
      expect(typeof s.deviceId).toBe('number')
      expect(s.assignment).toBeDefined()
      expect(s.source).toBeDefined()
      expect(typeof s.fetchedAt).toBe('number')
    }
  })

  it('defaults to all assignments when deviceIds is omitted', async () => {
    const { addon: a } = await bootWithAssignment(makeFakeApi())
    addon = a

    const statuses = await addon.getCameraStatuses({})

    // We injected exactly 1 assignment (DEVICE_ID).
    expect(statuses).toHaveLength(1)
    expect(statuses[0]?.deviceId).toBe(DEVICE_ID)
  })

  it('returns empty array when no deviceIds provided and no assignments exist', async () => {
    const broker = makeFakeBroker('hub')
    const fakeApi = makeFakeApi()
    const { ctx } = makeFakeContext({
      addonConfig: { moleculerBroker: broker },
      initialGlobalSettings: { enabledNodes: enabledNodesFromBroker(broker) },
    })
    // MERGE, never replace: `makeFakeContext` supplies the doors every boot path
    // needs (notably `settingsStore`, which the orchestrator's durable stores
    // declare against). A wholesale replacement drops them and the addon fails
    // to initialize for a reason that has nothing to do with the test.
    ;(ctx as { api: Record<string, unknown> }).api = {
      ...(ctx.api as unknown as Record<string, unknown>),
      ...fakeApi,
    }

    const a = new PipelineOrchestratorAddon()
    await a.initialize(ctx)
    addon = a

    const statuses = await addon.getCameraStatuses({})
    expect(statuses).toHaveLength(0)
  })
})

// ── T6: decoder surface reports REALITY (broker's live decode-session node) ─────

/** Full streamBroker namespace with a getBrokerStats override (preserves the rest). */
function streamBrokerWith(
  brokerStats: Record<string, unknown>,
): Record<string, ReturnType<typeof okLeaf>> {
  return {
    listAllProfileSlots: okLeaf(FAKE_SLOTS),
    getBrokerStats: okLeaf(brokerStats),
    listClients: okLeaf(FAKE_BROKER_CLIENTS),
    getAllRtspEntries: okLeaf([]),
  }
}

describe('PipelineOrchestrator — getCameraStatus (T6 decoder truth)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it("assignment.decoderNodeId is the DETECTION node, co-located by construction (reasons.decoder='co-located')", async () => {
    // The broker decodes nothing (D762). A broker from before that change
    // still reports a `decoderNodeId` from its dead frame plane — the status
    // must not take it as the decode placement.
    const { addon: a } = await bootWithAssignment(
      makeFakeApi({
        streamBroker: streamBrokerWith({ ...FAKE_BROKER_STATS, decoderNodeId: 'mac-mini' }),
      }),
    )
    addon = a

    const status: CameraStatus = await addon.getCameraStatus({ deviceId: DEVICE_ID })

    expect(status.assignment.decoderNodeId).toBe('hub')
    expect(status.assignment.reasons.decoder).toBe('co-located')
  })
})

// ── The broker profile carries only the counters something feeds (D758) ─────

describe('PipelineOrchestrator — getCameraStatus (broker profile counters)', () => {
  let addon: PipelineOrchestratorAddon | null = null

  afterEach(async () => {
    if (addon) await addon.shutdown()
    addon = null
  })

  it('serves the input rate and no output rate — nothing on the frame path feeds one', async () => {
    // The broker's `decodeFps` was its frame plane's rate (removed, D762);
    // decoding runs in the session decode workers, so it was 0 on every live
    // camera and was rendered as "15→0fps".
    const { addon: a } = await bootWithAssignment(makeFakeApi())
    addon = a

    const status: CameraStatus = await addon.getCameraStatus({ deviceId: DEVICE_ID })

    expect(status.broker?.profiles).toEqual([
      {
        profile: 'high',
        status: 'streaming',
        codec: 'H264',
        width: 1920,
        height: 1080,
        subscribers: 2,
        inFps: 15,
      },
    ])
  })

  it('reports the input rate as unknown, never 0, when the broker stats read fails', async () => {
    const { addon: a } = await bootWithAssignment(
      makeFakeApi({
        streamBroker: {
          ...streamBrokerWith(FAKE_BROKER_STATS),
          getBrokerStats: rejectLeaf('broker stats unavailable'),
        },
      }),
    )
    addon = a

    const status: CameraStatus = await addon.getCameraStatus({ deviceId: DEVICE_ID })

    expect(status.broker?.profiles[0]?.inFps).toBeNull()
  })
})

// ── A stage CUT SHORT is named on the wire and logged ───────────────────────
//
// `boundedStage` used to return `null` on timeout AND on rejection, and the
// caller put that `null` straight into the payload. Three different facts —
// "it timed out", "it failed", "there is genuinely nothing here" — arrived as
// one indistinguishable value, and nothing was logged, so a 3 s hang produced
// not one line. These tests pin the distinction at the service level, where
// the bound is applied.

const SWITCH_DEVICE_ID = 105

/** Audio assignment so the (orchestrator-local) audio block is composed. */
const SWITCH_AUDIO_ASSIGNMENT: AudioNodeAssignment = {
  deviceId: SWITCH_DEVICE_ID,
  nodeId: 'hub',
  pinned: false,
  assignedAt: 0,
}

/** A logger whose `warn` calls the test can assert on. */
function makeSpyLogger(): { logger: IScopedLogger; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn()
  const logger: IScopedLogger = {
    debug: () => {},
    info: () => {},
    warn,
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  return { logger, warn }
}

/**
 * Every authority readable, every function on — nothing switched off.
 *
 * RAW authority facts, never a pre-derived group: the badge is composed from
 * these by the service itself (D113), and a fake that supplied the derived
 * answer would be the fake that hides the derivation production forgot.
 */
function healthyReads(
  patch: Partial<CameraSwitchDerivationInput> = {},
): CameraSwitchDerivationInput {
  return healthyAuthorities(SWITCH_DEVICE_ID, patch)
}

/**
 * Service with NO api — every remote stage is skipped (not attempted), so the
 * only stage that can degrade is the injected switch read. That is exactly the
 * discrimination under test: a skipped stage is `null` WITHOUT a marker; a cut
 * short stage is `null` WITH one.
 */
function makeLocalService(overrides: Partial<CameraStatusServiceDeps>): CameraStatusService {
  const { logger: silent } = makeSpyLogger()
  return new CameraStatusService({
    api: (): AddonApi => null as never,
    logger: silent,
    warnSampler: new RepeatWarnSampler(),
    getAssignment: (): PipelineAssignment | null => null,
    getAudioAssignment: (): AudioNodeAssignment | null => SWITCH_AUDIO_ASSIGNMENT,
    getCameraConfig: (): RunnerCameraConfig | null => null,
    hasCameraConfig: (): boolean => true,
    getPendingReason: (): string | undefined => undefined,
    assignSource: (): string => 'hub',
    listAssignedDeviceIds: (): readonly number[] => [SWITCH_DEVICE_ID],
    isSessionCamera: (): boolean => false,
    switchAuthoritiesFor: async (): Promise<CameraSwitchDerivationInput> => healthyReads(),
    cameraSensorsFor: () => ({ state: 'not-configured' }),
    ...overrides,
  })
}

function makeSwitchService(
  switchAuthoritiesFor: () => Promise<CameraSwitchDerivationInput>,
  logger: IScopedLogger,
): CameraStatusService {
  return makeLocalService({ switchAuthoritiesFor, logger })
}

describe('CameraStatus — a bounded stage that was cut short', () => {
  it('is NOT marked when the stage simply had nothing to report', async () => {
    const { logger, warn } = makeSpyLogger()
    const service = makeSwitchService(async () => healthyReads(), logger)

    const status = await service.getCameraStatus(SWITCH_DEVICE_ID)

    // Remote blocks are null because there is no api — nothing was attempted,
    // so nothing was cut short. An empty `degraded` is what makes every OTHER
    // null in this payload readable as "there is nothing here".
    expect(status.broker).toBeNull()
    expect(status.recording).toBeNull()
    expect(status.degraded).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })

  it('a TIMED-OUT switch read must not claim the operator switched nothing off', async () => {
    vi.useFakeTimers()
    try {
      const { logger, warn } = makeSpyLogger()
      const service = makeSwitchService(
        () =>
          new Promise<CameraSwitchDerivationInput>(() => {
            /* never resolves */
          }),
        logger,
      )

      const statusPromise = service.getCameraStatus(SWITCH_DEVICE_ID)
      await vi.advanceTimersByTimeAsync(4_000)
      const status = await statusPromise

      // The list stays empty (it is not a guess), but the payload now says WHY
      // it is empty. Rendering this as "nothing is switched off" contradicts
      // D62: a camera we could not read must never be painted as broken.
      expect(status.switchedOff).toEqual([])
      expect(status.degraded).toContainEqual(
        expect.objectContaining({ stage: 'switches', reason: 'timeout' }),
      )

      // …and the hang is findable in Loki, per-camera.
      expect(warn).toHaveBeenCalledTimes(1)
      expect(warn).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          tags: { deviceId: SWITCH_DEVICE_ID },
          meta: expect.objectContaining({ stage: 'switches', reason: 'timeout' }),
        }),
      )
    } finally {
      vi.useRealTimers()
    }
  })

  it('distinguishes a REJECTION from a timeout', async () => {
    const { logger, warn } = makeSpyLogger()
    const service = makeSwitchService(
      () => Promise.reject(new Error('switch source offline')),
      logger,
    )

    const status = await service.getCameraStatus(SWITCH_DEVICE_ID)

    expect(status.switchedOff).toEqual([])
    expect(status.degraded).toContainEqual(
      expect.objectContaining({ stage: 'switches', reason: 'error' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: { deviceId: SWITCH_DEVICE_ID },
        meta: expect.objectContaining({ stage: 'switches', reason: 'error' }),
      }),
    )
  })

  it('marks a PARTIAL switch read — the derived list is a floor, not a total', async () => {
    // The live 614 case, one level down. `readSwitchAuthorities` bounds each of
    // its eight sources individually, so a slow source no longer costs the whole
    // read — it nulls ITS fact and leaves the rest. The badge composed from what
    // came back is then a FLOOR: `recording` here could be off and we would not
    // know, and the operator HAD switched it off.
    const { logger, warn } = makeSpyLogger()
    const service = makeSwitchService(
      async (): Promise<CameraSwitchDerivationInput> =>
        healthyReads({ recordingEnabled: null, deviceDisabled: true }),
      logger,
    )

    const status = await service.getCameraStatus(SWITCH_DEVICE_ID)

    // What WAS read is still reported — a partial read is not a failed one.
    expect(status.switchedOff).toEqual(['stream-broker'])
    expect(status.degraded).toContainEqual(
      expect.objectContaining({ stage: 'switches', reason: 'partial' }),
    )
    expect(warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        tags: { deviceId: SWITCH_DEVICE_ID },
        meta: expect.objectContaining({ stage: 'switches', reason: 'partial' }),
      }),
    )
  })

  it('a function this camera simply does not HAVE is not a degraded read', async () => {
    // The opposite mistake: "this camera has no microphone" and "this
    // deployment has no audio analyzer" are real answers, not gaps. Marking
    // them would make every camera permanently degraded and the marker would
    // stop meaning anything.
    const { logger, warn } = makeSpyLogger()
    const service = makeSwitchService(
      async (): Promise<CameraSwitchDerivationInput> =>
        healthyReads({
          deviceAudio: { supported: false, enabled: null },
          bindableCapNames: ['detection-pipeline'],
          activeWrapperCapNames: ['detection-pipeline'],
        }),
      logger,
    )

    const status = await service.getCameraStatus(SWITCH_DEVICE_ID)

    expect(status.degraded).toEqual([])
    expect(warn).not.toHaveBeenCalled()
  })
})

// ── An ARMED camera is not an unknown one ──────────────────────────────────
//
// The same defect one row over: three different situations were arriving as
// one indistinguishable payload (`detectionNodeId: null`, `reasons: {}`).
//
//  - ARMED — an `on-motion` camera between motion events. It holds NO
//    `cameraConfigs` entry BY DESIGN (`SessionDispatchController` records an
//    assignment without `ledger.setConfig`; an entry there would wedge
//    `decideSessionAction` into permanent 'ignore', and
//    `standing-machinery-on-motion-scope.spec.ts` guards that). It is healthy
//    and waiting.
//  - PENDING — a STANDING camera the orchestrator knows and could not place.
//  - UNKNOWN — a camera the orchestrator has never heard of.
//
// Camera 103 on 2026-08-08 is the live case: motion at 22:12:39, assignment at
// 22:12:41, released 22:13:15 — one clean round trip on the cooldown, not a
// fault. Between those windows it rendered exactly like a camera that had
// never been dispatched.
//
// NOTE the boundary: `buildAssignmentContext` is SYNCHRONOUS and issues no
// remote call, so none of this is a bounded stage and none of it may appear in
// `degraded`. An armed camera is fully READ — it is simply idle.

describe('CameraStatus.assignment.reasons.detection', () => {
  it('names an ARMED on-motion camera, instead of leaving it indistinguishable from unknown', async () => {
    const service = makeLocalService({
      // On-motion cameras hold no cached config — that is the design, not a gap.
      hasCameraConfig: (): boolean => false,
      isSessionCamera: (): boolean => true,
    })

    const status = await service.getCameraStatus(SWITCH_DEVICE_ID)

    expect(status.assignment.detectionNodeId).toBeNull()
    expect(status.assignment.reasons.detection).toBe('armed:on-motion')
    // Armed is a LIFECYCLE state that was read successfully — never a stage
    // that could not be read.
    expect(status.degraded).toEqual([])
  })

  it('names the REFUSED session of an armed camera as pending:<reason>, not armed', async () => {
    // D650 round 4: an on-motion camera whose every session is refused (its
    // elected device cannot run the camera root) holds no config and no
    // assignment, exactly like a healthy armed one. The session path's last
    // refusal reaches the same surface a standing camera's pending reason
    // does, so the operator sees WHY nothing detects.
    const service = makeLocalService({
      hasCameraConfig: (): boolean => false,
      getPendingReason: (): string | undefined => 'root-unrunnable:hub/coreml:ane',
      isSessionCamera: (): boolean => true,
    })

    const status = await service.getCameraStatus(SWITCH_DEVICE_ID)

    expect(status.assignment.reasons.detection).toBe('pending:root-unrunnable:hub/coreml:ane')
    expect(status.degraded).toEqual([])
  })

  it('still says pending:<reason> for a STANDING camera it could not place', async () => {
    const service = makeLocalService({
      hasCameraConfig: (): boolean => true,
      getPendingReason: (): string | undefined => 'over-cap',
      isSessionCamera: (): boolean => true,
    })

    const status = await service.getCameraStatus(SWITCH_DEVICE_ID)

    expect(status.assignment.reasons.detection).toBe('pending:over-cap')
  })

  it('says nothing for a camera the orchestrator has never heard of', async () => {
    const service = makeLocalService({
      hasCameraConfig: (): boolean => false,
      isSessionCamera: (): boolean => false,
    })

    const status = await service.getCameraStatus(SWITCH_DEVICE_ID)

    expect(status.assignment.reasons.detection).toBeUndefined()
  })
})
