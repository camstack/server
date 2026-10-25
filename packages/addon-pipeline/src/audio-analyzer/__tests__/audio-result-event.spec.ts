/**
 * The canonical `pipeline.audio-inference-result` frame, asserted where it is
 * now BUILT (D461).
 *
 * Both properties below used to live in the orchestrator's
 * `detection-wiring-e2e.spec.ts`, because the orchestrator drained the
 * broker's chunk plane, accumulated the window and emitted the event. It does
 * none of those things any more — `AudioDeviceAttachments` does, inside
 * `audio-analyzer` — so asserting them over there would have meant asserting
 * them against a fake standing in for the very code that moved. They are
 * re-anchored here against the REAL poller and the REAL accumulator, with only
 * the broker's RPC surface and the inference call faked:
 *
 *   - a sub-window chunk is accumulated and nothing else — no analyse, no
 *     event. This is what keeps the classifier at ~1 Hz per camera instead of
 *     once per 21–500 ms codec chunk;
 *   - one full ~1 s window produces exactly ONE analyse and ONE event, in the
 *     canonical `AudioResult` shape the recorder's band decision,
 *     pipeline-analytics and the HA export all read.
 *
 * The attachment LIFECYCLE — the `accept` declaration, the node pin, attach by
 * replacement, detach releasing the broker FIFO, the shutdown refusal, the
 * boundary-aware poll rate — is `audio-device-attachments.spec.ts`. This file
 * is only about the frame that comes out.
 */
import type {
  AddonApi,
  AudioAnalysisSettings,
  AudioChunkInput,
  AudioResult,
  DecodedAudioChunkWire,
  IScopedLogger,
} from '@camstack/types'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AudioDeviceAttachments } from '../audio-device-attachments.js'
import type { AudioAnalysisResult } from '../audio-window-accumulator.js'

const DEVICE_ID = 101
const BROKER_ID = '101/sub'
const SETTINGS: AudioAnalysisSettings = { minConfidence: 0.3, allowedClasses: [] }

function mockLogger(): IScopedLogger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: vi.fn(function (this: unknown) {
      return this
    }),
    withTags: vi.fn(function (this: unknown) {
      return this
    }),
  }
  return logger as unknown as IScopedLogger
}

/** One emitted result, captured with the device it was emitted for. */
interface EmittedResult {
  readonly deviceId: number
  readonly frame: AudioResult
}

interface FakeBrokerApi {
  readonly api: AddonApi
  /** Hand the poller one chunk on its next `pullAudioChunks`. */
  readonly enqueue: (chunk: DecodedAudioChunkWire) => void
  readonly unsubscribeAudioChunks: ReturnType<typeof vi.fn>
}

/**
 * The broker's three RPCs, and nothing else.
 *
 * The cast is the same one `audio-chunk-poller.spec.ts` makes two files over:
 * `AddonApi` is the whole generated cross-addon surface, and a test that
 * needs three of its methods cannot spell the other few hundred. It is
 * confined to this helper so no assertion below depends on it.
 */
function makeFakeBrokerApi(): FakeBrokerApi {
  const queue: DecodedAudioChunkWire[] = []
  const unsubscribeAudioChunks = vi.fn().mockResolvedValue(undefined)
  const api = {
    streamBroker: {
      subscribeAudioChunks: { mutate: vi.fn().mockResolvedValue({ subscriptionId: 'sub-1' }) },
      pullAudioChunks: { query: vi.fn().mockImplementation(async () => queue.splice(0)) },
      unsubscribeAudioChunks: { mutate: unsubscribeAudioChunks },
    },
  } as unknown as AddonApi
  return { api, enqueue: (chunk) => queue.push(chunk), unsubscribeAudioChunks }
}

/**
 * A sub-window f32le chunk: 2 samples. Far below `AUDIO_WINDOW_TARGET_MS`, so
 * the accumulator must hold it and flush nothing.
 */
function subWindowChunk(timestamp: number): DecodedAudioChunkWire {
  return { data: new Uint8Array(8), sampleRate: 16_000, channels: 1, timestamp }
}

/**
 * A single chunk carrying a full ~1 s window: 16 kHz mono f32le → 16000 frames
 * × 4 bytes = 64000 bytes = exactly 1000 ms, which is the window target.
 */
function fullWindowChunk(timestamp: number): DecodedAudioChunkWire {
  const sampleRate = 16_000
  return {
    data: new Uint8Array(sampleRate * 4),
    sampleRate,
    channels: 1,
    timestamp,
  }
}

interface Harness {
  readonly attachments: AudioDeviceAttachments
  readonly broker: FakeBrokerApi
  readonly emitted: readonly EmittedResult[]
  readonly analyse: ReturnType<typeof vi.fn>
}

function makeHarness(result: AudioAnalysisResult): Harness {
  const broker = makeFakeBrokerApi()
  const emitted: EmittedResult[] = []
  const analyse = vi
    .fn()
    .mockImplementation(async (_chunk: AudioChunkInput, _settings: AudioAnalysisSettings) => result)
  const attachments = new AudioDeviceAttachments({
    api: () => broker.api,
    localNodeId: () => 'hub',
    logger: mockLogger(),
    analyse,
    emitResult: (deviceId, frame) => emitted.push({ deviceId, frame }),
  })
  return { attachments, broker, emitted, analyse }
}

