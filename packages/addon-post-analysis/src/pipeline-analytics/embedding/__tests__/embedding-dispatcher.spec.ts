/**
 * `EmbeddingDispatcher.handleDetectionResult` — Task 8 of the shm-frame-plane
 * downstream-access plan.
 *
 * The dispatcher consumes `detection.result` events whose payload now carries
 * an optional `frameHandle` (Task 7). Post-shm (2026-07-16) it resolves the
 * handle back to pixels ALWAYS via the injected `getRemoteFrame(handle)`
 * callback (the runner's node-routed full-frame `getNativeCrop`) — there is no
 * local `/dev/shm` read anymore. The resulting `DecodedFrame` is fed to
 * `extractCrop`.
 *
 * ⚠ READ THIS BEFORE TRUSTING A GREEN RUN HERE.
 *
 * Every test in the `frame resolution` block below feeds
 * `analysisResults: [{ detection }]`. **No production emitter has ever sent
 * that.** The single emitter of `DetectionResult.analysisResults` in the whole
 * repo is `addon-pipeline-orchestrator`'s
 * `DetectionWiringController.handleInferenceResult`, and it emits a literal
 * `[]` (pinned by `detection-wiring-e2e.spec.ts`) — refinement moved to
 * `pipeline-analytics` and the field was left drained behind it.
 *
 * So these fixtures are a fake supplying the value production never fetches:
 * exactly the failure mode `CLAUDE.md` warns about. They passed for as long as
 * the dispatcher, in production, did nothing but pull a whole decoded frame
 * across a process boundary and iterate an empty array — ~1.4 MB of `external`
 * per event at 640, twice that after `Buffer.from`, on 100% of events.
 *
 * They are kept (not deleted) because they are the only coverage of the
 * resolve→crop→encode path, which becomes live again the day the field is
 * repopulated upstream. What makes them safe now is the FIRST block below,
 * `production payload shape`: it feeds the `[]` production actually sends and
 * asserts the frame is NOT fetched. That assertion — "the expensive call did
 * not happen" — is the shape that would have caught this years ago; asserting
 * on results alone never could, because with an empty array the results are
 * identical either way.
 *
 * We stub the `encoder.encode` round-trip so the assertions can observe the
 * exact `(crop, width, height)` triplet built from the resolved frame.
 */

import type {
  DecodedFrame,
  EventSource,
  FrameHandle,
  FrameResult,
  IEventBus,
  IScopedLogger,
  KnownEventCategory,
  SystemEvent,
  TypedEventFilter,
  TypedSystemEvent,
} from '@camstack/types'
import {
  EMBEDDING_MODEL_FAILED,
  EMBEDDING_REQUIREMENTS_UNAVAILABLE,
  embeddingModelFailedError,
  embeddingRequirementsUnavailableError,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import type { EmbeddingConfig } from '../embedding-config.js'
import type { EmbeddingDispatcherDeps } from '../embedding-dispatcher.js'
import { EmbeddingDispatcher, selectCropBbox } from '../embedding-dispatcher.js'

// ── Logger / event-bus stubs ────────────────────────────────────────
function makeLogger(): IScopedLogger {
  const logger: IScopedLogger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  }
  return logger
}

class TestEventBus implements IEventBus {
  private subs: Array<(event: SystemEvent) => void> = []
  emitted: SystemEvent[] = []

  emit(event: SystemEvent): void {
    this.emitted.push(event)
    for (const s of this.subs) s(event)
  }
  subscribe<C extends KnownEventCategory>(
    filter: TypedEventFilter<C>,
    handler: (event: TypedSystemEvent<C>) => void,
  ): () => void
  subscribe(filter: unknown, handler: (event: SystemEvent) => void): () => void
  subscribe(_filter: unknown, handler: (event: SystemEvent) => void): () => void {
    this.subs.push(handler)
    return () => {
      this.subs = this.subs.filter((h) => h !== handler)
    }
  }
  getRecent(): readonly SystemEvent[] {
    return this.emitted
  }
}

// ── Encoder stub ────────────────────────────────────────────────────
// Mirrors the cross-process `EmbeddingEncoderClient`: `encode` returns a
// `number[]` embedding (Float32Array does not survive MsgPack), `getInfo` is
// async (the cap `getInfo` is a query).
interface EncoderStub {
  encode: ReturnType<typeof vi.fn>
  getInfo: ReturnType<typeof vi.fn>
}

