/**
 * OpusEncodeSession — per-consumer handle around an audio-codec **encode**
 * session, the mirror image of {@link import('./audio-codec-session.js').AudioCodecSession}
 * (which decodes). Owns:
 *   - sessionId (lazily created on first PCM push)
 *   - a 40 ms poll loop that drains encoded Opus frames from the cap and
 *     fans them out via a caller-supplied `emit` callback
 *   - the same create-in-flight / session-reaped race guards as the decode
 *     client (those guards fixed real native-memory leaks — do not drop them)
 *
 * The broker feeds it decoded PCM (`DecodedAudioChunk`, f32le today) and gets
 * back raw Opus access units ready for a 48 kHz WebRTC Opus RTP sender — the
 * encode half of the live Opus egress. Nothing here is WebRTC-specific: it is a
 * generic PCM→Opus box, so the recorded-playback path can reuse it too if a
 * legacy AAC fragment ever needs re-encoding to the negotiated Opus track.
 *
 * NO ffmpeg subprocess: the cap runs in-process via node-av (`decoder-nodeav`,
 * `opus canEncode:true`), so this stays inside the "frames never cross a process
 * boundary at frame-rate uncompressed" rule — PCM crosses as a cap RPC exactly
 * as the decode client already does, and what comes back is compressed Opus.
 */
