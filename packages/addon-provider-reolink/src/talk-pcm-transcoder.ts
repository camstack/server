/**
 * `TalkPcmTranscoder` — the one place a raw-PCM talk frame arriving at the
 * WRONG sample rate becomes a frame the camera's talk channel can consume.
 *
 * ## What it replaced
 *
 * Both intercom providers carried the same branch, word for word:
 *
 *     intercom: s16le sampleRate mismatch (PCM-only resample not implemented) — dropping
 *
 * The refusal was correct — playing 22 050 Hz samples into an 8 kHz channel is
 * chipmunk audio, and wrong audio is worse than none. What was missing was the
 * conversion, because `audio-codec`'s catalogue had no linear-PCM entry, so the
 * provider whose docblock promised "transcode via the `audio-codec` cap" had
 * nothing to call. HomeKit and Alexa raw-PCM talk-back went through that branch
 * on every frame (D281).
 *
 * ## The shape is copied, not invented
 *
 * This is the `opusDecode` discipline the same two providers already run for
 * encoded frames: an `audio-codec` decode session created LAZILY on the first
 * frame that needs it, reused for the rest of the talk session, keyed by the
 * source rate, and torn down with the talk session **and on error**. A
 * `{pcm_s16le, 22050 → 8000, s16le}` decode session is a pure libswresample
 * pass — the codec stage is a passthrough. **No resampler is written here**;
 * there is no sample-rate arithmetic in this file at all.
 *
 * ## Refusal survives
 *
 * Every path that cannot convert returns a REASON string, logs it with
 * `tags: { deviceId }`, and feeds the transport nothing. The caller counts that
 * reason through `failure-contribution`. Silent success at the wrong rate is
 * the one outcome this file must never produce, so a frame is fed to the
 * transport only after the codec cap handed the bytes back.
 *
 * ## Rate changes mid-session
 *
 * A decode session is pinned to one source rate at creation. A caller that
 * renegotiates (HAP does, between 16 kHz and 24 kHz) gets the old session
 * closed and a new one opened at the new rate, rather than a silently
 * mislabelled resampler — the failure mode that made the Opus path write zero
 * bytes to the camera until `sourceSampleRate` was pinned to 48 kHz.
 */
import type { IScopedLogger } from '@camstack/types'
import type { IntercomAudioCodecApi } from './intercom-orchestrator.js'

/** libav codec name of a linear little-endian 16-bit PCM decode session. */
export const TALK_PCM_CODEC = 'pcm_s16le'

/**
 * PCM chunks drained per pushed frame. The codec session emits at most a
 * frame's worth per push; the headroom covers a resampler that batches its
 * output, and matches the `maxCount` the Opus branch already uses.
 */
export const TALK_PCM_PULL_MAX_CHUNKS = 8

/** The transcoder was already closed — the talk session ended under the push. */
export const REASON_PCM_CLOSED = 'pcm-transcoder-closed'
/** The caller's declared source rate is not a usable positive integer. */
export const REASON_PCM_BAD_RATE = 'pcm-bad-source-rate'
/** The frame is empty or holds half a sample — malformed, not convertible. */
export const REASON_PCM_ODD_BYTES = 'pcm-odd-bytes'
/** No `audio-codec` provider is mounted on this cluster. */
export const REASON_PCM_NO_CODEC_CAP = 'pcm-audio-codec-unavailable'
/** The codec cap refused to open a linear-PCM decode session. */
export const REASON_PCM_SESSION_OPEN_FAILED = 'pcm-resample-session-failed'
/** The push/pull round-trip through the codec cap threw. */
export const REASON_PCM_CONVERT_FAILED = 'pcm-resample-failed'

/** One raw-PCM talk frame, as the provider received it off the cap. */
export interface TalkPcmFrame {
  /** Interleaved mono `s16le` bytes for ONE frame. */
  readonly pcm: Buffer
  /** The rate those bytes are AT, per the caller. Never assumed. */
  readonly sourceSampleRate: number
}

/** Everything the transcoder needs, supplied by the provider that owns it. */
export interface TalkPcmTranscoderOptions {
  /** Numeric device id — stamped on every line this file logs. */
  readonly deviceId: number
  readonly logger: IScopedLogger
  /**
   * Resolves the `audio-codec` cap router. Called per use rather than held,
   * so a cap that mounts after the talk session opened is picked up and a
   * missing one surfaces at the frame that needed it.
   */
  readonly resolveAudioCodec: () => IntercomAudioCodecApi
  /**
   * The rate the camera's talk channel consumes, in Hz. The PROVIDER supplies
   * it — this knowledge never leaves the provider, which is the promise the
   * `intercom` cap docblock makes to its callers.
   */
  readonly targetSampleRate: number
  /** Stamped on the codec session so `listActiveSessions` can name the owner. */
  readonly tag: string
  /**
   * Hands converted PCM to the camera transport. Called once per chunk the
   * codec cap returned, and never on a refusal.
   */
  readonly feed: (pcm: Buffer) => void
}

