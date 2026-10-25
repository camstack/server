/**
 * What ONE `getCameraStatuses` poll COSTS, expressed as round trips.
 *
 * The admin Cameras page polls `pipelineOrchestrator.getCameraStatuses({})`
 * every 5 seconds, and the server answers it with
 * `Promise.all(ids.map(getCameraStatus))`. Each of those composes seven stages
 * out of a cross-node fan-out — and six of the questions in that fan-out are
 * not about the camera at all:
 *
 *   `streamBroker.listAllProfileSlots`   — the whole node's slot table
 *   `streamBroker.getAllRtspEntries`     — the whole node's restream table
 *   `notificationRules.listDeviceMutes`  — the whole fleet's mute list
 *   `pipelineExecutor.getEngineProvisioning` / `getSelectedEngine` — per NODE
 *   `deviceManager.listBindableCapsForDeviceType` — per device TYPE
 *
 * Asked once per camera, they were N identical questions with N identical
 * answers, on a five-second timer. Two more — the device row and the binding
 * table — are per-camera questions the device manager already answers for a
 * SET (`listAll({deviceIds})`, `getBindingsBatch({deviceIds})`), so they are
 * one round trip for the pass rather than one per camera.
 *
 * These tests assert SHAPE — which methods were called, and how many times —
 * never wall clock. A test that asserted the composed rows would have passed
 * against the pre-fix version: the rows were never wrong, the work to produce
 * them was.
 *
 * The last test is the one that keeps the rest honest: the status composed in a
 * four-camera pass must be byte-identical to the status composed alone. A cheap
 * answer that is a DIFFERENT answer is not a fix.
 */
