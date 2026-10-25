/**
 * Two-plane detail-dispatch integration — boots the full addon against a fake
 * AddonContext with a stubbed `pipelineRunner.runDetailSubtree`, feeds a
 * synthetic `PipelineInferenceResult` stream announcing a face detail chain, and
 * asserts the per-track scheduling contract wired in Task 8:
 *
 *   1. exactly ONE subtree call on track start (the new-track request),
 *   2. a SECOND call after a strictly-better candidate (improve cadence),
 *   3. NO further call after a sticky-confidence result,
 *   4. the face row persists (on track end) with the returned embedding + crop.
 *
 * The scheduler's own cadence/announce policy is unit-tested separately
 * (`detail-scheduler.spec.ts`); this spec verifies the WIRING (frame → scheduler
 * → runDetailSubtree → FaceRecognizer → FaceStore).
 */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import type {
  AddonContext,
  FrameResult,
  ObjectDetection,
  PipelineInferenceResultPayload,
  DetailStepAnnounce,
  RunDetailSubtreeResult,
  FrameHandle,
  IScopedLogger,
  IEventBus,
} from '@camstack/types'
import { createEvent, decodeVectorBase64, EventCategory } from '@camstack/types'
import PipelineAnalyticsAddon from '../index.js'
import { FaceRecognizer } from '../face-recognizer.js'
import { FACE_ARCFACE_INDEX } from '../store/embedding-vector-index.js'
import { FACES_COLLECTION } from '../store/face-store.js'
import { ObjectEmbeddingStore } from '../store/object-embedding-store.js'
import {
  makeFakeSettingsStore,
  makeFakeStorageProvider,
  makeFakeEventBus,
  makeFakeDeviceManager,
  makeFakeVectorStore,
  makePipelineBootRecordsWorld,
  makeSilentLogger,
  phase5LedgerEntries,
  vectorRows,
  type FakeRecords,
  type FakeSettingsStore,
  type FakeStorageProvider,
  type FakeDeviceManager,
  type FakeEventBus,
} from './test-helpers.js'

const DEVICE_ID = 9
const NODE_ID = 'hub'

/** base64 little-endian float32 encoding — the `DetailResult.embedding` wire form. */
function encodeEmbedding(vec: readonly number[]): string {
  return Buffer.from(Float32Array.from(vec).buffer).toString('base64')
}

const FACE_EMBEDDING = [0.11, 0.22, 0.33]
const ALIGNED_CROP_B64 = Buffer.from('aligned-jpeg-bytes').toString('base64')

/** One stubbed `runDetailSubtree` face result at the given face-detection score. */
function faceDetailResult(score: number): RunDetailSubtreeResult {
  return {
    details: [
      {
        stepId: 'face-detection',
        className: 'face',
        score,
        bbox: { x: 30, y: 10, w: 40, h: 40 },
        embedding: encodeEmbedding(FACE_EMBEDDING),
        alignedCropJpeg: ALIGNED_CROP_B64,
      },
    ],
  }
}

/**
 * A DISTANT-CAMERA face detail: the bbox is detection-frame px (tiny — well
 * under `minFacePx` 30) while `nativeFaceShortSidePx` carries the runner's
 * native-scale measure (large). The 2026-07-18→23 zero-faces regression: the
 * route gate admitted this shape but did not forward the native measure to
 * `ingestFaceDetail`, so the recognizer's own candidate gate re-measured the
 * detection-px bbox and re-discarded every 4K-camera face.
 */
function faceDetailResultNativeMeasure(score: number): RunDetailSubtreeResult {
  return {
    details: [
      {
        stepId: 'face-detection',
        className: 'face',
        score,
        bbox: { x: 30, y: 10, w: 8, h: 10 },
        embedding: encodeEmbedding(FACE_EMBEDDING),
        alignedCropJpeg: ALIGNED_CROP_B64,
        nativeFaceShortSidePx: 48,
      },
    ],
  }
}

/**
 * A face detail WITHOUT `alignedCropJpeg` — the shape produced when the embedder
 * skipped alignment (no landmarks, or a native-scale path). The router must
 * still send it to the FaceRecognizer (className 'face'), never the CLIP store.
 */
function faceDetailResultNoCrop(score: number): RunDetailSubtreeResult {
  return {
    details: [
      {
        stepId: 'face-detection',
        className: 'face',
        score,
        bbox: { x: 30, y: 10, w: 40, h: 40 },
        embedding: encodeEmbedding(FACE_EMBEDDING),
        // NO alignedCropJpeg on purpose.
      },
    ],
  }
}

