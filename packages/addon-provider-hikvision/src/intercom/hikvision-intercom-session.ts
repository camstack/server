/**
 * HikvisionIntercomSession — wraps Hikvision's ISAPI two-way audio
 * channel (`/ISAPI/System/TwoWayAudio/channels/{id}/...`) with a
 * PCM-in / G.711-out forwarding pump.
 *
 * Wire shape, per Hikvision firmware:
 *   1. GET    `/channels`             → discover negotiated audio codec
 *   2. PUT    `/channels/{id}/open`   → arm the channel
 *   3. PUT    `/channels/{id}/audioData` (sticky body) → encoded bytes
 *   4. PUT    `/channels/{id}/close`  → release the channel
 *
 * Lifecycle (mirrors `ReolinkIntercomSession`'s public surface so the
 * shared orchestrator can drive both):
 *   - `start()`   → discover codec, open channel, open sticky PUT,
 *                   prime backlog cap.
 *   - `feedPcm()` → enqueue PCM s16le @ 8 kHz mono, encode to G.711,
 *                   accumulate the encoded bytes and flush them into the
 *                   sticky PUT body in FIXED 1024-byte chunks. PCM backlog clamping drops the oldest
 *                   samples when the encoder/network can't keep up.
 *   - `stop()`    → flush any sub-chunk remainder, end the sticky PUT
 *                   body, then PUT `/close`. Idempotent.
 *
 * The session deliberately knows NOTHING about WebRTC, audio-codec
 * decode sessions, or the broker. The orchestrator owns those pieces;
 * this class is the camera-facing leg only.
 */

import type { IntercomAbility, IScopedLogger } from '@camstack/types'
import type { AudioDataStream, HikvisionTwoWayAudioChannel } from '../hikvision-isapi-client.js'
import {
  encodePcm16,
  type HikvisionAudioCodec,
  resolveHikvisionAudioCodec,
} from './g711-encoder.js'
import type { IntercomCloseReason } from './intercom-orchestrator.js'

/** Notification a camera-initiated teardown surfaces to subscribers. */
export interface HikvisionIntercomCloseInfo {
  readonly reason: IntercomCloseReason
  readonly error?: unknown
}

/**
 * The narrow ISAPI surface the intercom session drives. Declaring just
 * the four methods it actually uses (instead of the whole
 * `HikvisionIsapiClient`) keeps the dependency honest and lets tests
 * supply a clean fake without casting a partial object. The real
 * `HikvisionIsapiClient` structurally satisfies this.
 */
export interface HikvisionIntercomClient {
  listTwoWayAudioChannels(): Promise<readonly HikvisionTwoWayAudioChannel[]>
  openTwoWayAudio(channelId: string): Promise<void>
  closeTwoWayAudio(channelId: string): Promise<void>
  openAudioDataStream(channelId: string): AudioDataStream
}

const DEFAULT_BACKLOG_MS = 200
const MAX_BACKLOG_MS = 5_000
const MIN_BACKLOG_MS = 20

/**
 * The ONE place the operator's backlog request becomes the enforced bound.
 * `start()` sizes the byte window from it and `ability.maxBacklogMs` reports
 * it — a second clamp would let the number a caller reads drift from the
 * number the buffer honours.
 */
function clampBacklogMs(requested: number | undefined): number {
  return Math.max(MIN_BACKLOG_MS, Math.min(MAX_BACKLOG_MS, requested ?? DEFAULT_BACKLOG_MS))
}

/**
 * Fixed audioData PUT-body chunk size, in bytes. Encoded µ-law bytes are
 * accumulated and flushed to the sticky PUT in FIXED chunks of this size
 * (the sub-chunk remainder is held until the next flush, and the trailing
 * remainder is flushed on `stop()`). Hikvision's audioData reader is
 * happiest with steady, fixed-size writes — variable-size per-frame
 * writes are what we're moving away from here.
 */
export const AUDIO_DATA_CHUNK_BYTES = 1024

/**
 * Hikvision two-way audio is locked to 8 kHz mono on every model we've
 * probed (G.711 µ-law / A-law). The audio-codec cap MUST resample to
 * this rate before feeding PCM into `feedPcm()`; the orchestrator
 * passes the value into `createDecodeSession` as `targetSampleRate`.
 */
export const HIKVISION_INTERCOM_SAMPLE_RATE = 8_000