import type {
  AddonApi,
  CameraStatus,
  IScopedLogger,
  PipelineAssignment,
  RunnerCameraConfig,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { CameraStatusService } from '../camera-status-service.js'
import type { AudioNodeAssignment } from '../orchestrator-types.js'
import { RepeatWarnSampler } from '../repeat-warn-sampler.js'
import { readSwitchAuthorities } from '../switch-authorities.js'

const DEVICE_IDS: readonly number[] = [101, 616, 102, 108]
const SOURCE_NODE = 'hub'
const DETECTION_NODE = 'hub'

const SILENT_LOGGER: IScopedLogger = {
  debug: (): void => undefined,
  info: (): void => undefined,
  warn: (): void => undefined,
  error: (): void => undefined,
  child: (): IScopedLogger => SILENT_LOGGER,
  withTags: (): IScopedLogger => SILENT_LOGGER,
}

/**
 * The bindings every camera in the fixture carries. `privacy-mask` is here
 * deliberately: without it `readSwitchAuthorities` decides the camera planes
 * from the bindings alone and never reaches the provider, which would hide the
 * two per-camera round trips that must SURVIVE this change.
 */
const BINDING_ENTRIES = [
  {
    capName: 'detection-pipeline',
    kind: 'wrapped' as const,
    providerAddonId: 'detection-pipeline',
    providerNodeId: 'hub',
    nativeAddonId: '',
  },
  {
    capName: 'privacy-mask',
    kind: 'native' as const,
    providerAddonId: '',
    providerNodeId: 'hub',
    nativeAddonId: 'provider-hikvision',
  },
]

/** Every cap method the pass reached, in order. */
interface CallRecorder {
  readonly calls: string[]
}

function countOf(rec: CallRecorder, method: string): number {
  return rec.calls.filter((c) => c === method).length
}

/**
 * The hub api narrowed to what a camera-status pass touches.
 *
 * Every leaf records its own name before answering, so a test reads the SHAPE
 * of the pass off `rec.calls` rather than timing it. Answers are deliberately
 * boring and identical per device — the point of the fixture is the call count,
 * and a fixture whose answers varied would let a broken pass look right by
 * accident on one camera.
 */
function makeApi(rec: CallRecorder): never {
  const q = <T>(method: string, fn: (input: unknown) => T) => ({
    query: async (input?: unknown): Promise<T> => {
      rec.calls.push(method)
      return fn(input)
    },
  })
  const slots = DEVICE_IDS.map((deviceId) => ({
    deviceId,
    profile: 'high' as const,
    brokerId: `${deviceId}/high`,
    sourceCamStreamId: 'native:main',
    status: 'streaming' as const,
    codec: 'H264',
    resolution: { width: 1920, height: 1080 },
  }))
  const api = {
    streamBroker: {
      listAllProfileSlots: q('streamBroker.listAllProfileSlots', () => slots),
      getBrokerStats: q('streamBroker.getBrokerStats', () => ({
        status: 'streaming',
        inputFps: 15,
        encodedSubscribers: 1,
        uptimeMs: 60_000,
        bitrateKbps: 4000,
        idrIntervalMs: 2000,
        codec: 'H264',
        totalBytes: 1_000,
        packetCount: 10,
        rtspClients: 0,
        pipeClients: 0,
        preBufferSec: 5,
        preBufferMs: 5000,
        preBufferPackets: 75,
      })),
      listClients: q('streamBroker.listClients', () => ({
        rtsp: [],
        decoded: [],
        audio: [],
        encoded: [],
        pipeClients: 0,
        encodedSubscribers: 1,
      })),
      getAllRtspEntries: q('streamBroker.getAllRtspEntries', () =>
        DEVICE_IDS.map((deviceId) => ({
          brokerId: `${deviceId}/high`,
          url: 'rtsp://localhost/s',
          mutedUrl: 'rtsp://localhost/s-muted',
          enabled: true,
        })),
      ),
      getDeviceAudioMute: q('streamBroker.getDeviceAudioMute', () => ({ muted: false })),
    },
    pipelineExecutor: {
      getEngineProvisioning: q('pipelineExecutor.getEngineProvisioning', () => ({
        runtimeId: 'onnx' as const,
        device: 'cpu',
        state: 'ready' as const,
      })),
      getSelectedEngine: q('pipelineExecutor.getSelectedEngine', () => ({
        runtime: 'python' as const,
        backend: 'onnx',
        format: 'onnx' as const,
      })),
    },
    pipelineRunner: {
      getCameraMetrics: q('pipelineRunner.getCameraMetrics', () => ({
        detectionMode: 'on-motion' as const,
        configuredFps: 10,
        actualFps: 9,
        queueDepth: 1,
        avgInferenceTimeMs: 35,
        droppedFrames: 0,
        phase: 'active' as const,
      })),
    },
    recordingArchive: {
      getStatus: q('recordingArchive.getStatus', () => ({
        enabled: true,
        activeMode: 'continuous' as const,
        storageBytes: 1024,
      })),
      getDeviceConfig: q('recordingArchive.getDeviceConfig', () => ({ enabled: true, bands: [] })),
    },
    notificationRules: {
      listDeviceMutes: q('notificationRules.listDeviceMutes', () => ({ mutedDeviceIds: [] })),
    },
    deviceManager: {
      getDevice: q('deviceManager.getDevice', (input: unknown) => {
        const rec2: Record<string, unknown> = { ...(input as object) }
        return { id: rec2['deviceId'], type: 'camera', disabled: false }
      }),
      listAll: q('deviceManager.listAll', (input: unknown) => {
        const rec2: Record<string, unknown> = { ...(input as object) }
        const ids = rec2['deviceIds']
        const wanted: readonly number[] = Array.isArray(ids)
          ? ids.filter((v): v is number => typeof v === 'number')
          : DEVICE_IDS
        return wanted.map((id) => ({ id, type: 'camera', disabled: false }))
      }),
      getBindings: q('deviceManager.getBindings', (input: unknown) => {
        const rec2: Record<string, unknown> = { ...(input as object) }
        return { deviceId: rec2['deviceId'], entries: BINDING_ENTRIES }
      }),
      getBindingsBatch: q('deviceManager.getBindingsBatch', (input: unknown) => {
        const rec2: Record<string, unknown> = { ...(input as object) }
        const ids = rec2['deviceIds']
        const wanted: readonly number[] = Array.isArray(ids)
          ? ids.filter((v): v is number => typeof v === 'number')
          : DEVICE_IDS
        return wanted.map((deviceId) => ({ deviceId, entries: BINDING_ENTRIES }))
      }),
      listBindableCapsForDeviceType: q('deviceManager.listBindableCapsForDeviceType', () => [
        { capName: 'detection-pipeline', wrappers: ['detection-pipeline'] },
      ]),
    },
    privacyMask: {
      getOptions: q('privacyMask.getOptions', () => ({
        supportsAudioMute: true,
        maxRegions: 4,
        supportedShapes: ['rect'],
      })),
      getStatus: q('privacyMask.getStatus', () => ({
        audioEnabled: true,
        regions: [],
        enabled: false,
      })),
    },
  }
  return api as never
}

function makeService(rec: CallRecorder, deviceIds: readonly number[]): CameraStatusService {
  const api: AddonApi = makeApi(rec)
  const sampler = new RepeatWarnSampler()
  return new CameraStatusService({
    api: (): AddonApi => api,
    logger: SILENT_LOGGER,
    warnSampler: sampler,
    getAssignment: (deviceId): PipelineAssignment => ({
      deviceId,
      agentNodeId: DETECTION_NODE,
      pinned: false,
      reason: 'capacity',
      assignedAt: 0,
    }),
    getAudioAssignment: (): AudioNodeAssignment | null => null,
    getCameraConfig: (): RunnerCameraConfig | null => null,
    hasCameraConfig: (): boolean => true,
    getPendingReason: (): string | undefined => undefined,
    assignSource: (): string => SOURCE_NODE,
    listAssignedDeviceIds: (): readonly number[] => deviceIds,
    isSessionCamera: (): boolean => false,
    switchAuthoritiesFor: async (deviceId, pass) =>
      (
        await readSwitchAuthorities(
          api,
          deviceId,
          { logger: SILENT_LOGGER, assignSource: () => SOURCE_NODE, warnSampler: sampler },
          pass,
        )
      ).derivation,
    cameraSensorsFor: () => ({ state: 'not-configured' }),
  })
}

/** `fetchedAt` moves between two passes and says nothing about the answer. */
function withoutClock(status: CameraStatus): Omit<CameraStatus, 'fetchedAt'> {
  const { fetchedAt: _fetchedAt, ...rest } = status
  return rest
}

describe('getCameraStatuses — one question per pass, not one per camera', () => {
  it('asks each FLEET-invariant question exactly once for a four-camera pass', async () => {
    const rec: CallRecorder = { calls: [] }
    await makeService(rec, DEVICE_IDS).getCameraStatuses(undefined)

    // The whole-node and whole-fleet tables. One answer serves every camera in
    // the pass; four copies of it is four times the wire and four times the
    // work at the owner.
    expect(countOf(rec, 'streamBroker.listAllProfileSlots')).toBe(1)
    expect(countOf(rec, 'streamBroker.getAllRtspEntries')).toBe(1)
    expect(countOf(rec, 'notificationRules.listDeviceMutes')).toBe(1)

    // Per NODE — one detection node here.
    expect(countOf(rec, 'pipelineExecutor.getEngineProvisioning')).toBe(1)
    expect(countOf(rec, 'pipelineExecutor.getSelectedEngine')).toBe(1)

    // Per device TYPE — every camera is `camera`.
    expect(countOf(rec, 'deviceManager.listBindableCapsForDeviceType')).toBe(1)
  })

  it('reads the device roster and the binding table for the SET, not per camera', async () => {
    const rec: CallRecorder = { calls: [] }
    await makeService(rec, DEVICE_IDS).getCameraStatuses(undefined)

    expect(countOf(rec, 'deviceManager.getDevice')).toBe(0)
    expect(countOf(rec, 'deviceManager.getBindings')).toBe(0)
    expect(countOf(rec, 'deviceManager.listAll')).toBe(1)
    expect(countOf(rec, 'deviceManager.getBindingsBatch')).toBe(1)
  })

  it('still asks the genuinely PER-CAMERA questions once per camera', async () => {
    // The half that cannot be collapsed: a camera's recorder, its own provider,
    // its broker's mute, its runner metrics. Collapsing any of these would be a
    // narrower answer, not a cheaper one.
    const rec: CallRecorder = { calls: [] }
    await makeService(rec, DEVICE_IDS).getCameraStatuses(undefined)

    expect(countOf(rec, 'recordingArchive.getStatus')).toBe(DEVICE_IDS.length)
    expect(countOf(rec, 'recordingArchive.getDeviceConfig')).toBe(DEVICE_IDS.length)
    expect(countOf(rec, 'privacyMask.getOptions')).toBe(DEVICE_IDS.length)
    expect(countOf(rec, 'privacyMask.getStatus')).toBe(DEVICE_IDS.length)
    expect(countOf(rec, 'streamBroker.getDeviceAudioMute')).toBe(DEVICE_IDS.length)
    expect(countOf(rec, 'pipelineRunner.getCameraMetrics')).toBe(DEVICE_IDS.length)
  })

  it('costs a bounded number of round trips that does not grow six-fold per camera', async () => {
    // The whole poll, as one number. Per camera: 2 broker-slot reads, metrics,
    // recording status + config, the broker mute, and the privacy pair = 8.
    // Per pass: slots, rtsp, mutes, provisioning, engine, bindable caps, the
    // roster and the binding table = 8.
    const rec: CallRecorder = { calls: [] }
    await makeService(rec, DEVICE_IDS).getCameraStatuses(undefined)
    expect(rec.calls.length).toBe(8 * DEVICE_IDS.length + 8)
  })

  it('composes the SAME status in a pass of four as it does alone', async () => {
    // The honesty check. Everything above is about work avoided; this is the
    // one that fails if the work avoided was work that mattered.
    const batchRec: CallRecorder = { calls: [] }
    const batched = await makeService(batchRec, DEVICE_IDS).getCameraStatuses(undefined)

    for (const deviceId of DEVICE_IDS) {
      const soloRec: CallRecorder = { calls: [] }
      const solo = await makeService(soloRec, [deviceId]).getCameraStatus(deviceId)
      const fromBatch = batched.find((s) => s.deviceId === deviceId)
      expect(fromBatch).toBeDefined()
      if (fromBatch === undefined) continue
      expect(withoutClock(fromBatch)).toEqual(withoutClock(solo))
    }
  })
})
