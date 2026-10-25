import type { ReolinkBaichuanApi } from '@apocaliss92/nodelink-js'
import type { IntercomAbility, IScopedLogger } from '@camstack/types'
import { encodeImaAdpcm } from './intercom-encoder.js'

/**
 * Wraps `ReolinkBaichuanApi.createDedicatedTalkSession` with a
 * PCM-in / ADPCM-out forwarding pump. Independent of WebRTC — the
 * caller is responsible for producing PCM s16le at the rate the
 * camera reports (`session.info.audioConfig.sampleRate`).
 *
 * Lifecycle:
 *   1. `start()` → opens the lib's dedicated talk socket, fetches
 *      the camera's negotiated audio config + block size, primes the
 *      backlog cap.
 *   2. `feedPcm(buffer)` (zero or more times) → buffers PCM, splits
 *      into block-sized chunks, encodes each chunk to IMA ADPCM,
 *      sends to the camera. Backlog clamping drops the oldest
 *      samples when the encoder/network can't keep up.
 *   3. `stop()` → closes the talk session. Idempotent.
 *
 * Every method returns / throws synchronously meaningful errors. The
 * caller drives the lifecycle (this class doesn't manage timers,
 * watchdogs, or auto-reconnect).
 */

interface TalkSession {
  readonly info: {
    readonly audioConfig: { readonly sampleRate: number }
    readonly blockSize: number
    readonly fullBlockSize: number
  }
  sendAudio(adpcm: Buffer): Promise<void>
  stop(): Promise<void>
}

interface ReolinkApiWithTalk {
  createDedicatedTalkSession(
    channel: number,
    opts: {
      blocksPerPayload?: number
      idleTimeoutMs?: number
      deviceId?: string
      logger?: { log: (msg: string, ...rest: unknown[]) => void }
    },
  ): Promise<TalkSession>
}

// Lowest-latency defaults. An earlier iteration bumped these to
// 500/4 to absorb the cross-process Opus→PCM jitter (`intercom
// backlog clamped` warnings on stalls), but the trade-off was
// noticeably more end-to-end latency — at 500ms backlog the operator
// hears their own voice ~half a second after speaking, which kills
// the intercom feel. Stay on the lower-latency defaults; operators
// with stable pipelines accept the occasional
// clamp warning, those willing to trade latency for stability raise
// the slider via the new Settings UI section.
const DEFAULT_BACKLOG_MS = 120
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

const DEFAULT_BLOCKS_PER_PAYLOAD = 1

const DEFAULT_GAIN = 1.0
const MIN_GAIN = 0.1
const MAX_GAIN = 10

export interface ReolinkIntercomSessionOptions {
  readonly channel: number
  readonly api: ReolinkBaichuanApi
  readonly logger: IScopedLogger
  /** Stable id for diagnostic logging ("camera-{deviceId}"). */
  readonly deviceTag: string
  /** Per-payload block count (1 = lowest latency, more sockets/sec).
   *  Default: 4. Range [1, 8] matches the lib. */
  readonly blocksPerPayload?: number
  /** Auto-teardown of the lib's talk socket after this many ms with
   *  no audio sent. 0 disables. Default: 30s. */
  readonly idleTimeoutMs?: number
  /** Bound on PCM backlog → trades latency for stability. Default: 500ms. */
  readonly maxBacklogMs?: number
  /** Output gain multiplier applied to PCM samples before IMA ADPCM
   *  encode. `1.0` = neutral, `2.0` ≈ +6dB. Default: 1.0 (no change). */
  readonly outputGain?: number
}

export class ReolinkIntercomSession {
  private session: TalkSession | null = null
  private pcmBuffer: Buffer = Buffer.alloc(0)
  private pumping = false
  private pumpPromise: Promise<void> | null = null
  private maxBacklogBytes = 0
  private bytesPerBlock = 0
  private blockSize = 0
  private lastBacklogClampLogAtMs = 0
  private outputGain = DEFAULT_GAIN