export interface HikvisionIntercomSessionOptions {
  readonly client: HikvisionIntercomClient
  readonly logger: IScopedLogger
  /** Stable id for diagnostic logging ("camera-{deviceId}"). */
  readonly deviceTag: string
  /** Channel id to open. Defaults to `'1'` (single-cam standard). */
  readonly channelId?: string
  /** Bound on PCM backlog → trades latency for stability. Default: 200ms. */
  readonly maxBacklogMs?: number
  /**
   * Force a specific codec, bypassing `/TwoWayAudio/channels` discovery.
   * Useful for older firmwares whose channel list 404s but accept
   * `audioData` writes regardless. Leave unset to auto-discover.
   */
  readonly forcedCodec?: HikvisionAudioCodec
}

export class HikvisionIntercomSession {
  private stream: AudioDataStream | null = null
  private channelId: string | null = null
  private codec: HikvisionAudioCodec = 'g711ulaw'
  private pcmBuffer: Buffer = Buffer.alloc(0)
  /**
   * Encoded µ-law backlog awaiting a fixed-size flush. Holds the
   * sub-{@link AUDIO_DATA_CHUNK_BYTES} remainder between feeds; drained
   * in 1024-byte chunks by `flushEncoded()` and emptied on `stop()`.
   */
  private encodedBuffer: Buffer = Buffer.alloc(0)
  private maxBacklogBytes = 0
  private bytesPerSecond = 0
  private lastBacklogClampLogAtMs = 0
  private streamErrored = false
  /** Throttled per-frame stats — total µ-law bytes FLUSHED to the PUT. */
  private ulawBytesWritten = 0
  private lastStatsLogAtMs = 0
  private lastStatsUlawBytes = 0
  private readonly closeListeners: Array<(info: HikvisionIntercomCloseInfo) => void> = []

  constructor(private readonly opts: HikvisionIntercomSessionOptions) {}

  /** True once `start()` has resolved and not yet been `stop()`'d. */
  get isOpen(): boolean {
    return this.stream !== null
  }

  /**
   * Subscribe to a camera-initiated teardown (sticky audioData PUT
   * closed/errored). The orchestrator wires this to tear the whole
   * session down with a precise reason. Fires at most once per stream.
   */
  onClose(cb: (info: HikvisionIntercomCloseInfo) => void): void {
    this.closeListeners.push(cb)
  }

  private notifyClose(info: HikvisionIntercomCloseInfo): void {
    for (const cb of this.closeListeners) {
      try {
        cb(info)
      } catch {
        /* swallow — diagnostic listener */
      }
    }
  }

  /**
   * Sample rate the camera negotiated. Hikvision's ISAPI two-way audio
   * is fixed at 8 kHz mono regardless of the parent stream's audio
   * config — exposed as a getter to mirror `ReolinkIntercomSession`.
   */
  get sampleRate(): number {
    return HIKVISION_INTERCOM_SAMPLE_RATE
  }

  /** Wire codec the session resolved (g711ulaw / g711alaw). */
  get audioCodec(): HikvisionAudioCodec {
    return this.codec
  }

  /**
   * Effective PCM backlog bound, in ms — the operator's value clamped to
   * [{@link MIN_BACKLOG_MS}, {@link MAX_BACKLOG_MS}], i.e. what the session is
   * actually enforcing rather than what it was asked for. Readable before
   * `start()` because the clamp is pure.
   */
  get backlogMs(): number {
    return clampBacklogMs(this.opts.maxBacklogMs)
  }

  /**
   * The firmware's talk-back format — `IntercomStatus.ability`.
   *
   * Every field is a value this session already resolved against the camera;
   * nothing here is a default standing in for a probe. It was declared,
   * mirrored into runtime state and written by NOBODY while these exact
   * values were in hand and only reaching a log line (D281).
   *
   * `duplex` is the one judgement call: ISAPI two-way audio is a single
   * `audioData` channel and the provider enforces one active session per
   * camera, so `half` is reported. `full` would be the dangerous direction —
   * a consumer that believes it may listen while speaking takes no lock.
   */
  get ability(): IntercomAbility {
    return {
      codecs: [this.codec],
      sampleRate: HIKVISION_INTERCOM_SAMPLE_RATE,
      duplex: 'half',
      maxBacklogMs: this.backlogMs,
    }
  }