import type { DecodedAudioChunk, IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { AudioCodecCapApi } from './audio-codec-proxy.js'

/** One encoded Opus access unit handed to the sender (a whole RTP payload). */
export interface EncodedOpusFrame {
  /** Raw Opus packet bytes (owned copy, safe to keep across ticks). */
  readonly data: Buffer
  /** Codec-relative PTS in ms as reported by the encoder. */
  readonly ptsMs: number
}

/** Static config for one PCM→Opus encode session. */
export interface OpusEncodeSessionConfig {
  /** Sample rate of the PCM pushed in (the decode session's target rate). */
  readonly sourceSampleRate: number
  /** Channel count of the PCM pushed in. */
  readonly sourceChannels: number
  /** PCM sample format pushed in. Defaults to f32le (the decode client's output). */
  readonly sourceFormat?: 'f32le' | 's16le'
  /** Opus RTP clock — always 48 kHz for WebRTC Opus. */
  readonly targetSampleRate: number
  /** Opus channel count on the wire (1 or 2). */
  readonly targetChannels: number
  /** Encoder bitrate; the cap picks a sane default when omitted. */
  readonly bitrateKbps?: number
  /** Diagnostic tag surfaced by the cap's session inventory. */
  readonly tag?: string
}

const POLL_INTERVAL_MS = 40
const MAX_ENCODED_PER_POLL = 16
const WARN_THROTTLE_MS = 5_000
const OPUS_CODEC = 'opus'
// The audio-codec addon throws "encode session '…' not found" once a session is
// reaped (idle timeout / addon restart / host resume). Detect it to re-create
// lazily on the next push instead of looping the poll timer forever.
const SESSION_NOT_FOUND_RE = /encode session\b.*\bnot found\b/

function isSessionGone(err: unknown): boolean {
  return SESSION_NOT_FOUND_RE.test(errMsg(err))
}

export class OpusEncodeSession {
  private sessionId: string | null = null
  private sessionNodeId: string | null = null
  private creating: Promise<string | null> | null = null
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private closed = false
  private chunksIn = 0
  private chunksDropped = 0
  private warnState = new Map<string, { lastLoggedAt: number; suppressed: number }>()

  constructor(
    private readonly api: AudioCodecCapApi,
    private readonly cfg: OpusEncodeSessionConfig,
    private readonly emit: (frame: EncodedOpusFrame) => void,
    private readonly logger?: IScopedLogger,
  ) {}

  /**
   * Push one decoded PCM chunk. The session is created lazily on the first
   * push; the poll loop then drains Opus frames back out via `emit`.
   * `pts` is source-relative ms (falls back to the chunk timestamp).
   */
  pushPcm(chunk: DecodedAudioChunk): void {
    if (this.closed) return
    if (chunk.data.byteLength === 0) return
    this.chunksIn++
    const data = Uint8Array.from(chunk.data)
    const pts = chunk.timestamp
    void this.ensureSession().then((sid) => {
      if (!sid || this.closed) return
      const nodeId = this.sessionNodeId ?? undefined
      void this.api
        .pushPcm({ sessionId: sid, ...(nodeId ? { nodeId } : {}), data, pts })
        .catch((err) => {
          this.chunksDropped++
          this.handlePushError('opus-encode: pushPcm failed', sid, err)
        })
    })
  }

  getStats(): { chunksIn: number; chunksDropped: number; sessionId: string | null } {
    return { chunksIn: this.chunksIn, chunksDropped: this.chunksDropped, sessionId: this.sessionId }
  }

  /**
   * Release the upstream encode session + poll loop WITHOUT closing the handle
   * (demand-gate: no Opus consumer ⇒ the encoder is pure waste). Reusable — the
   * next `pushPcm` re-creates the session. Mirrors the decode client's `idle`.
   */
  async idle(): Promise<void> {
    if (this.closed) return
    if (this.creating) await this.creating
    if (this.closed) return
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (!this.sessionId) return
    const sid = this.sessionId
    const nodeId = this.sessionNodeId ?? undefined
    this.sessionId = null
    this.sessionNodeId = null
    try {
      await this.api.closeSession({ sessionId: sid, ...(nodeId ? { nodeId } : {}) })
    } catch (err) {
      this.logger?.warn('opus-encode: idle closeSession failed', { meta: { error: errMsg(err) } })
    }
    this.logger?.info('opus-encode: encode session idled (no opus consumer)', {
      meta: { sessionId: sid },
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    if (!this.sessionId) return
    const sid = this.sessionId
    const nodeId = this.sessionNodeId ?? undefined
    // Drain any encoder tail so the last ~20 ms of audio isn't clipped.
    try {
      const tail = await this.api.flushEncode({ sessionId: sid, ...(nodeId ? { nodeId } : {}) })
      for (const enc of tail) this.emitEncoded(enc)
    } catch (err) {
      if (!isSessionGone(err)) {
        this.warnThrottled('opus-encode: flushEncode failed', errMsg(err))
      }
    }
    try {
      await this.api.closeSession({ sessionId: sid, ...(nodeId ? { nodeId } : {}) })
    } catch (err) {
      this.logger?.warn('opus-encode: closeSession failed', { meta: { error: errMsg(err) } })
    }
    this.sessionId = null
    this.sessionNodeId = null
  }

  private async ensureSession(): Promise<string | null> {
    if (this.sessionId) return this.sessionId
    if (this.creating) return this.creating
    this.creating = (async () => {
      try {
        const res = await this.api.createEncodeSession({
          codec: OPUS_CODEC,
          sourceSampleRate: this.cfg.sourceSampleRate,
          sourceChannels: this.cfg.sourceChannels,
          ...(this.cfg.sourceFormat ? { sourceFormat: this.cfg.sourceFormat } : {}),
          targetSampleRate: this.cfg.targetSampleRate,
          targetChannels: this.cfg.targetChannels,
          ...(this.cfg.bitrateKbps ? { bitrateKbps: this.cfg.bitrateKbps } : {}),
          ...(this.cfg.tag ? { tag: this.cfg.tag } : {}),
        })
        // Create-in-flight race guard (mirror of the decode client): close()
        // may have run while this RPC was in flight — sessionId was still null,
        // so close() no-op'd. Adopt-and-leak avoidance: dispose the record the
        // addon just built and stand down.
        if (this.closed) {
          try {
            await this.api.closeSession({
              sessionId: res.sessionId,
              ...(res.nodeId ? { nodeId: res.nodeId } : {}),
            })
          } catch (err) {
            this.logger?.warn('opus-encode: closeSession (closed mid-create) failed', {
              meta: { error: errMsg(err) },
            })
          }
          return null
        }
        this.sessionId = res.sessionId
        this.sessionNodeId = res.nodeId
        this.startPollLoop()
        this.logger?.info('opus-encode: encode session ready', {
          meta: {
            sessionId: res.sessionId,
            nodeId: res.nodeId,
            source: `${this.cfg.sourceSampleRate}Hz×${this.cfg.sourceChannels}`,
            target: `${this.cfg.targetSampleRate}Hz×${this.cfg.targetChannels} opus`,
          },
        })
        return res.sessionId
      } catch (err) {
        this.logger?.error('opus-encode: createEncodeSession failed', {
          meta: { error: errMsg(err) },
        })
        return null
      } finally {
        this.creating = null
      }
    })()
    return this.creating
  }

  private startPollLoop(): void {
    if (this.pollTimer || this.closed) return
    this.pollTimer = setInterval(() => {
      void this.pollOnce()
    }, POLL_INTERVAL_MS)
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref()
  }

  private async pollOnce(): Promise<void> {
    const sid = this.sessionId
    if (!sid || this.closed) return
    const nodeId = this.sessionNodeId ?? undefined
    try {
      const encoded = await this.api.pullEncoded({
        sessionId: sid,
        ...(nodeId ? { nodeId } : {}),
        maxCount: MAX_ENCODED_PER_POLL,
      })
      for (const enc of encoded) this.emitEncoded(enc)
    } catch (err) {
      if (isSessionGone(err)) {
        this.handleSessionGone(sid)
        return
      }
      this.warnThrottled('opus-encode: pullEncoded failed', errMsg(err))
    }
  }

  private emitEncoded(enc: { data: Uint8Array; pts: number; frameComplete: boolean }): void {
    if (enc.data.byteLength === 0) return
    // Buffer.from(uint8array) deep-copies — safe to keep past the RPC tick.
    this.emit({ data: Buffer.from(enc.data), ptsMs: enc.pts })
  }

  private handleSessionGone(staleSid: string): void {
    if (this.sessionId !== staleSid) return
    this.sessionId = null
    this.sessionNodeId = null
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.warnThrottled(
      'opus-encode: session reaped upstream — will re-create on next chunk',
      `staleSessionId=${staleSid}`,
    )
  }

  private handlePushError(label: string, sid: string, err: unknown): void {
    if (isSessionGone(err)) {
      this.handleSessionGone(sid)
      return
    }
    this.warnThrottled(label, errMsg(err))
  }

  private warnThrottled(label: string, detail: string): void {
    const key = `${label}|${detail}`
    const now = Date.now()
    const prev = this.warnState.get(key)
    if (prev && now - prev.lastLoggedAt < WARN_THROTTLE_MS) {
      prev.suppressed++
      return
    }
    const suppressed = prev?.suppressed ?? 0
    this.warnState.set(key, { lastLoggedAt: now, suppressed: 0 })
    this.logger?.warn(label, {
      meta: { error: detail, ...(suppressed > 0 ? { suppressedSinceLastLog: suppressed } : {}) },
    })
  }
}

/** Config for {@link encodeOpusSilenceFrame}. */
export interface OpusSilenceConfig {
  /** Opus channel count on the wire (matches the negotiated track). */
  readonly channels: number
  /** Encoder bitrate; the cap picks a default when omitted. */
  readonly bitrateKbps?: number
}

const OPUS_SILENCE_RATE_HZ = 48_000
const OPUS_SILENCE_FRAME_SAMPLES = 960 // 20 ms @ 48 kHz
// Prime the encoder past its lookahead/pre-skip so the RETURNED packet is a
// clean steady-state silence frame, not the encoder's ramp-up frame.
const OPUS_SILENCE_PRIME_FRAMES = 6

/**
 * Produce ONE canonical 20 ms Opus silence packet by encoding PCM zeros through
 * the audio-codec cap, for the WebRTC session's sentry A/V-sync padding
 * (Opus has no fixed "silence byte" like PCMU's 0xFF — silence must be encoded).
 * A short-lived encode session is created, primed with a few zero frames, and
 * flushed; the LAST steady-state frame is returned. Returns `null` when the cap
 * is unavailable or yields nothing so the caller can skip sentry padding.
 */
export async function encodeOpusSilenceFrame(
  api: AudioCodecCapApi,
  cfg: OpusSilenceConfig,
): Promise<Buffer | null> {
  let sessionId: string | null = null
  let nodeId: string | undefined
  try {
    const res = await api.createEncodeSession({
      codec: OPUS_CODEC,
      sourceSampleRate: OPUS_SILENCE_RATE_HZ,
      sourceChannels: cfg.channels,
      sourceFormat: 'f32le',
      targetSampleRate: OPUS_SILENCE_RATE_HZ,
      targetChannels: cfg.channels,
      ...(cfg.bitrateKbps ? { bitrateKbps: cfg.bitrateKbps } : {}),
      tag: 'opus-silence',
    })
    sessionId = res.sessionId
    nodeId = res.nodeId
    const zeros = Buffer.alloc(OPUS_SILENCE_FRAME_SAMPLES * cfg.channels * 4) // f32le
    const collected: Buffer[] = []
    for (let i = 0; i < OPUS_SILENCE_PRIME_FRAMES; i++) {
      await api.pushPcm({ sessionId, ...(nodeId ? { nodeId } : {}), data: zeros, pts: i * 20 })
      const out = await api.pullEncoded({ sessionId, ...(nodeId ? { nodeId } : {}), maxCount: 8 })
      for (const e of out) if (e.data.byteLength > 0) collected.push(Buffer.from(e.data))
    }
    const tail = await api.flushEncode({ sessionId, ...(nodeId ? { nodeId } : {}) })
    for (const e of tail) if (e.data.byteLength > 0) collected.push(Buffer.from(e.data))
    return collected.length > 0 ? collected[collected.length - 1]! : null
  } catch {
    return null
  } finally {
    if (sessionId) {
      await api.closeSession({ sessionId, ...(nodeId ? { nodeId } : {}) }).catch(() => {})
    }
  }
}