  constructor(private readonly opts: ReolinkIntercomSessionOptions) {}

  /** True once `start()` has resolved and not yet been `stop()`'d. */
  get isOpen(): boolean {
    return this.session !== null
  }

  /** Sample rate the camera negotiated. Throws when not started. */
  get sampleRate(): number {
    if (!this.session) throw new Error('ReolinkIntercomSession.sampleRate read before start()')
    return this.session.info.audioConfig.sampleRate
  }

  /**
   * Effective PCM backlog bound, in ms — the operator's value clamped to
   * [{@link MIN_BACKLOG_MS}, {@link MAX_BACKLOG_MS}], i.e. what the session
   * is actually enforcing rather than what it was asked for. Readable before
   * `start()` because the clamp is pure.
   */
  get backlogMs(): number {
    return clampBacklogMs(this.opts.maxBacklogMs)
  }

  /**
   * The firmware's talk-back format — `IntercomStatus.ability`. Throws before
   * `start()`, like `sampleRate`, because the rate is the camera's answer and
   * not a default.
   *
   * The field was declared, mirrored into runtime state and written by NOBODY
   * while these values were in hand and only reaching a log line (D281).
   *
   * `duplex` is the one judgement call: the Baichuan talk channel is a single
   * dedicated session and this provider enforces one at a time per camera, so
   * `half` is reported. `full` would be the dangerous direction — a consumer
   * that believes it may listen while speaking takes no lock.
   */
  get ability(): IntercomAbility {
    return {
      codecs: ['adpcm-ima'],
      sampleRate: this.sampleRate,
      duplex: 'half',
      maxBacklogMs: this.backlogMs,
    }
  }

