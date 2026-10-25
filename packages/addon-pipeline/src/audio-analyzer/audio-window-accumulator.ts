/**
 * `AudioWindowAccumulator` — per-device PCM window accumulator (S7 extraction,
 * smell #15).
 *
 * Extracted verbatim (mechanical, zero logic change) from the 8-variable
 * mutable closure that used to live inline inside `index.ts`'s
 * `subscribeAudioStream` (`pcmParts`/`accumulatedBytes`/`accumulatedMs`/
 * `windowSampleRate`/`windowChannels`/`windowTimestamp`/`windowOpen` +
 * `resetWindow`). Each decoded codec chunk is ~21–500 ms of audio; the
 * classifier needs a ~1 s frame (`AUDIO_WINDOW_TARGET_MS`) and throttles to
 * ~2 Hz internally, so raw f32le PCM is buffered here and flushed as ONE
 * `AudioChunkInput` per ~1 s window instead of per chunk.
 *
 * ## A window has ONE format (D450)
 *
 * The plane carries whatever rate the broker decodes at — 8 kHz for the
 * fleet's G.711 cameras since 2026-09-11, 16 kHz for AAC through the codec
 * session — and a live subscription can flip between the two when the
 * broker is redeployed under it. A window that mixed 16 kHz bytes with
 * 8 kHz bytes and labelled the whole thing with its first chunk's rate would
 * hand the classifier one garbage second per camera with no line saying so.
 * So a chunk whose `sampleRate` or `channels` differ from the OPEN window's
 * drops the partial window and starts a fresh one, and every format the
 * accumulator sees — the first and each change — is reported through
 * `onFormat` (the caller writes the line: the audio decision of a relay is
 * never silent, D427).
 *
 * One instance = one device's subscription lifetime — `push` is invoked
 * strictly serially by the audio-chunk poller (awaited per chunk, next tick
 * scheduled only after the previous completes), so the mutable fields never
 * race. Released (nothing to free beyond GC) when the owning subscription's
 * teardown calls `reset()`.
 *
 * ## Where this lives, and why it moved (D461)
 *
 * It lived in `pipeline-orchestrator` until 2026-09-11, which neither produced
 * nor consumed the audio — it buffered it, and the PCM crossed hub-main twice
 * for the privilege. The expansion at the flush (below) happening in a THIRD
 * process is what forced legs three and four of the plane back onto f32le
 * after D455 had already taken legs one and two off it. Here, inside
 * `audio-analyzer`, the subscriber IS the decoder: the coded bytes stay coded
 * from the broker to this flush, and the flush hands floats to a classifier in
 * the same process.
 */
import type {
  AudioChunkFormat,
  AudioChunkInput,
  AudioDetection,
  AudioResult,
  DecodedAudioChunkWire,
} from '@camstack/types'
import {
  AudioAnalysisResultSchema,
  audioChunkBytesPerSample,
  expandAudioChunkToF32le,
} from '@camstack/types'
import type { z } from 'zod'

/**
 * Window the classifier is fed. The classifier throttles to ~2 Hz internally,
 * so a ~1 s window is the unit of work regardless of the 21–500 ms chunks the
 * plane delivers. Lived in the orchestrator's `orchestrator-types.ts` until
 * D461 moved the accumulator next to the consumer that needs the floats.
 */
export const AUDIO_WINDOW_TARGET_MS = 1_000

/** The stream parameters a window is anchored to. */
export interface AudioWindowFormat {
  readonly sampleRate: number
  readonly channels: number
  /**
   * Byte format of the chunks (D455). Part of the window's IDENTITY, not a
   * label on it: concatenating one byte per sample with four and calling the
   * result 8 kHz mono is the same defect as mixing two rates, and it arrives
   * the same way — a broker redeployed under a live subscription.
   */
  readonly format: AudioChunkFormat
}

/**
 * One format observation: `from` is `null` on the first chunk of a
 * subscription; `droppedMs` is the partial window discarded because the
 * format changed under it (0 when the change landed between windows).
 */
export interface AudioWindowFormatChange {
  readonly from: AudioWindowFormat | null
  readonly to: AudioWindowFormat
  readonly droppedMs: number
}

function sameFormat(a: AudioWindowFormat, b: AudioWindowFormat): boolean {
  return a.sampleRate === b.sampleRate && a.channels === b.channels && a.format === b.format
}

export class AudioWindowAccumulator {
  private pcmParts: Uint8Array[] = []
  private accumulatedBytes = 0
  private accumulatedMs = 0
  private windowSampleRate = 0
  private windowChannels = 0
  private windowFormat: AudioChunkFormat = 'f32le'
  private windowTimestamp = 0
  private windowOpen = false
  /** Last format seen on this subscription — survives a flush, unlike the window anchor. */
  private lastFormat: AudioWindowFormat | null = null

  constructor(
    private readonly deviceId: number,
    private readonly onFormat?: (change: AudioWindowFormatChange) => void,
  ) {}