/** The lazily-opened `audio-codec` decode session, pinned to one source rate. */
interface ActiveResampleSession {
  readonly sessionId: string
  readonly nodeId: string
  readonly sourceSampleRate: number
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class TalkPcmTranscoder {
  private active: ActiveResampleSession | null = null
  private closed = false

  constructor(private readonly opts: TalkPcmTranscoderOptions) {}

  /** The open codec session, or `null` before the first converted frame. */
  get sessionId(): string | null {
    return this.active?.sessionId ?? null
  }

  /**
   * Convert one frame to the camera's rate and hand every produced chunk to
   * `feed`.
   *
   * Returns `null` when the frame was converted and fed, or the REASON string
   * it was refused for — already logged, with nothing fed.
   */
  async feedResampled(frame: TalkPcmFrame): Promise<string | null> {
    if (this.closed) {
      this.refuse(REASON_PCM_CLOSED, {})
      return REASON_PCM_CLOSED
    }
    const sourceSampleRate = frame.sourceSampleRate
    if (!Number.isInteger(sourceSampleRate) || sourceSampleRate <= 0) {
      this.refuse(REASON_PCM_BAD_RATE, { sourceSampleRate })
      return REASON_PCM_BAD_RATE
    }
    if (frame.pcm.length === 0 || (frame.pcm.length & 1) !== 0) {
      this.refuse(REASON_PCM_ODD_BYTES, { bytes: frame.pcm.length })
      return REASON_PCM_ODD_BYTES
    }

    let api: IntercomAudioCodecApi
    try {
      api = this.opts.resolveAudioCodec()
    } catch (err) {
      this.refuse(REASON_PCM_NO_CODEC_CAP, { error: errMessage(err) })
      return REASON_PCM_NO_CODEC_CAP
    }

    // A decode session is pinned to the rate it was created with. A caller
    // that renegotiates gets a fresh one, never a mislabelled old one.
    if (this.active !== null && this.active.sourceSampleRate !== sourceSampleRate) {
      const previous = this.active.sourceSampleRate
      await this.disposeSession(api, 'source-rate-changed')
      this.opts.logger.info('intercom: pcm resample source rate changed — session recreated', {
        tags: { deviceId: this.opts.deviceId },
        meta: { previousSourceSampleRate: previous, sourceSampleRate },
      })
    }

    if (this.active === null) {
      try {
        const created = await api.createDecodeSession({
          codec: TALK_PCM_CODEC,
          sourceSampleRate,
          sourceChannels: 1,
          targetSampleRate: this.opts.targetSampleRate,
          targetChannels: 1,
          targetFormat: 's16le',
          tag: this.opts.tag,
        })
        this.active = {
          sessionId: created.sessionId,
          nodeId: created.nodeId,
          sourceSampleRate,
        }
        this.opts.logger.info('intercom: pcm resample session opened', {
          tags: { deviceId: this.opts.deviceId },
          meta: {
            codec: TALK_PCM_CODEC,
            codecSessionId: created.sessionId,
            codecNodeId: created.nodeId,
            sourceSampleRate,
            targetSampleRate: this.opts.targetSampleRate,
            tag: this.opts.tag,
          },
        })
      } catch (err) {
        this.refuse(REASON_PCM_SESSION_OPEN_FAILED, {
          sourceSampleRate,
          targetSampleRate: this.opts.targetSampleRate,
          error: errMessage(err),
        })
        return REASON_PCM_SESSION_OPEN_FAILED
      }
    }

    const session = this.active
    try {
      await api.pushEncodedFrame({
        sessionId: session.sessionId,
        nodeId: session.nodeId,
        data: new Uint8Array(frame.pcm.buffer, frame.pcm.byteOffset, frame.pcm.byteLength),
      })
      const chunks = await api.pullPcm({
        sessionId: session.sessionId,
        nodeId: session.nodeId,
        maxCount: TALK_PCM_PULL_MAX_CHUNKS,
      })
      for (const chunk of chunks) {
        const out = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)
        if (out.length > 0) this.opts.feed(out)
      }
      return null
    } catch (err) {
      this.refuse(REASON_PCM_CONVERT_FAILED, {
        codecSessionId: session.sessionId,
        sourceSampleRate,
        targetSampleRate: this.opts.targetSampleRate,
        error: errMessage(err),
      })
      // Torn down on error too: a codec session that threw is of unknown
      // internal state, and the next frame must not inherit it.
      await this.disposeSession(api, 'convert-failed')
      return REASON_PCM_CONVERT_FAILED
    }
  }

  /**
   * Close the codec session. Idempotent, and called from the provider's
   * `endTalkSession` so the session dies with the talk session it served.
   */
  async close(): Promise<void> {
    this.closed = true
    if (this.active === null) return
    let api: IntercomAudioCodecApi
    try {
      api = this.opts.resolveAudioCodec()
    } catch (err) {
      // The cap went away under us. Drop the handle rather than leak a
      // reference to a session nobody can close.
      this.opts.logger.debug('intercom: pcm resample close skipped — audio-codec gone', {
        tags: { deviceId: this.opts.deviceId },
        meta: { codecSessionId: this.active.sessionId, error: errMessage(err) },
      })
      this.active = null
      return
    }
    await this.disposeSession(api, 'talk-session-ended')
  }

  /** Close + forget the current session. Never throws. */
  private async disposeSession(api: IntercomAudioCodecApi, why: string): Promise<void> {
    const session = this.active
    this.active = null
    if (session === null) return
    try {
      await api.closeSession({ sessionId: session.sessionId, nodeId: session.nodeId })
    } catch (err) {
      this.opts.logger.debug('intercom: pcm resample closeSession error (continuing)', {
        tags: { deviceId: this.opts.deviceId },
        meta: { codecSessionId: session.sessionId, why, error: errMessage(err) },
      })
    }
  }

  /** One warn per refused frame. A branch that drops work says so. */
  private refuse(reason: string, meta: Record<string, unknown>): void {
    this.opts.logger.warn('intercom: pcm talk frame refused — not converted, nothing fed', {
      tags: { deviceId: this.opts.deviceId },
      meta: { reason, targetSampleRate: this.opts.targetSampleRate, ...meta },
    })
  }
}