/**
 * A face detail the recognizer will REFUSE: a detection-px bbox well under
 * `minFacePx` (30) and NO `nativeFaceShortSidePx`, so `routeFaceDetail` returns
 * at the size gate — nothing is embedded, no gallery is consulted, no identity
 * is ever written. The face detector still found a face, which is the entire
 * point of `Track.hasFace`.
 */
function faceDetailResultBelowMinFacePx(score: number): RunDetailSubtreeResult {
  return {
    details: [
      {
        stepId: 'face-detection',
        className: 'face',
        score,
        bbox: { x: 30, y: 10, w: 8, h: 10 },
        embedding: encodeEmbedding(FACE_EMBEDDING),
        // NO nativeFaceShortSidePx: the gate measures the 8px bbox and drops it.
      },
    ],
  }
}

/** A CLIP object-embedding detail — the shape that must NOT stamp `hasFace`. */
function clipDetailResult(score: number): RunDetailSubtreeResult {
  return {
    details: [
      {
        stepId: 'clip-embedding',
        className: 'embedding',
        score,
        embedding: encodeEmbedding(FACE_EMBEDDING),
      },
    ],
  }
}

const FACE_CHAIN_ANNOUNCE: readonly DetailStepAnnounce[] = [
  {
    stepId: 'face-detection',
    inputClasses: ['person'],
    // improve → re-dispatch on a better candidate; sticky at 0.85 so the
    // returned 0.9 face detail pins the step (no further dispatch).
    cadence: { trigger: 'improve', minIntervalMs: 0, stickyOnConfidence: 0.85, maxPerTrack: 5 },
  },
]

function detection(score: number): ObjectDetection {
  return {
    id: 'p1',
    kind: 'first-level',
    macroClass: 'person',
    score,
    labels: [],
    bbox: { x: 100, y: 100, width: 60, height: 180 },
  }
}

function frameHandle(): FrameHandle {
  // Only `nodeId` is read by the dispatcher on the happy path (nodePin); the rest
  // is passed opaquely to the stubbed runner.
  return { nodeId: NODE_ID, segmentId: 'seg', slot: 0, seq: 1, width: 640, height: 480 } as never
}

function buildFrame(timestamp: number, score: number): FrameResult {
  return {
    kind: 'frame',
    frameId: `f-${timestamp}`,
    deviceId: DEVICE_ID,
    timestamp,
    width: 640,
    height: 480,
    detections: [detection(score)],
  }
}

function emit(bus: IEventBus, timestamp: number, score: number): void {
  const payload: PipelineInferenceResultPayload = {
    deviceId: DEVICE_ID,
    frame: buildFrame(timestamp, score),
    nodeId: NODE_ID,
    frameHandle: frameHandle(),
    detailSteps: FACE_CHAIN_ANNOUNCE,
  }
  bus.emit(
    createEvent(
      EventCategory.PipelineInferenceResult,
      { type: 'addon', id: 'pipeline-runner' },
      payload,
    ),
  )
}

async function flush(): Promise<void> {
  await new Promise<void>((r) => setImmediate(r))
  await new Promise<void>((r) => setImmediate(r))
}

interface Runner {
  readonly runDetailSubtree: { mutate: ReturnType<typeof vi.fn> }
}

interface BootResult {
  readonly addon: PipelineAnalyticsAddon
  readonly runner: Runner
  readonly fakes: {
    readonly settings: FakeSettingsStore
    readonly storage: FakeStorageProvider
    readonly bus: FakeEventBus
    readonly deviceManager: FakeDeviceManager
    readonly vectors: ReturnType<typeof makeFakeVectorStore>
    readonly recordsWorld: FakeRecords
  }
}