  async start(): Promise<void> {
    if (this.session) return
    this.outputGain = clampGain(this.opts.outputGain)
    const apiTalk = this.opts.api as ReolinkApiWithTalk
    const session = await apiTalk.createDedicatedTalkSession(this.opts.channel, {
      blocksPerPayload: clampBlocks(this.opts.blocksPerPayload),
      idleTimeoutMs: this.opts.idleTimeoutMs ?? 30_000,
      deviceId: this.opts.deviceTag,
      logger: { log: (msg, ...rest) => this.opts.logger.debug(`talk: ${msg}`, { meta: { rest } }) },
    })
    const { blockSize, fullBlockSize } = session.info
    if (!Number.isFinite(blockSize) || blockSize <= 0 || fullBlockSize !== blockSize + 4) {
      try {
        await session.stop()
      } catch {
        /* swallow */
      }
      throw new Error(
        `Reolink talk session reported invalid block sizes: blockSize=${blockSize} fullBlockSize=${fullBlockSize}`,
      )
    }
    const samplesPerBlock = blockSize * 2 + 1
    this.bytesPerBlock = samplesPerBlock * 2 // Int16 PCM
    this.blockSize = blockSize
    const sampleRate = session.info.audioConfig.sampleRate
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) {
      try {
        await session.stop()
      } catch {
        /* swallow */
      }
      throw new Error(`Reolink talk session reported invalid sampleRate: ${sampleRate}`)
    }
    const wantedBacklogMs = this.backlogMs
    // bytes/sec = sampleRate * 1 channel * 2 (s16) → window the buffer accordingly
    this.maxBacklogBytes = Math.max(
      this.bytesPerBlock,
      Math.floor((wantedBacklogMs / 1000) * sampleRate * 2),
    )
    this.session = session
    this.pcmBuffer = Buffer.alloc(0)
    this.opts.logger.info('intercom talk session opened', {
      meta: {
        channel: this.opts.channel,
        sampleRate,
        blockSize,
        bytesPerBlock: this.bytesPerBlock,
        backlogMs: wantedBacklogMs,
        maxBacklogBytes: this.maxBacklogBytes,
        blocksPerPayload: clampBlocks(this.opts.blocksPerPayload),
        outputGain: this.outputGain,
      },
    })
  }

  /**
   * Feed a chunk of PCM s16le at `this.sampleRate` Hz. Returns
   * immediately after enqueueing — the actual encode + send happens
   * in a background pump. Calls before `start()` (or after `stop()`)
   * silently drop the chunk so callers don't have to gate every
   * push on `isOpen`.
   */
  feedPcm(pcm: Buffer): void {
    if (!this.session) return
    if (pcm.length === 0) return
    this.pcmBuffer = this.pcmBuffer.length ? Buffer.concat([this.pcmBuffer, pcm]) : pcm

    // Backlog clamping — drop the OLDEST samples once the buffer
    // exceeds the configured window. Aligned to 16-bit sample size
    // so the next encode pass doesn't get a half-sample.
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
    if (!this.pumping) this.startPump()
  }

  private startPump(): void {
    const session = this.session
    if (!session) return
    this.pumping = true
    this.pumpPromise = (async () => {
      try {
        // eslint-disable-next-line no-constant-condition
        while (true) {
          if (this.session !== session) return
          if (this.pcmBuffer.length < this.bytesPerBlock) return
          const chunk = this.pcmBuffer.subarray(0, this.bytesPerBlock)
          this.pcmBuffer = this.pcmBuffer.subarray(this.bytesPerBlock)
          // Subarray points into the same ArrayBuffer — no copy needed.
          const samples = new Int16Array(chunk.buffer, chunk.byteOffset, chunk.length / 2)
          // Apply operator-tunable output gain BEFORE encoding so the
          // ADPCM block predictors see the boosted/attenuated signal
          // (gain applied post-encode would corrupt the ADPCM state).
          // Equivalent to a `volume=N` ffmpeg `-filter:a` arg. `gain === 1`
          // skips the multiply pass — every other Opus frame avoids
          // a redundant Int16 multiply when the operator hasn't
          // touched the slider.
          const finalSamples =
            this.outputGain === 1 ? samples : applyGainInt16(samples, this.outputGain)
          const adpcm = encodeImaAdpcm(finalSamples, this.blockSize)
          await session.sendAudio(adpcm)
        }
      } catch (err) {
        this.opts.logger.warn('intercom pump error — stopping', {
          meta: { error: err instanceof Error ? err.message : String(err) },
        })
      } finally {
        this.pumping = false
      }
    })()
  }

  async stop(): Promise<void> {
    const session = this.session
    if (!session) return
    this.session = null
    this.pcmBuffer = Buffer.alloc(0)
    if (this.pumpPromise) {
      try {
        await Promise.race([this.pumpPromise, new Promise<void>((r) => setTimeout(r, 250))])
      } catch {
        /* swallow */
      }
      this.pumpPromise = null
    }
    try {
      await Promise.race([
        session.stop(),
        new Promise<void>((_, rej) =>
          setTimeout(() => rej(new Error('talk session stop timeout')), 2_000),
        ),
      ])
    } catch (err) {
      this.opts.logger.warn('intercom session stop error', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }
}

/** Clamp `blocksPerPayload` into the lib's accepted range. */
function clampBlocks(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_BLOCKS_PER_PAYLOAD
  return Math.max(1, Math.min(8, Math.floor(value)))
}

/** Clamp `outputGain` into the operator-safe `[0.1, 10]` band. */
function clampGain(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_GAIN
  return Math.max(MIN_GAIN, Math.min(MAX_GAIN, value))
}

/** Apply a floating-point gain to each `Int16` sample in-place into
 *  a freshly-allocated buffer. The result is hard-clipped to int16
 *  bounds — soft saturation isn't worth the tradeoff for an intercom
 *  channel where occasional clipping is preferable to a perceived
 *  loudness mismatch. */
function applyGainInt16(samples: Int16Array, gain: number): Int16Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const scaled = (samples[i] ?? 0) * gain
    out[i] = scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled
  }
  return out
}