  /**
   * Append one decoded PCM chunk to the open window. Returns the flushed
   * `AudioChunkInput` once the accumulated duration reaches
   * `AUDIO_WINDOW_TARGET_MS` (and resets for the next window), else `null`
   * (accumulate-only, no flush yet).
   */
  push(chunk: DecodedAudioChunkWire): AudioChunkInput | null {
    // Copy the raw f32le bytes into a fresh Uint8Array and append to the
    // window. AudioChunkInput.data is typed as Uint8Array (not Float32Array)
    // so the MsgPack UDS transport preserves the bytes exactly: @msgpack/msgpack
    // encodes Uint8Array as a binary blob (bin type) and decodes it as
    // Uint8Array on the receiver. Sending Float32Array would cause the same
    // bin-type encoding but the receiver would get Uint8Array, causing each
    // byte (0–255) to be read as a sample value instead of each 4-byte float
    // group, producing dBFS ≈ +43.
    const byteLength = chunk.data.byteLength
    const bytes = new Uint8Array(byteLength)
    bytes.set(new Uint8Array(chunk.data.buffer, chunk.data.byteOffset, byteLength))

    // Absent means f32le (D455) — every chunk that predates the field, and
    // every chunk from the AAC codec session, which decodes to floats.
    const format: AudioChunkFormat = chunk.format ?? 'f32le'
    this.observeFormat({ sampleRate: chunk.sampleRate, channels: chunk.channels, format })

    if (!this.windowOpen) {
      // Anchor the window to the first chunk's stream params + timestamp.
      this.windowSampleRate = chunk.sampleRate
      this.windowChannels = chunk.channels
      this.windowFormat = format
      this.windowTimestamp = chunk.timestamp
      this.windowOpen = true
    }
    this.pcmParts.push(bytes)
    this.accumulatedBytes += byteLength
    const channels = chunk.channels > 0 ? chunk.channels : 1
    // Samples per byte comes from the FORMAT. A coded chunk carries one byte
    // per sample; dividing by 4 regardless would report a quarter of the
    // audio actually held and buffer four seconds before flushing one.
    const framesPerChannel = byteLength / audioChunkBytesPerSample(format) / channels
    this.accumulatedMs += (framesPerChannel / chunk.sampleRate) * 1_000

    // Below the window target: accumulate only — no flush.
    if (this.accumulatedMs < AUDIO_WINDOW_TARGET_MS) return null

    // Flush: concat the buffered chunks into one contiguous f32le window and
    // reset the accumulator BEFORE returning, so the next chunk starts a
    // fresh window immediately (no overlap — the prior per-chunk path
    // carried none). Snapshot the window params into locals first since
    // `reset` clears the shared state.
    const windowData = new Uint8Array(this.accumulatedBytes)
    let offset = 0
    for (const part of this.pcmParts) {
      windowData.set(part, offset)
      offset += part.byteLength
    }
    const flushSampleRate = this.windowSampleRate
    const flushChannels = this.windowChannels
    const flushFormat = this.windowFormat
    const flushTimestamp = this.windowTimestamp
    this.reset()

    // The analyzer cap's `AudioChunkInput` is f32le and stays f32le — that is
    // what lets the plane carry coded bytes while the analyzer runs on three
    // nodes from a bundle that may predate this code. The expansion happens
    // ONCE per window, here, next to the consumer that needs floats; measured
    // at 11.6 us per one-second window per camera, against the 24 KB per
    // window per leg it takes off two crossings of hub-main
    // (`scripts/bench-audio-g711-expand.mts`, D455).
    const data =
      flushFormat === 'f32le' ? windowData : expandAudioChunkToF32le(windowData, flushFormat)

    return {
      data,
      sampleRate: flushSampleRate,
      channels: flushChannels,
      timestamp: flushTimestamp,
      deviceId: this.deviceId,
    }
  }

  /**
   * Report the first format and every change; a change under an OPEN window
   * drops the partial window so the flushed bytes never mix two rates.
   */
  private observeFormat(format: AudioWindowFormat): void {
    const previous = this.lastFormat
    if (previous !== null && sameFormat(previous, format)) return
    const droppedMs = this.windowOpen ? Math.round(this.accumulatedMs) : 0
    if (this.windowOpen) this.reset()
    this.lastFormat = format
    this.onFormat?.({ from: previous, to: format, droppedMs })
  }

  /**
   * Drop any partially-accumulated window. Called on unsubscribe / device
   * audio stop (no trailing flush — a sub-second partial window is not worth
   * a classify during teardown) and internally after every flush.
   */
  reset(): void {
    this.pcmParts = []
    this.accumulatedBytes = 0
    this.accumulatedMs = 0
    this.windowOpen = false
  }
}

/** `audio-analyzer.analyseChunk`'s result shape — `z.infer` off the cap's own schema (never duplicated). */
export type AudioAnalysisResult = z.infer<typeof AudioAnalysisResultSchema>

/**
 * Build the canonical `AudioResult` frame from one `analyseChunk` result —
 * extracted verbatim from `subscribeAudioStream`'s result→event-payload
 * mapping. The caller wraps this in the `pipeline.audio-inference-result`
 * event; building the frame is pure and needs no controller state.
 */
export function buildAudioResultFrame(deviceId: number, result: AudioAnalysisResult): AudioResult {
  const windowId = `${deviceId}-${result.timestamp}`
  const audioDetections: AudioDetection[] = []
  let idCounter = 0
  if (result.classification && result.classification.labels.length > 0) {
    for (const label of result.classification.labels) {
      idCounter += 1
      audioDetections.push({
        id: `a${idCounter}`,
        kind: 'audio',
        macroClass: label.className,
        score: label.score,
        labels: [{ label: label.className, score: label.score }],
        startMs: 0,
        endMs: 0,
      })
    }
  }
  return {
    kind: 'audio-window',
    windowId,
    deviceId,
    timestamp: result.timestamp,
    startMs: 0,
    endMs: 0,
    level: { rms: result.level.rms, dbfs: result.level.dbfs },
    detections: audioDetections,
    // Whether the model RAN on this window (D660): an empty `detections`
    // means "heard nothing above the floor" only when this says `classified`.
    classifyOutcome: result.classifyOutcome,
    debug: result.classification
      ? {
          totalInferenceMs: result.classification.inferenceMs,
          stepTimings: [
            {
              source: 'audio-analyzer',
              ms: result.classification.inferenceMs,
              detectionCount: audioDetections.length,
            },
          ],
        }
      : undefined,
  }
}