function makeEncoder(): EncoderStub {
  return {
    encode: vi.fn().mockResolvedValue({ embedding: [0, 0, 0, 0], inferenceMs: 1.5 }),
    getInfo: vi.fn().mockResolvedValue({ modelId: 'test-model', embeddingDim: 4, ready: true }),
  }
}

// ── Fixtures ────────────────────────────────────────────────────────
function makeHandle(overrides: Partial<FrameHandle> = {}): FrameHandle {
  return {
    shmId: 'camstack.frames.cam-1.0',
    slot: 3,
    seq: 42,
    width: 8,
    height: 8,
    format: 'rgb',
    pts: 100,
    byteLength: 8 * 8 * 3,
    nodeId: 'node-a',
    slotCount: 16,
    ...overrides,
  }
}

function makeDecodedFrame(overrides: Partial<DecodedFrame> = {}): DecodedFrame {
  return {
    data: Buffer.alloc(8 * 8 * 3, 0xaa),
    width: 8,
    height: 8,
    format: 'rgb',
    timestamp: 100,
    ...overrides,
  }
}

/** Runtime shape of `DetectionResult.analysisResults[].detection` (see embedding-dispatcher). */
interface PipelineDetection {
  readonly class: string
  readonly score: number
  readonly trackId?: string
  readonly bbox: { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
}

function makeDetection(overrides: Partial<PipelineDetection> = {}): PipelineDetection {
  return {
    class: 'person',
    score: 0.9,
    trackId: 'track-1',
    bbox: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
    ...overrides,
  }
}

interface AnalysisItem {
  readonly detection: PipelineDetection
}

function makeEvent(
  data: {
    frame: FrameResult
    analysisResults: readonly AnalysisItem[]
    frameHandle?: FrameHandle
  },
  source: EventSource = { type: 'device', id: 1 },
): TypedSystemEvent<'detection.result'> {
  return {
    id: 'evt-1',
    timestamp: new Date(),
    source,
    category: 'detection.result',
    data,
  }
}

function makeFrameResult(): FrameResult {
  return {
    kind: 'frame',
    frameId: 'frame-1',
    deviceId: 1,
    timestamp: 100,
    width: 8,
    height: 8,
    detections: [],
  }
}

function embedConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  return {
    enabled: true,
    modelId: 'test-model',
    agentId: 'local',
    backend: 'cpu',
    classes: [],
    minConfidence: 0.5,
    maxPerSecPerCamera: 100,
    cropStrategy: 'first',
    retentionDays: 30,
    ...overrides,
  }
}

// ── Helper: build a dispatcher with the stubbed deps and drive the
//   private `handleDetectionResult` via the event-bus subscription set up
//   inside `start()`. This avoids reaching into private state.
async function startDispatcher(
  deps: Partial<EmbeddingDispatcherDeps> & {
    getRemoteFrame: ReturnType<
      typeof vi.fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>
    >
    encoder: EncoderStub
  },
): Promise<{
  dispatcher: EmbeddingDispatcher
  bus: TestEventBus
  encoder: EncoderStub
  logger: IScopedLogger
  stop: () => Promise<void>
}> {
  const bus = new TestEventBus()
  const logger = makeLogger()
  const dispatcher = new EmbeddingDispatcher({
    config: deps.config ?? embedConfig(),
    encoder: deps.encoder,
    eventBus: bus,
    logger,
    getRemoteFrame: deps.getRemoteFrame,
    ...(deps.emptyReportIntervalMs === undefined
      ? {}
      : { emptyReportIntervalMs: deps.emptyReportIntervalMs }),
    ...(deps.refusalReportIntervalMs === undefined
      ? {}
      : { refusalReportIntervalMs: deps.refusalReportIntervalMs }),
  })
  await dispatcher.start()
  return {
    dispatcher,
    bus,
    encoder: deps.encoder,
    logger,
    stop: async () => dispatcher.stop(),
  }
}

// Wait for the dispatcher's async detection handler to settle. The handler
// awaits `resolveFrame`, then `extractCrop` (sharp), then `encoder.encode`
// in a fire-and-forget `processOne` call — settle by polling a predicate
// rather than guessing a microtask count.
async function waitFor(predicate: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) return
    await new Promise((resolve) => setImmediate(resolve))
  }
}