  async start(): Promise<void> {
    if (this.stream) return
    const desiredChannel = this.opts.channelId ?? '1'

    // 1. Discover codec. Older Hikvision firmwares (DS-7600 series) 404
    //    on `/TwoWayAudio/channels`; we tolerate that and fall back to
    //    µ-law (Hikvision firmware default when the TwoWayAudio endpoint is absent).
    if (this.opts.forcedCodec) {
      this.codec = this.opts.forcedCodec
      this.channelId = desiredChannel
      this.opts.logger.info('intercom: TwoWayAudio channel spec (forced)', {
        meta: {
          deviceTag: this.opts.deviceTag,
          channelId: desiredChannel,
          codec: this.codec,
          forced: true,
        },
      })
    } else {
      try {
        const channels = await this.opts.client.listTwoWayAudioChannels()
        const match = channels.find((c) => c.id === desiredChannel) ?? channels[0]
        if (!match) {
          throw new Error('hikvision intercom: no TwoWayAudio channels advertised by camera')
        }
        this.channelId = match.id
        this.codec = resolveHikvisionAudioCodec(match.audioCompressionType)
        // Channel spec at open — the `enabled:false` case is a prime
        // suspect for "intercom deactivates immediately" (the camera
        // arms then refuses audioData).
        const level = match.enabled === false ? 'warn' : 'info'
        this.opts.logger[level]('intercom: TwoWayAudio channel spec', {
          meta: {
            deviceTag: this.opts.deviceTag,
            channelId: match.id,
            audioCompressionType: match.audioCompressionType,
            resolvedCodec: this.codec,
            enabled: match.enabled ?? null,
            channelCount: channels.length,
          },
        })
      } catch (err) {
        this.opts.logger.warn(
          'intercom: TwoWayAudio channel discovery failed — defaulting to g711ulaw',
          {
            meta: {
              deviceTag: this.opts.deviceTag,
              channelId: desiredChannel,
              error: err instanceof Error ? err.message : String(err),
            },
          },
        )
        this.channelId = desiredChannel
        this.codec = 'g711ulaw'
      }
    }
    const channelId = this.channelId

    // 2. Arm the channel. Failure here is fatal — the sticky PUT below
    //    relies on the camera being in TwoWayAudio mode.
    await this.opts.client.openTwoWayAudio(channelId)

    // 3. Open the sticky audioData PUT and wire its lifecycle.
    const stream = this.opts.client.openAudioDataStream(channelId)
    // The PUT lifecycle (open / response / end) is logged inside the
    // ISAPI client; here we classify the END cause into an intercom
    // close reason so the orchestrator can name WHY the talk leg died:
    //   - camera-response (while we still had the body open) → the
    //     camera tore down the sticky PUT → `remote-closed-put`
    //   - socket-error                                       → `put-error`
    //   - local-end (we called end())                        → expected,
    //     no teardown needed.
    stream.onClosed((info) => {
      if (info.cause === 'local-end') return
      if (this.streamErrored) return
      this.streamErrored = true
      const reason: IntercomCloseReason =
        info.cause === 'socket-error' ? 'put-error' : 'remote-closed-put'
      this.opts.logger.warn('intercom: audioData PUT closed by camera — tearing down talk leg', {
        meta: {
          deviceTag: this.opts.deviceTag,
          channelId,
          cause: info.cause,
          statusCode: info.statusCode,
          reason,
          error: info.error?.message,
        },
      })
      this.notifyClose({ reason, error: info.error })
      // Best-effort local teardown; the orchestrator drives the full
      // session stop via `onClose`, but ending our own stream is safe
      // and idempotent.
      void this.stop(reason).catch(() => {
        /* swallow */
      })
    })

    const wantedBacklogMs = this.backlogMs
    // PCM s16le mono → 2 bytes per sample; sample rate is the cap.
    this.bytesPerSecond = HIKVISION_INTERCOM_SAMPLE_RATE * 2
    this.maxBacklogBytes = Math.max(
      // Always allow at least one full frame's worth (10ms = 80 samples = 160 bytes).
      160,
      Math.floor((wantedBacklogMs / 1000) * this.bytesPerSecond),
    )
    this.stream = stream
    this.pcmBuffer = Buffer.alloc(0)
    this.encodedBuffer = Buffer.alloc(0)
    this.streamErrored = false
    this.ulawBytesWritten = 0
    this.lastStatsLogAtMs = Date.now()
    this.lastStatsUlawBytes = 0
    this.opts.logger.info('intercom talk session opened', {
      meta: {
        deviceTag: this.opts.deviceTag,
        channelId,
        codec: this.codec,
        sampleRate: HIKVISION_INTERCOM_SAMPLE_RATE,
        targetRate: HIKVISION_INTERCOM_SAMPLE_RATE,
        backlogMs: wantedBacklogMs,
        maxBacklogBytes: this.maxBacklogBytes,
      },
    })
  }