describe('AudioDeviceAttachments — the canonical audio-inference-result frame', () => {
  const live: AudioDeviceAttachments[] = []

  afterEach(() => {
    for (const attachments of live.splice(0)) attachments.detachAll()
  })

  it('accumulates a sub-window chunk and emits NOTHING — the classifier stays at ~1 Hz', async () => {
    const harness = makeHarness({
      level: { rms: 0.42, dbfs: -12 },
      classifyOutcome: { state: 'classified' },
      classification: { labels: [{ className: 'speech', score: 0.91 }], inferenceMs: 3 },
      timestamp: 123_455,
    })
    live.push(harness.attachments)

    expect(
      harness.attachments.attach({
        deviceId: DEVICE_ID,
        brokerId: BROKER_ID,
        ingestNodeId: 'hub',
        settings: SETTINGS,
      }),
    ).toEqual({ attached: true, replaced: false })

    harness.broker.enqueue(subWindowChunk(123_455))
    // Two poll intervals is enough for the chunk to have been drained and
    // pushed; if a flush were going to happen it would have happened by now.
    await new Promise((resolve) => setTimeout(resolve, 500))

    expect(harness.analyse).not.toHaveBeenCalled()
    expect(harness.emitted).toHaveLength(0)
  })

  it('emits exactly ONE canonical frame per ~1 s window', async () => {
    const harness = makeHarness({
      level: { rms: 0.42, dbfs: -12 },
      classifyOutcome: { state: 'classified' },
      classification: {
        labels: [
          { className: 'speech', score: 0.91 },
          { className: 'music', score: 0.05 },
        ],
        inferenceMs: 7,
      },
      timestamp: 123_456,
    })
    live.push(harness.attachments)

    harness.attachments.attach({
      deviceId: DEVICE_ID,
      brokerId: BROKER_ID,
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })

    harness.broker.enqueue(fullWindowChunk(123_456))
    await vi.waitFor(() => expect(harness.emitted).toHaveLength(1))

    expect(harness.analyse).toHaveBeenCalledTimes(1)
    // The settings resolved ONCE at attach time travel with every window —
    // the analyzer does not re-resolve per window, a settings change
    // re-attaches.
    expect(harness.analyse.mock.calls[0]![1]).toEqual(SETTINGS)

    const emitted = harness.emitted[0]!
    expect(emitted.deviceId).toBe(DEVICE_ID)
    const frame = emitted.frame
    expect(frame.kind).toBe('audio-window')
    expect(frame.deviceId).toBe(DEVICE_ID)
    expect(frame.level?.dbfs).toBe(-12)
    expect(frame.level?.rms).toBe(0.42)
    expect(frame.detections).toHaveLength(2)
    expect(frame.detections[0]!.macroClass).toBe('speech')
    expect(frame.detections[0]!.score).toBe(0.91)
    expect(frame.detections[0]!.kind).toBe('audio')
    expect(frame.detections[0]!.id).toBe('a1')
    expect(frame.detections[1]!.id).toBe('a2')
    // Canonical debug surface: stepTimings tagged with the analyzer addon id
    // (the "audio-classifier" pipeline step lives inside the analyzer, so the
    // producing ADDON is recorded, not the step).
    expect(frame.debug?.totalInferenceMs).toBe(7)
    expect(frame.debug?.stepTimings?.[0]?.source).toBe('audio-analyzer')
    expect(frame.debug?.stepTimings?.[0]?.detectionCount).toBe(2)
  })

  it('emits a frame with zero detections when the analyzer classifies nothing', async () => {
    const harness = makeHarness({
      level: { rms: 0.1, dbfs: -40 },
      classifyOutcome: { state: 'classified' },
      timestamp: 123_457,
    })
    live.push(harness.attachments)

    harness.attachments.attach({
      deviceId: DEVICE_ID,
      brokerId: BROKER_ID,
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })

    harness.broker.enqueue(fullWindowChunk(123_457))
    await vi.waitFor(() => expect(harness.emitted).toHaveLength(1))

    const frame = harness.emitted[0]!.frame
    expect(frame.detections).toHaveLength(0)
    expect(frame.level?.dbfs).toBe(-40)
    // A level-only window still reaches the bus — that is what keeps the
    // watchdog's audio stage fed for a camera that is merely quiet (D461).
    // No classification → no debug surface to report.
    expect(frame.debug).toBeUndefined()
  })

  it('stamps whether the model RAN, so an unclassified window never reads as a quiet one (D660)', async () => {
    const harness = makeHarness({
      level: { rms: 0.3, dbfs: -10 },
      classifyOutcome: { state: 'not-classified', reason: 'superseded' },
      timestamp: 123_458,
    })
    live.push(harness.attachments)
    harness.attachments.attach({
      deviceId: DEVICE_ID,
      brokerId: BROKER_ID,
      ingestNodeId: 'hub',
      settings: SETTINGS,
    })
    harness.broker.enqueue(fullWindowChunk(123_458))
    await vi.waitFor(() => expect(harness.emitted).toHaveLength(1))

    const frame = harness.emitted[0]!.frame
    expect(frame.detections).toHaveLength(0)
    expect(frame.classifyOutcome).toEqual({ state: 'not-classified', reason: 'superseded' })
  })
})