/**
 * The payload production actually delivers, on every single `detection.result`
 * event: a valid `frameHandle` and an EMPTY `analysisResults`.
 *
 * The assertions here are deliberately about the CALL, not the outcome. With
 * no detections the outcome is the same whether or not the frame was fetched —
 * no crop, no encode, no event — which is precisely why the outcome-shaped
 * tests below stayed green while every event paid for a full cross-process
 * frame fetch plus a second whole-buffer copy.
 */
describe('EmbeddingDispatcher.handleDetectionResult — production payload shape', () => {
  it('fetches NO frame when analysisResults is empty, even with a valid frameHandle', async () => {
    const handle = makeHandle({ nodeId: 'node-a' })
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(makeDecodedFrame())
    const encoder = makeEncoder()

    const { bus, stop } = await startDispatcher({ getRemoteFrame, encoder })

    bus.emit(
      makeEvent({
        frame: makeFrameResult(),
        // What `DetectionWiringController.handleInferenceResult` emits, always.
        analysisResults: [],
        frameHandle: handle,
      }),
    )

    // Give the handler every chance to reach `resolveFrame` before asserting.
    await waitFor(() => getRemoteFrame.mock.calls.length > 0, 200)

    // THE load-bearing assertion: the expensive call never happened.
    expect(getRemoteFrame).not.toHaveBeenCalled()
    expect(encoder.encode).not.toHaveBeenCalled()

    await stop()
  })

  it('fetches no frame for a burst of empty events, and pins nothing', async () => {
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(makeDecodedFrame())
    const encoder = makeEncoder()

    const { dispatcher, bus, stop } = await startDispatcher({ getRemoteFrame, encoder })

    for (let i = 0; i < 50; i++) {
      bus.emit(
        makeEvent({
          frame: makeFrameResult(),
          analysisResults: [],
          frameHandle: makeHandle({ seq: i }),
        }),
      )
    }

    await waitFor(() => getRemoteFrame.mock.calls.length > 0, 200)

    expect(getRemoteFrame).not.toHaveBeenCalled()
    expect(dispatcher.pendingFrameCount()).toBe(0)

    await stop()
  })

  it('reports the dropped events as a periodic count, not one line per event', async () => {
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(makeDecodedFrame())
    const encoder = makeEncoder()

    const { bus, logger, stop } = await startDispatcher({
      getRemoteFrame,
      encoder,
      // Report as soon as the next event lands after the window.
      emptyReportIntervalMs: 0,
    })

    const emitEmpty = (deviceId: number): void =>
      bus.emit(
        makeEvent(
          { frame: makeFrameResult(), analysisResults: [], frameHandle: makeHandle() },
          { type: 'device', id: deviceId },
        ),
      )

    // First event opens the window and logs nothing; the second closes it.
    emitEmpty(102)
    emitEmpty(102)
    emitEmpty(101)

    const infoFn = logger.info as ReturnType<typeof vi.fn>
    const reports = infoFn.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('nothing to embed'),
    )
    // Far fewer lines than events — a count, not a per-event log.
    expect(reports.length).toBeGreaterThan(0)
    expect(reports.length).toBeLessThan(3)

    // And the count is answerable per camera.
    const meta = reports[0]![1]
    expect(meta).toMatchObject({ meta: { events: expect.any(Number) } })

    await stop()
  })
})