  /**
   * Feed a chunk of PCM s16le @ 8 kHz mono. Returns immediately after
   * enqueueing — encode happens synchronously on the same tick because
   * G.711 is byte-cheap. The encoded µ-law bytes are appended to an
   * internal backlog and flushed to the PUT body in FIXED
   * {@link AUDIO_DATA_CHUNK_BYTES}-byte chunks; any sub-chunk remainder
   * is held until the next feed or
   * `stop()`. Calls before `start()` (or after `stop()`) silently drop
   * the chunk.
   */
  feedPcm(pcm: Buffer): void {
    if (!this.stream) return
    if (pcm.length === 0) return
    if ((pcm.length & 1) !== 0) {
      // Half-sample at the tail would corrupt encode alignment — drop
      // the last byte rather than smear it across the next chunk.
      pcm = pcm.subarray(0, pcm.length - 1)
      if (pcm.length === 0) return
    }
    this.pcmBuffer = this.pcmBuffer.length ? Buffer.concat([this.pcmBuffer, pcm]) : pcm

    // Backlog clamping (safety bound) — drop the OLDEST samples once the
    // PCM buffer exceeds the configured window, before we encode them.
    // This bounds memory on a slow/stalled link; under normal flow the
    // buffer is drained to empty every feed (encode is synchronous), so
    // this only trips when the wire can't keep up. Aligned to 16-bit
    // sample size so the next encode pass doesn't get a half-sample.
    if (this.pcmBuffer.length > this.maxBacklogBytes) {
      const keep = this.maxBacklogBytes - (this.maxBacklogBytes % 2)
      const dropped = this.pcmBuffer.length - keep
      this.pcmBuffer = this.pcmBuffer.subarray(this.pcmBuffer.length - keep)
      const now = Date.now()
      if (now - this.lastBacklogClampLogAtMs > 2_000) {
        this.lastBacklogClampLogAtMs = now
        this.opts.logger.warn('intercom backlog clamped (dropping PCM)', {
          meta: { droppedBytes: dropped, keptBytes: keep, maxBytes: this.maxBacklogBytes },
        })
      }
    }

    // Encode synchronously. G.711 is one byte per sample — there's no
    // rate limiting needed; the underlying TCP socket will backpressure
    // via `write()` returning false (we honour neither direction
    // explicitly because the PCM backlog clamp above already bounds
    // memory usage on slow links).
    let encoded: Buffer
    try {
      encoded = encodePcm16(this.pcmBuffer, this.codec)
    } catch (err) {
      // A G.711 encode throw is session-fatal (misaligned/garbage PCM).
      // Surface it instead of letting the chunk vanish silently.
      this.opts.logger.error('intercom: G.711 encode error — tearing down talk leg', {
        meta: {
          deviceTag: this.opts.deviceTag,
          channelId: this.channelId,
          codec: this.codec,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      this.notifyClose({ reason: 'codec-error', error: err })
      void this.stop('codec-error').catch(() => {
        /* swallow */
      })
      return
    }
    this.pcmBuffer = Buffer.alloc(0)
    if (encoded.length > 0) {
      // Accumulate encoded µ-law and flush in fixed 1024-byte chunks.
      this.encodedBuffer = this.encodedBuffer.length
        ? Buffer.concat([this.encodedBuffer, encoded])
        : encoded
      this.flushEncoded()
      this.maybeLogStats()
    }
  }

  /**
   * Push pre-encoded G.711 bytes directly onto the wire, skipping the
   * internal PCM→µ-law encoder. Used by the cap's `pushTalkAudio` path
   * when the caller declares a wire codec that matches the camera's
   * negotiated codec (passthrough zero-decode): no resample, no PCM
   * intermediate, just append to the encodedBuffer and flush in fixed
   * {@link AUDIO_DATA_CHUNK_BYTES} chunks like any other write.
   *
   * The caller is responsible for matching `audioCodec` (µ-law vs A-law)
   * — the session does NOT validate the bytes because µ-law and A-law
   * have identical byte rates / framing and the validation would have
   * to decode + re-classify, defeating the purpose of passthrough.
   */
  feedEncoded(encoded: Buffer): void {
    if (!this.stream) return
    if (encoded.length === 0) return
    this.encodedBuffer = this.encodedBuffer.length
      ? Buffer.concat([this.encodedBuffer, encoded])
      : encoded
    this.flushEncoded()
    this.maybeLogStats()
  }

  /**
   * Drain the encoded backlog to the PUT body in FIXED
   * {@link AUDIO_DATA_CHUNK_BYTES}-byte chunks, holding the sub-chunk
   * remainder for the next flush. No-op once
   * the stream is gone. Returns true if any bytes were written.
   */
  private flushEncoded(): boolean {
    const stream = this.stream
    if (!stream) return false
    let wrote = false
    while (this.encodedBuffer.length >= AUDIO_DATA_CHUNK_BYTES) {
      const chunk = this.encodedBuffer.subarray(0, AUDIO_DATA_CHUNK_BYTES)
      this.encodedBuffer = this.encodedBuffer.subarray(AUDIO_DATA_CHUNK_BYTES)
      stream.write(chunk)
      this.ulawBytesWritten += chunk.length
      wrote = true
    }
    return wrote
  }

  /**
   * Throttled (≤ once per 2s) per-frame stats so the log shows whether
   * encoded µ-law bytes actually flow to the PUT or have stalled. Pairs
   * with the orchestrator's `framesPushed`/`pcmBytesPushed` tick.
   */
  private maybeLogStats(): void {
    const now = Date.now()
    if (now - this.lastStatsLogAtMs < 2_000) return
    const delta = this.ulawBytesWritten - this.lastStatsUlawBytes
    this.lastStatsLogAtMs = now
    this.lastStatsUlawBytes = this.ulawBytesWritten
    this.opts.logger.info('intercom talk audioData stats', {
      meta: {
        deviceTag: this.opts.deviceTag,
        channelId: this.channelId,
        codec: this.codec,
        ulawBytesWritten: this.ulawBytesWritten,
        ulawBytesDelta: delta,
      },
    })
  }

  /**
   * Tear down in reverse order: end the sticky PUT body so the camera
   * stops reading from us, then PUT `/close` to release the channel.
   * Idempotent — calling twice is safe. `reason` is recorded in the
   * teardown log so a normal stop is distinguishable from a failure.
   */
  async stop(reason: IntercomCloseReason = 'user-stop'): Promise<void> {
    const stream = this.stream
    const channelId = this.channelId
    // FINAL FLUSH — push any sub-1024 remainder onto the wire before we
    // end the body, so the camera receives the tail of the talk burst.
    // Done while `this.stream` is still set so the write actually lands.
    if (stream && this.encodedBuffer.length > 0) {
      const tail = this.encodedBuffer
      this.encodedBuffer = Buffer.alloc(0)
      try {
        stream.write(tail)
        this.ulawBytesWritten += tail.length
      } catch {
        /* swallow — stream may already be tearing down */
      }
    }
    this.stream = null
    this.pcmBuffer = Buffer.alloc(0)
    this.encodedBuffer = Buffer.alloc(0)
    if (stream || channelId) {
      this.opts.logger.info('intercom talk session stopping', {
        meta: {
          deviceTag: this.opts.deviceTag,
          channelId,
          reason,
          ulawBytesWritten: this.ulawBytesWritten,
        },
      })
    }
    if (stream) {
      try {
        stream.end()
      } catch {
        /* swallow */
      }
      // Wait briefly for the response so the socket gets drained, but
      // never block teardown on a misbehaving camera.
      try {
        await Promise.race([
          stream.responsePromise.then(() => undefined),
          new Promise<void>((r) => setTimeout(r, 250)),
        ])
      } catch {
        /* swallow */
      }
    }
    if (channelId) {
      try {
        await Promise.race([
          this.opts.client.closeTwoWayAudio(channelId),
          new Promise<void>((_, rej) =>
            setTimeout(() => rej(new Error('hikvision close timeout')), 2_000),
          ),
        ])
      } catch (err) {
        this.opts.logger.warn('intercom session close error', {
          meta: {
            channelId,
            error: err instanceof Error ? err.message : String(err),
          },
        })
      }
      this.channelId = null
    }
  }
}