async function boot(
  detailFactory: (score: number) => RunDetailSubtreeResult = faceDetailResult,
): Promise<BootResult> {
  const settings = makeFakeSettingsStore()
  const vectors = makeFakeVectorStore()
  const storage = makeFakeStorageProvider()
  const bus = makeFakeEventBus()
  const deviceManager = makeFakeDeviceManager()
  deviceManager.setActive(DEVICE_ID, 'pipeline-analytics', true)

  // First result is BELOW the sticky threshold (a real subtree call still ran,
  // just no confident face yet), the second is above it → so the sequence is
  // start-call, improve-call, then sticky (no further calls).
  const resultScores = [0.7, 0.9]
  let callIndex = 0
  const runner: Runner = {
    runDetailSubtree: {
      mutate: vi.fn(async () => {
        const score = resultScores[Math.min(callIndex, resultScores.length - 1)]!
        callIndex += 1
        return detailFactory(score)
      }),
    },
  }

  const api = {
    settingsStore: settings.client,
    deviceManager: deviceManager.api.deviceManager,
    pipelineRunner: runner,
    // The vector store is the sqlite-settings BUILTIN in production — a hub
    // that has `settingsStore` has this too, and the gallery stores refuse to
    // boot without it.
    vectorStore: vectors.client,
    // Object-embedding search gate resolver — unused by the face path but present
    // so the clip route can resolve a model id without throwing.
    embeddingEncoder: {
      getInfo: { query: vi.fn(async () => ({ modelId: 'mobileclip-s1' })) },
    },
  } as unknown as AddonContext['api']

  const logger: IScopedLogger = makeSilentLogger()
  const addonStore: Record<string, unknown> = {}
  const deviceStore = new Map<number, Record<string, unknown>>()

  const recordsWorld = await makePipelineBootRecordsWorld()
  const ctx: AddonContext = {
    id: 'pipeline-analytics',
    logger,
    records: recordsWorld.records,
    eventBus: bus.bus,
    addonConfig: {},
    kernel: { localNodeId: NODE_ID, storage } as unknown as AddonContext['kernel'],
    api,
    dataDir: '/tmp/fake',
    nodeDataDir: '/tmp',
    deps: {
      ensureBinary: async () => '',
      ensureFfmpeg: async () => '',
      ensurePython: async () => null,
      installPythonPackages: async () => {},
      getDepsDir: () => '/tmp/fake/deps',
    },
    settings: {
      async readAddonStore() {
        return { ...addonStore }
      },
      async writeAddonStore(patch: Record<string, unknown>) {
        Object.assign(addonStore, patch)
      },
      async readDeviceStore(deviceId: number) {
        return { ...deviceStore.get(deviceId) }
      },
      async writeDeviceStore(deviceId: number, patch: Record<string, unknown>) {
        deviceStore.set(deviceId, { ...deviceStore.get(deviceId), ...patch })
      },
      async getSection() {
        return {}
      },
      async setSection() {},
    },
    getNativeProvider: () => {
      throw new Error('no native providers')
    },
    fetchDevice: async () => {
      throw new Error('no devices')
    },
  } as unknown as AddonContext

  const addon = new PipelineAnalyticsAddon()
  await addon.initialize(ctx)
  return {
    addon,
    runner,
    fakes: { settings, storage, bus, deviceManager, vectors, recordsWorld },
  }
}