describe('EmbeddingDispatcher.handleDetectionResult — frame resolution (NOT a production payload shape: see file header)', () => {
  it('resolves via getRemoteFrame and builds a PendingCrop from the resolved frame', async () => {
    const handle = makeHandle({ nodeId: 'node-a' })
    const resolved = makeDecodedFrame({ data: Buffer.alloc(8 * 8 * 3, 0xaa) })
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(resolved)
    const encoder = makeEncoder()

    const { bus, stop } = await startDispatcher({ getRemoteFrame, encoder })

    bus.emit(
      makeEvent({
        frame: makeFrameResult(),
        analysisResults: [{ detection: makeDetection() }],
        frameHandle: handle,
      }),
    )

    await waitFor(() => encoder.encode.mock.calls.length > 0)

    expect(getRemoteFrame).toHaveBeenCalledTimes(1)
    expect(getRemoteFrame).toHaveBeenCalledWith(handle, 1)

    // The encoder receives the crop produced from the RESOLVED frame's pixels
    // — verifies extractCrop got `(decoded.data, decoded.width, decoded.height)`,
    // not anything from a `pipelineResult.frameData` channel.
    expect(encoder.encode).toHaveBeenCalledTimes(1)
    const [cropArg, widthArg, heightArg] = encoder.encode.mock.calls[0]!
    expect(Buffer.isBuffer(cropArg)).toBe(true)
    expect((cropArg as Buffer).length).toBeGreaterThan(0)
    expect(widthArg).toBeGreaterThan(0)
    expect(heightArg).toBeGreaterThan(0)

    await stop()
  })

  it('resolves a cross-node handle through the same getRemoteFrame path', async () => {
    const handle = makeHandle({ nodeId: 'node-remote' })
    const resolved = makeDecodedFrame({ data: Buffer.alloc(8 * 8 * 3, 0xcc) })
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(resolved)
    const encoder = makeEncoder()

    const { bus, stop } = await startDispatcher({ getRemoteFrame, encoder })

    bus.emit(
      makeEvent({
        frame: makeFrameResult(),
        analysisResults: [{ detection: makeDetection({ trackId: 'track-r' }) }],
        frameHandle: handle,
      }),
    )

    await waitFor(() => encoder.encode.mock.calls.length > 0)

    expect(getRemoteFrame).toHaveBeenCalledTimes(1)
    expect(getRemoteFrame).toHaveBeenCalledWith(handle, 1)
    expect(encoder.encode).toHaveBeenCalledTimes(1)

    await stop()
  })

  it('skips (no PendingCrop, no encode) when event.data.frameHandle is absent', async () => {
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(null)
    const encoder = makeEncoder()

    const { bus, logger, stop } = await startDispatcher({
      getRemoteFrame,
      encoder,
    })

    bus.emit(
      makeEvent({
        frame: makeFrameResult(),
        analysisResults: [{ detection: makeDetection({ trackId: 'track-noframe' }) }],
        // intentionally NO frameHandle
      }),
    )

    const debugFn = logger.debug as ReturnType<typeof vi.fn>
    await waitFor(() => debugFn.mock.calls.length > 0)

    expect(getRemoteFrame).not.toHaveBeenCalled()
    expect(encoder.encode).not.toHaveBeenCalled()
    expect(debugFn).toHaveBeenCalled()

    await stop()
  })

  it('prefers refinedBbox over bbox when present', () => {
    const bbox = { x: 0, y: 0, w: 1, h: 1 }
    const refinedBbox = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 }
    expect(selectCropBbox({ bbox, refinedBbox })).toBe(refinedBbox)
    expect(selectCropBbox({ bbox })).toBe(bbox)
  })

  it('skips when resolveFrame returns null (frame evicted / remote miss)', async () => {
    const handle = makeHandle({ nodeId: 'node-a' })
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(null)
    const encoder = makeEncoder()

    const { bus, logger, stop } = await startDispatcher({
      getRemoteFrame,
      encoder,
    })

    bus.emit(
      makeEvent({
        frame: makeFrameResult(),
        analysisResults: [{ detection: makeDetection({ trackId: 'track-recycled' }) }],
        frameHandle: handle,
      }),
    )

    const debugFn = logger.debug as ReturnType<typeof vi.fn>
    await waitFor(() => debugFn.mock.calls.length > 0)

    expect(getRemoteFrame).toHaveBeenCalledTimes(1)
    expect(encoder.encode).not.toHaveBeenCalled()
    expect(debugFn).toHaveBeenCalled()

    await stop()
  })
})

/**
 * `pendingCrops` holds a WHOLE decoded RGB frame per entry (`PendingCrop.frameData`,
 * ~0.7 MB at 640x360), and under the shipped `cropStrategy: 'first'` it is used as
 * an in-flight DEDUPE FLAG: set before `processOne`, deleted when `processOne`
 * succeeds. The delete was on the success path only, and the `catch` had none —
 * so any `extractCrop` throw or any `encoder.encode` rejection (it is a
 * cross-process cap over UDS, and it has no timeout) stranded the entry forever.
 *
 * That is two defects in one, and the second is the one that shows up as a
 * missing feature rather than as memory: a stranded trackId is also a trackId
 * that can NEVER be embedded again, because `'first'` gates on
 * `!this.pendingCrops.has(trackId)`.
 *
 * Under `'first'` there is no flush timer at all (it is installed only for
 * `'best-confidence'`), so nothing ever swept these.
 */
describe('EmbeddingDispatcher — a failed embed releases its frame', () => {
  it('releases the pending entry when the encoder rejects, and re-tries that track', async () => {
    const handle = makeHandle()
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(makeDecodedFrame())
    const encoder = makeEncoder()
    encoder.encode.mockRejectedValueOnce(new Error('encoder wedged'))

    const { dispatcher, bus, logger, stop } = await startDispatcher({ getRemoteFrame, encoder })

    const emit = (): void =>
      bus.emit(
        makeEvent({
          frame: makeFrameResult(),
          analysisResults: [{ detection: makeDetection({ trackId: 'track-boom' }) }],
          frameHandle: handle,
        }),
      )

    emit()
    const warnFn = logger.warn as ReturnType<typeof vi.fn>
    await waitFor(() => warnFn.mock.calls.length > 0)
    expect(encoder.encode).toHaveBeenCalledTimes(1)
    // The frame it pinned is gone, not merely unreferenced by a later attempt.
    await waitFor(() => dispatcher.pendingFrameCount() === 0)
    expect(dispatcher.pendingFrameCount()).toBe(0)

    // Same track again: the failed attempt must not have poisoned it.
    emit()
    await waitFor(() => encoder.encode.mock.calls.length > 1)
    expect(encoder.encode).toHaveBeenCalledTimes(2)

    await stop()
  })

  it('reports how many frames it is holding', async () => {
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(makeDecodedFrame())
    const encoder = makeEncoder()
    const { dispatcher, bus, stop } = await startDispatcher({ getRemoteFrame, encoder })

    bus.emit(
      makeEvent({
        frame: makeFrameResult(),
        analysisResults: [{ detection: makeDetection({ trackId: 'track-held' }) }],
        frameHandle: makeHandle(),
      }),
    )
    await waitFor(() => encoder.encode.mock.calls.length > 0)
    await waitFor(() => dispatcher.pendingFrameCount() === 0)
    expect(dispatcher.pendingFrameCount()).toBe(0)

    await stop()
  })
})