describe('two-plane detail dispatch — pipeline-analytics wiring', () => {
  let booted: BootResult

  beforeEach(() => {
    // Fake only the timer/clock primitives — NOT setImmediate — so real
    // microtask flushing (`flush`) keeps working while the addon's TTL sweep
    // and the dispatcher tick can be advanced deterministically.
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'Date'],
    })
    vi.setSystemTime(1000)
  })

  afterEach(async () => {
    if (booted) await booted.addon.shutdown()
    vi.useRealTimers()
  })

  it('dispatches once on start, once on improve, never after sticky; persists the face', async () => {
    booted = await boot()
    const { addon, runner, fakes } = booted

    // Warm the tracker to minHits=3 at a stable position → the track appears on
    // the third frame. onTrackStarted then fires the ONE new-track subtree call.
    emit(fakes.bus.bus, 1000, 0.9)
    await flush()
    emit(fakes.bus.bus, 1100, 0.9)
    await flush()
    emit(fakes.bus.bus, 1200, 0.9)
    await flush()

    expect((await addon.getActiveTracks({ deviceId: DEVICE_ID })).length).toBe(1)
    expect(runner.runDetailSubtree.mutate).toHaveBeenCalledTimes(1)

    // A strictly-better candidate → improve-cadence re-dispatch (call #2).
    emit(fakes.bus.bus, 1300, 0.93)
    await flush()
    expect(runner.runDetailSubtree.mutate).toHaveBeenCalledTimes(2)

    // The 0.9 face detail (≥ stickyOnConfidence 0.85) pinned the step: a further
    // improvement produces NO additional call.
    emit(fakes.bus.bus, 1400, 0.96)
    await flush()
    expect(runner.runDetailSubtree.mutate).toHaveBeenCalledTimes(2)

    // The call is pinned to the frame's node and carries the frame-space parent.
    // A NEW-TRACK request always composes the full detect→embed chain (the
    // recognition path is never geometry-only); the periodic geometry-only skip
    // is exercised in the composeDetailSteps unit spec.
    const firstCall = runner.runDetailSubtree.mutate.mock.calls[0]!
    expect(firstCall[0]).toMatchObject({
      deviceId: DEVICE_ID,
      parent: { className: 'person' },
      steps: ['face-detection', 'face-embedding'],
    })

    // Advance past the 30 s track TTL so the sweep promotes the track and the
    // FaceRecognizer flushes its held best face to the FaceStore.
    await vi.advanceTimersByTimeAsync(40_000)
    await flush()

    const faceRows = phase5LedgerEntries({
      records: fakes.recordsWorld,
      collection: FACES_COLLECTION,
    })
    expect(faceRows.length).toBe(1)
    const faceId = faceRows[0]!.id
    const row = faceRows[0]!.data as {
      embedding: readonly number[]
      mediaId?: number
      faceBbox?: { x: number; y: number; w: number; h: number }
    }
    // The ROW's legacy column is DRAINED — the vector no longer lives there.
    expect(row.embedding).toEqual([])
    // The RETURNED detail embedding is in the `face-arcface` index, keyed by
    // the face row's id. This is the whole of the migration, end to end.
    const indexed = vectorRows(booted.fakes.vectors, FACE_ARCFACE_INDEX).get(faceId!)
    expect(indexed).toBeDefined()
    const stored = decodeVectorBase64(indexed!.vector)
    expect(stored).toHaveLength(FACE_EMBEDDING.length)
    expect(stored[0]).toBeCloseTo(FACE_EMBEDDING[0]!, 5)
    expect(indexed!.metadata['trackId']).toBeTruthy()
    expect(row.mediaId).toBeTruthy()
    expect(row.faceBbox).toEqual({ x: 30, y: 10, w: 40, h: 40 })
  })

  it('re-injects the face detail on the frame-tracked emit after a detail result', async () => {
    booted = await boot()
    const { fakes } = booted

    // Warm the tracker to a stable track (same start-flow as the first test) —
    // the third frame fires the ONE new-track subtree call, whose face-detail
    // result (bbox 30,10,40,40) lands in the overlay state via routeDetailResults.
    emit(fakes.bus.bus, 1000, 0.9)
    await flush()
    emit(fakes.bus.bus, 1100, 0.9)
    await flush()
    emit(fakes.bus.bus, 1200, 0.9)
    await flush()

    // One more inference frame for the SAME track: its frame-tracked emit must
    // carry a synthesized `kind:'detail'` face entry re-projected from the
    // overlay state, parented to this frame's person root id.
    emit(fakes.bus.bus, 1300, 0.9)
    await flush()

    const frameTracked = fakes.bus.captured.filter(
      (e) => e.category === EventCategory.PipelineAnalyticsFrameTracked,
    )
    const last = frameTracked.at(-1)!.data as { detections: ObjectDetection[] }
    const face = last.detections.find((d) => d.kind === 'detail' && d.macroClass === 'face')
    expect(face).toBeDefined()
    expect(face!.id).toMatch(/^detail-.*-face$/)
    expect(last.detections.some((d) => d.id === face!.parentId)).toBe(true)
  })

  it('does not dispatch when no detail steps are announced', async () => {
    booted = await boot()
    const { runner, fakes } = booted

    const emitNoSteps = (timestamp: number): void => {
      const payload: PipelineInferenceResultPayload = {
        deviceId: DEVICE_ID,
        frame: buildFrame(timestamp, 0.9),
        nodeId: NODE_ID,
        frameHandle: frameHandle(),
        // no detailSteps
      }
      fakes.bus.bus.emit(
        createEvent(
          EventCategory.PipelineInferenceResult,
          { type: 'addon', id: 'pipeline-runner' },
          payload,
        ),
      )
    }

    for (const t of [1000, 1100, 1200, 1300]) {
      emitNoSteps(t)
      await flush()
    }
    expect(runner.runDetailSubtree.mutate).not.toHaveBeenCalled()
  })

  // Zero-faces regression 2026-07-18→23: a distant-camera face (detection-px
  // bbox under minFacePx, native measure above it) must survive BOTH gates —
  // the route gate AND the recognizer's candidate filter — and persist. This
  // fails when `routeFaceDetail` drops `nativeFaceShortSidePx` on the hand-off
  // to `ingestFaceDetail` (the recognizer then re-measures detection px).
  it('persists a distant-camera face: native measure survives the route→ingest hand-off', async () => {
    booted = await boot(faceDetailResultNativeMeasure)
    const { addon, fakes } = booted

    emit(fakes.bus.bus, 1000, 0.9)
    await flush()
    emit(fakes.bus.bus, 1100, 0.9)
    await flush()
    emit(fakes.bus.bus, 1200, 0.9)
    await flush()
    expect((await addon.getActiveTracks({ deviceId: DEVICE_ID })).length).toBe(1)

    // Track TTL sweep → the held best face flushes to the FaceStore.
    await vi.advanceTimersByTimeAsync(40_000)
    await flush()

    expect(
      phase5LedgerEntries({
        records: fakes.recordsWorld,
        collection: FACES_COLLECTION,
      }).length,
    ).toBe(1)
  })

  // Critical C1 Part 2 (belt-and-braces): the router discriminates by
  // className, NOT by `alignedCropJpeg` presence. A real face detail whose
  // aligned crop is absent (embedder skipped alignment) MUST still reach the
  // FaceRecognizer and MUST NOT be misrouted into the CLIP object-embedding
  // store (which would starve face recognition).
  it('routes a face detail WITHOUT alignedCropJpeg to the FaceRecognizer, never the CLIP store', async () => {
    const ingestSpy = vi.spyOn(FaceRecognizer.prototype, 'ingestFaceDetail')
    const clipSpy = vi.spyOn(ObjectEmbeddingStore.prototype, 'upsertIfBetter')
    try {
      booted = await boot(faceDetailResultNoCrop)
      const { runner, fakes } = booted

      // Warm the tracker to a stable track → one new-track subtree call fires.
      emit(fakes.bus.bus, 1000, 0.9)
      await flush()
      emit(fakes.bus.bus, 1100, 0.9)
      await flush()
      emit(fakes.bus.bus, 1200, 0.9)
      await flush()
      await flush()

      expect(runner.runDetailSubtree.mutate).toHaveBeenCalledTimes(1)

      // className 'face' routed to the FaceRecognizer even without an aligned crop.
      expect(ingestSpy).toHaveBeenCalled()
      const firstIngest = ingestSpy.mock.calls[0]![0]
      expect(firstIngest.embedding).toHaveLength(FACE_EMBEDDING.length)
      expect(firstIngest.alignedCropJpeg).toBeUndefined()

      // A real face must NEVER land in the CLIP object-embedding store.
      expect(clipSpy).not.toHaveBeenCalled()
    } finally {
      ingestSpy.mockRestore()
      clipSpy.mockRestore()
    }
  })

  /**
   * `Track.hasFace` — the DETECTOR's answer, stamped before every gate that can
   * refuse the face.
   *
   * This is the discriminating case: the detail is below `minFacePx`, so
   * `routeFaceDetail` returns at the size gate, the FaceRecognizer is never
   * reached, no face row is written and no identity is ever produced. A flag
   * written anywhere downstream of that gate would be FALSE here — and the
   * viewer's badge (`hasFace && !subLabel`) would then never render, which is
   * the only state it exists to render.
   *
   * The read is the LIVE track: the flag is set in RAM while the track runs and
   * rides the expiry-time persist from there (one row write, not one per
   * detail). The persist → row → slim-read half is pinned separately in
   * `store/__tests__/track-store-has-face.spec.ts`.
   */
  it('stamps hasFace on the track when a face is DETECTED but never recognised', async () => {
    booted = await boot(faceDetailResultBelowMinFacePx)
    const { addon, fakes } = booted

    emit(fakes.bus.bus, 1000, 0.9)
    await flush()
    emit(fakes.bus.bus, 1100, 0.9)
    await flush()
    emit(fakes.bus.bus, 1200, 0.9)
    await flush()
    await flush()

    // Nothing was recognised: the face store is empty and no identity landed.
    expect(
      phase5LedgerEntries({
        records: fakes.recordsWorld,
        collection: FACES_COLLECTION,
      }).length,
    ).toBe(0)

    const tracks = await addon.getActiveTracks({ deviceId: DEVICE_ID })
    expect(tracks.length).toBe(1)
    expect(tracks[0]!.hasFace).toBe(true)
    // …which is what makes the pair "face present, identity unknown".
    expect(tracks[0]!.subLabel).toBeUndefined()
  })

  /** A non-face detail must leave the flag ABSENT — not false: a track that
   *  never met the face detector says nothing about faces at all. */
  it('leaves hasFace absent when no face detail is produced', async () => {
    booted = await boot(clipDetailResult)
    const { addon, fakes } = booted

    emit(fakes.bus.bus, 1000, 0.9)
    await flush()
    emit(fakes.bus.bus, 1100, 0.9)
    await flush()
    emit(fakes.bus.bus, 1200, 0.9)
    await flush()
    await flush()

    const tracks = await addon.getActiveTracks({ deviceId: DEVICE_ID })
    expect(tracks.length).toBe(1)
    expect(tracks[0]!.hasFace).toBeUndefined()
  })
})