// ── A FAILED encoder model (D649 round 4) ───────────────────────────
// The encoder refuses every track by ONE shared code once a tower is
// terminally failed on its node. Logging the whole refusal per track at the
// live detail plane's rate was the noise that hid the transition; the
// dispatcher counts per (camera, model) and says so once per interval.
describe('EmbeddingDispatcher — refusals by a FAILED encoder model are counted per camera, not logged per track', () => {
  const FAILED = embeddingModelFailedError({
    modelId: 'siglip2-b16-224',
    tower: 'image',
    nodeId: 'agent-b',
    crashes: 3,
    windowMs: 600_000,
    sinceMs: 1,
    lastReason: 'process died after loading',
  })

  function refusingEncoder(): EncoderStub {
    return {
      encode: vi.fn().mockRejectedValue(FAILED),
      getInfo: vi
        .fn()
        .mockResolvedValue({ modelId: 'siglip2-b16-224', embeddingDim: 768, ready: false }),
    }
  }

  function tracks(ids: readonly string[]): readonly AnalysisItem[] {
    return ids.map((trackId) => ({ detection: makeDetection({ trackId }) }))
  }

  it('three refused tracks on one camera are ONE line (the first at once, with tags.deviceId, model, node and the reset hint); stop() reports the other two', async () => {
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(makeDecodedFrame())
    const encoder = refusingEncoder()
    const { bus, logger, stop } = await startDispatcher({ getRemoteFrame, encoder })

    bus.emit(
      makeEvent(
        {
          frame: makeFrameResult(),
          analysisResults: tracks(['t1', 't2', 't3']),
          frameHandle: makeHandle(),
        },
        { type: 'device', id: 7 },
      ),
    )
    await waitFor(() => encoder.encode.mock.calls.length >= 3)
    await waitFor(() => vi.mocked(logger.warn).mock.calls.length >= 1)

    const refused = vi
      .mocked(logger.warn)
      .mock.calls.filter(([message]) => message.startsWith('Embedding refused'))
    expect(refused).toHaveLength(1) // three tracks, ONE line
    expect(refused[0]?.[1]).toEqual(
      expect.objectContaining({
        tags: { deviceId: 7 },
        meta: expect.objectContaining({
          modelId: 'siglip2-b16-224',
          tower: 'image',
          nodeId: 'agent-b',
          refused: 1,
          recovery: expect.stringContaining('embeddingEncoder.resetFailedModels'),
        }),
      }),
    )
    // Not one per track, and not the free-text path.
    expect(vi.mocked(logger.warn).mock.calls.some(([m]) => m === 'Failed to embed track')).toBe(
      false,
    )

    // stop() reports what was counted since: the other two, so no refusal is lost.
    await stop()
    const flushed = vi
      .mocked(logger.warn)
      .mock.calls.filter(([message]) => message.startsWith('Embedding refused'))
    expect(flushed).toHaveLength(2)
    expect(flushed[1]?.[1]).toEqual(
      expect.objectContaining({
        tags: { deviceId: 7 },
        meta: expect.objectContaining({ refused: 2 }),
      }),
    )
  })

  it('two cameras are two lines — the per-camera question stays answerable', async () => {
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(makeDecodedFrame())
    const encoder = refusingEncoder()
    const { bus, logger, stop } = await startDispatcher({ getRemoteFrame, encoder })
    bus.emit(
      makeEvent(
        { frame: makeFrameResult(), analysisResults: tracks(['a']), frameHandle: makeHandle() },
        { type: 'device', id: 101 },
      ),
    )
    bus.emit(
      makeEvent(
        { frame: makeFrameResult(), analysisResults: tracks(['b']), frameHandle: makeHandle() },
        { type: 'device', id: 102 },
      ),
    )
    await waitFor(() => encoder.encode.mock.calls.length >= 2)
    await waitFor(
      () =>
        vi.mocked(logger.warn).mock.calls.filter(([m]) => m.startsWith('Embedding refused'))
          .length >= 2,
    )
    const devices = vi
      .mocked(logger.warn)
      .mock.calls.filter(([m]) => m.startsWith('Embedding refused'))
      .map(([, extras]) => extras?.tags?.['deviceId'])
      .sort()
    expect(devices).toEqual([101, 102])
    await stop()
  })

  it('after the interval the next refusal carries the count accumulated since the last line', async () => {
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(makeDecodedFrame())
    const encoder = refusingEncoder()
    // A zero interval: every refusal is past the interval, so each one reports
    // the count since the previous line — which proves the count is carried
    // and reset, without waiting five minutes.
    const { bus, logger, stop } = await startDispatcher({
      getRemoteFrame,
      encoder,
      refusalReportIntervalMs: 0,
    })
    bus.emit(
      makeEvent(
        {
          frame: makeFrameResult(),
          analysisResults: tracks(['x', 'y']),
          frameHandle: makeHandle(),
        },
        { type: 'device', id: 1 },
      ),
    )
    await waitFor(() => encoder.encode.mock.calls.length >= 2)
    await waitFor(
      () =>
        vi.mocked(logger.warn).mock.calls.filter(([m]) => m.startsWith('Embedding refused'))
          .length >= 2,
    )
    const counts = vi
      .mocked(logger.warn)
      .mock.calls.filter(([m]) => m.startsWith('Embedding refused'))
      .map(([, extras]) => extras?.meta?.['refused'])
    expect(counts).toEqual([1, 1])
    await stop()
  })

  it('any OTHER embed failure keeps its per-track WARN', async () => {
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(makeDecodedFrame())
    const encoder: EncoderStub = {
      encode: vi.fn().mockRejectedValue(new Error('ECONNRESET: the encoder process went away')),
      getInfo: vi.fn(),
    }
    const { bus, logger, stop } = await startDispatcher({ getRemoteFrame, encoder })
    bus.emit(
      makeEvent(
        {
          frame: makeFrameResult(),
          analysisResults: tracks(['p', 'q']),
          frameHandle: makeHandle(),
        },
        { type: 'device', id: 3 },
      ),
    )
    await waitFor(() => encoder.encode.mock.calls.length >= 2)
    await waitFor(
      () =>
        vi.mocked(logger.warn).mock.calls.filter(([m]) => m === 'Failed to embed track').length >=
        2,
    )
    expect(
      vi.mocked(logger.warn).mock.calls.filter(([m]) => m === 'Failed to embed track'),
    ).toHaveLength(2)
    expect(vi.mocked(logger.warn).mock.calls.some(([m]) => m.startsWith('Embedding refused'))).toBe(
      false,
    )
    await stop()
  })

  it('a REQUIREMENTS refusal is counted the same way — per (camera, code, model), one line, the code in meta, its own recovery', async () => {
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(makeDecodedFrame())
    const encoder: EncoderStub = {
      encode: vi
        .fn()
        .mockRejectedValue(
          embeddingRequirementsUnavailableError(
            { modelId: 'siglip2-b16-224', tower: 'image', nodeId: 'agent-b' },
            'retry in 5s — ModelDownloadService: hub unreachable',
          ),
        ),
      getInfo: vi.fn(),
    }
    const { bus, logger, stop } = await startDispatcher({ getRemoteFrame, encoder })
    bus.emit(
      makeEvent(
        {
          frame: makeFrameResult(),
          analysisResults: tracks(['r1', 'r2', 'r3']),
          frameHandle: makeHandle(),
        },
        { type: 'device', id: 9 },
      ),
    )
    await waitFor(() => encoder.encode.mock.calls.length >= 3)
    await waitFor(() => vi.mocked(logger.warn).mock.calls.length >= 1)
    const lines = vi
      .mocked(logger.warn)
      .mock.calls.filter(([m]) => m.startsWith('Embedding refused'))
    expect(lines).toHaveLength(1)
    expect(lines[0]?.[0]).toContain('requirements are unavailable')
    expect(lines[0]?.[1]).toEqual(
      expect.objectContaining({
        tags: { deviceId: 9 },
        meta: expect.objectContaining({
          code: EMBEDDING_REQUIREMENTS_UNAVAILABLE,
          modelId: 'siglip2-b16-224',
          nodeId: 'agent-b',
          refused: 1,
          recovery: expect.stringContaining('cooldown'),
        }),
      }),
    )
    expect(vi.mocked(logger.warn).mock.calls.some(([m]) => m === 'Failed to embed track')).toBe(
      false,
    )
    await stop()
    const flushed = vi
      .mocked(logger.warn)
      .mock.calls.filter(([m]) => m.startsWith('Embedding refused'))
    expect(flushed).toHaveLength(2)
    expect(flushed[1]?.[1]).toEqual(
      expect.objectContaining({
        meta: expect.objectContaining({ refused: 2, closing: 'stopped' }),
      }),
    )
  })

  it('a camera that embeds again reports its pending refusals AT ONCE (with the real window) and forgets them', async () => {
    const getRemoteFrame = vi
      .fn<(handle: FrameHandle, deviceId: number) => Promise<DecodedFrame | null>>()
      .mockResolvedValue(makeDecodedFrame())
    const encoder: EncoderStub = {
      encode: vi
        .fn()
        .mockRejectedValueOnce(FAILED)
        .mockRejectedValueOnce(FAILED)
        .mockRejectedValueOnce(FAILED)
        .mockResolvedValue({ embedding: [0, 0, 0, 0], inferenceMs: 1 }),
      getInfo: vi
        .fn()
        .mockResolvedValue({ modelId: 'siglip2-b16-224', embeddingDim: 4, ready: true }),
    }
    const { bus, logger, stop } = await startDispatcher({ getRemoteFrame, encoder })
    bus.emit(
      makeEvent(
        {
          frame: makeFrameResult(),
          analysisResults: tracks(['a', 'b', 'c']),
          frameHandle: makeHandle(),
        },
        { type: 'device', id: 4 },
      ),
    )
    await waitFor(() => encoder.encode.mock.calls.length >= 3)
    await waitFor(() => vi.mocked(logger.warn).mock.calls.length >= 1)
    // The operator resets; the next track embeds.
    bus.emit(
      makeEvent(
        { frame: makeFrameResult(), analysisResults: tracks(['d']), frameHandle: makeHandle() },
        { type: 'device', id: 4 },
      ),
    )
    await waitFor(() => encoder.encode.mock.calls.length >= 4)
    await waitFor(() => vi.mocked(logger.warn).mock.calls.length >= 2)
    const lines = vi
      .mocked(logger.warn)
      .mock.calls.filter(([m]) => m.startsWith('Embedding refused'))
    expect(lines).toHaveLength(2)
    expect(lines[1]?.[1]).toEqual(
      expect.objectContaining({
        tags: { deviceId: 4 },
        meta: expect.objectContaining({
          code: EMBEDDING_MODEL_FAILED,
          refused: 2,
          closing: 'ended',
        }),
      }),
    )
    // Nothing left to flush: stop() adds no line.
    await stop()
    expect(
      vi.mocked(logger.warn).mock.calls.filter(([m]) => m.startsWith('Embedding refused')),
    ).toHaveLength(2)
  })
})
