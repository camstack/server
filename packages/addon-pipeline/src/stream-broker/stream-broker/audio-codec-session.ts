/**
 * Per-broker handle around an audio-codec decode session. Owns:
 *   - sessionId (lazily created on first push)
 *   - depacketizer choice based on RTP payload format
 *   - polling timer that pulls PCM from the cap and fans it out via
 *     a caller-supplied AudioRtpDecoder-shaped callback.
 *
 * Stays self-contained so the broker only needs to forward
 * `processPacket(rtpData)` and `close()` calls. Mirrors the surface
 * of `AudioRtpDecoder` (the legacy PCMU/PCMA path) so the broker's
 * call sites can swap implementations without further branching.
 */
import type { DecodedAudioChunk, IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { AudioCodecCapApi } from './audio-codec-proxy.js'
import { depacketizeRfc3640, type Rfc3640Options } from '../rtsp/audio/aac-config.js'

export interface AudioCodecSessionConfig {
  readonly codec: string // canonical lowercase: 'aac', 'opus', ...
  readonly sourceSampleRate: number
  readonly sourceChannels: number
  readonly extraData?: Uint8Array // AAC AudioSpecificConfig
  readonly targetSampleRate: number // typically 16000 for ASA / yamnet
  readonly targetChannels: number // typically 1
  readonly tag?: string
  /** Set when the source uses MPEG4-GENERIC mode=AAC-hbr framing. */
  readonly rfc3640?: Rfc3640Options
}

/**
 * Poll period while a REALTIME consumer is attached (D465).
 *
 * 40 ms is a WebRTC latency budget and nothing else. The only branch of
 * `buildAudioCodecEmitCallback` that needs a sub-100 ms chunk is the PCMU /
 * Opus egress, and that branch is already gated on `encodedCallbacks.size > 0`.
 */
export const REALTIME_POLL_INTERVAL_MS = 40

/**
 * Poll period when the only consumer is the audio-chunk plane (D465).
 *
 * The plane's consumer accumulates to `AUDIO_WINDOW_TARGET_MS` (1 s) before it
 * classifies anything, and the watchdog that reads the result carries a 90 s
 * threshold — so up to 400 ms of added latency is invisible to it. What the
 * number is bounded BY is the drain batch, not taste: an AAC session emits one
 * ~42 ms PCM frame per poll (~25/s), so a poll must be able to carry
 * `IDLE_POLL_INTERVAL_MS / 42` frames or the decoder's `pcmQueue` grows
 * monotonically until it drops its oldest chunks. At 400 ms that is ~10 of
 * {@link MAX_PCM_PER_POLL}'s 32 — a 3x margin that also covers a 21 ms-frame
 * codec.
 *
 * On the live hub at 2026-09-12 00:30 this was the largest single source of
 * MESSAGES on the UDS plane: four AAC sessions x 25 polls/s = 5 997 calls/min,
 * with `encodedCallbacks.size === 0` on every one of them.
 */
export const IDLE_POLL_INTERVAL_MS = 400

/**
 * Frames drained per poll. Sized so {@link IDLE_POLL_INTERVAL_MS} is covered
 * with margin — see the note there. At ~2.7 kB per f32le frame a full batch is
 * ~86 kB, and the steady-state batch at the idle cadence is ~10 frames.
 */
export const MAX_PCM_PER_POLL = 32

const RTP_HEADER_LENGTH = 12
const WARN_THROTTLE_MS = 5_000
// Audio chunks are emitted at the codec's native frame cadence (~21
// to 128 ms depending on codec) — no accumulator window here. This
// path used to coalesce into 500 ms chunks to match YAMNet/Apple
// SoundAnalysis input windows; the side-effect was ~500 ms added
// latency on every WebRTC playback (cam 15 / Reolink AAC chain).
// Realtime consumers (WebRTC PCMU egress) now see audio with sub-
// 100 ms decode latency. ML analyzers (YAMNet 480 ms hop / Apple SA
// 960 ms window) accumulate at their own pipeline side; the
// AudioChunkPlane is pull-based so they can buffer however many
// small chunks they need before invoking `classify()`.
// Matches the "decode session 'dec-...' not found" thrown by the
// audio-codec addon when the upstream session has been reaped (idle
// timeout, addon restart, host process resumed from sleep). We use it
// to detect "the cap forgot us" vs a transient decode error.
const SESSION_NOT_FOUND_RE = /decode session\b.*\bnot found\b/

function isSessionGone(err: unknown): boolean {
  return SESSION_NOT_FOUND_RE.test(errMsg(err))
}

/**
 * Answers "is a consumer attached that needs the chunk NOW?" — i.e. the live
 * PCMU / Opus WebRTC egress. The broker supplies
 * `() => this.encodedCallbacks.size > 0`, the same signal
 * `buildAudioCodecEmitCallback` already branches on, so the cadence and the
 * work it feeds can never disagree. Omitted = always realtime (D465).
 */
export type RealtimeAudioDemand = () => boolean

export class AudioCodecSession {
  private sessionId: string | null = null
  private sessionNodeId: string | null = null
  private creating: Promise<string | null> | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  /** The cadence the loop last armed, so a change can be NAMED once (D465). */
  private pollIntervalMs: number | null = null
  private closed = false
  private packetsIn = 0
  private packetsDropped = 0
  // Coalesce warnings — without this a single reaped session produces
  // ~1000 warn/s (every RTP audio packet + every poll tick), and the
  // synchronous winston writes block the broker's event loop enough
  // to visibly slow the video forwarders sharing the process.
  private warnState = new Map<string, { lastLoggedAt: number; suppressed: number }>()
  // No accumulator: each decoded PCM frame is emitted as one
  // DecodedAudioChunk immediately for minimum WebRTC latency. ML
  // consumers downstream apply their own window aggregation.

  constructor(
    private readonly api: AudioCodecCapApi,
    private readonly cfg: AudioCodecSessionConfig,
    private readonly emit: (chunk: DecodedAudioChunk) => void,
    private readonly logger?: IScopedLogger,
    private readonly realtimeDemand?: RealtimeAudioDemand,
  ) {
    // No chunk-byte target — emit happens per codec frame.
  }

  processPacket(rtpData: Buffer): void {
    if (this.closed) return
    if (rtpData.length <= RTP_HEADER_LENGTH) return
    // A COPY: the closure below runs after an await, long after `rtpData`'s slab
    // may have been recycled (`slab-pool.ts`).
    const payload = Buffer.from(rtpData.subarray(RTP_HEADER_LENGTH))
    this.packetsIn++

    void this.ensureSession().then((sid) => {
      if (!sid || this.closed) return
      const nodeId = this.sessionNodeId ?? undefined
      const units = this.cfg.rfc3640
        ? depacketizeRfc3640(payload, this.cfg.rfc3640)
        : [Uint8Array.from(payload)]
      for (const unit of units) {
        void this.api
          .pushEncodedFrame({
            sessionId: sid,
            ...(nodeId ? { nodeId } : {}),
            data: unit,
          })
          .catch((err) => {
            this.packetsDropped++
            this.handlePushError('audio-codec: pushEncodedFrame failed', sid, err)
          })
      }
    })
  }

  /**
   * Push a single pre-depacketized codec frame. Used by push-source
   * providers (Reolink Baichuan) that emit raw codec frames
   * directly — no RTP wrapping, no rfc3640 depacketize. The payload
   * MUST be one complete frame the underlying decoder can consume
   * (e.g. an AAC raw frame with or without ADTS header per the
   * codec's AudioSpecificConfig).
   */
  pushRawFrame(unit: Uint8Array): void {
    if (this.closed) return
    if (unit.length === 0) return
    this.packetsIn++
    void this.ensureSession().then((sid) => {
      if (!sid || this.closed) return
      const nodeId = this.sessionNodeId ?? undefined
      void this.api
        .pushEncodedFrame({
          sessionId: sid,
          ...(nodeId ? { nodeId } : {}),
          data: unit,
        })
        .catch((err) => {
          this.packetsDropped++
          this.handlePushError('audio-codec: pushEncodedFrame (raw) failed', sid, err)
        })
    })
  }

  /** Stats surfaced by the broker for the streams tab / logs. */
  getStats(): { packetsIn: number; packetsDropped: number; sessionId: string | null } {
    return {
      packetsIn: this.packetsIn,
      packetsDropped: this.packetsDropped,
      sessionId: this.sessionId,
    }
  }

  /**
   * Tear down the upstream decode session + 40ms poll loop WITHOUT
   * permanently closing this handle. The broker calls this from its
   * audio-consumer demand-gate: when audio consumers drop to zero the
   * upstream decoder session and its poll loop are pure waste, so we
   * release them. Unlike {@link close} this leaves the handle reusable —
   * the next pushed packet re-creates the session lazily via
   * `ensureSession()`. Safe to call repeatedly.
   */
  async idle(): Promise<void> {
    if (this.closed) return
    // A createDecodeSession started by a packet that slipped in just
    // before demand dropped may still be in flight (`ensureSession`
    // never rejects — it resolves to null on failure). Let it settle so
    // we tear the real session down instead of racing it into an orphan
    // whose poll timer ticks forever.
    if (this.creating) await this.creating
    if (this.closed) return
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
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
      this.logger?.warn('audio-codec: idle closeSession failed', {
        meta: { error: errMsg(err) },
      })
    }
    this.logger?.info('audio-codec: decode session idled (no audio consumer)', {
      meta: { sessionId: sid },
    })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    // No accumulator to flush — each PCM frame was emitted as it
    // came back from `pullPcm`. close() proceeds directly to the
    // upstream session teardown.
    if (this.sessionId) {
      const sid = this.sessionId
      const nodeId = this.sessionNodeId ?? undefined
      try {
        await this.api.closeSession({ sessionId: sid, ...(nodeId ? { nodeId } : {}) })
      } catch (err) {
        this.logger?.warn('audio-codec: closeSession failed', {
          meta: { error: errMsg(err) },
        })
      }
      this.sessionId = null
      this.sessionNodeId = null
    }
  }

  private async ensureSession(): Promise<string | null> {
    if (this.sessionId) return this.sessionId
    if (this.creating) return this.creating
    this.creating = (async () => {
      try {
        const res = await this.api.createDecodeSession({
          codec: this.cfg.codec,
          sourceSampleRate: this.cfg.sourceSampleRate,
          sourceChannels: this.cfg.sourceChannels,
          ...(this.cfg.extraData ? { extraData: this.cfg.extraData } : {}),
          targetSampleRate: this.cfg.targetSampleRate,
          targetChannels: this.cfg.targetChannels,
          targetFormat: 'f32le',
          ...(this.cfg.tag ? { tag: this.cfg.tag } : {}),
        })
        // Create-in-flight race guard (fixes a native-memory leak). The handle
        // may have been close()d while this createDecodeSession RPC was in
        // flight — at that moment `this.sessionId` was still null, so close()
        // could NOT tear the upstream session down and no-op'd. Without this
        // guard we'd now adopt a session nobody owns: startPollLoop arms a timer
        // that pollOnce immediately short-circuits on `this.closed` (never
        // calling pullPcm), so the addon record's lastActivityMs freezes and the
        // 30s idle-reaper reaps it — leaking, per race, a live ffmpeg child + an
        // unbounded pcmQueue for 30s AND a never-cleared poll interval forever.
        // Instead: dispose the record the addon just built and stand down.
        if (this.closed) {
          try {
            await this.api.closeSession({
              sessionId: res.sessionId,
              ...(res.nodeId ? { nodeId: res.nodeId } : {}),
            })
          } catch (err) {
            this.logger?.warn('audio-codec: closeSession (closed mid-create) failed', {
              meta: { error: errMsg(err) },
            })
          }
          return null
        }
        this.sessionId = res.sessionId
        this.sessionNodeId = res.nodeId
        this.startPollLoop()
        this.logger?.info('audio-codec: decode session ready', {
          meta: {
            sessionId: res.sessionId,
            nodeId: res.nodeId,
            codec: this.cfg.codec,
            target: `${this.cfg.targetSampleRate}Hz×${this.cfg.targetChannels}`,
          },
        })
        return res.sessionId
      } catch (err) {
        this.logger?.error('audio-codec: createDecodeSession failed', {
          meta: { codec: this.cfg.codec, error: errMsg(err) },
        })
        return null
      } finally {
        this.creating = null
      }
    })()
    return this.creating
  }

  /**
   * The cadence this tick should use. Re-read every tick rather than latched at
   * arm time: a WebRTC session attaching mid-stream must be served at
   * {@link REALTIME_POLL_INTERVAL_MS}, and it costs at most one idle interval
   * (400 ms) to notice — against an ICE/DTLS handshake measured in seconds.
   */
  private currentPollIntervalMs(): number {
    if (!this.realtimeDemand) return REALTIME_POLL_INTERVAL_MS
    return this.realtimeDemand() ? REALTIME_POLL_INTERVAL_MS : IDLE_POLL_INTERVAL_MS
  }

  private startPollLoop(): void {
    // Never arm the poll loop for a closed handle — a timer whose pollOnce
    // short-circuits on `this.closed` would tick forever without pulling,
    // orphaning the upstream session (see the mid-create race guard above).
    if (this.pollTimer || this.closed) return
    this.scheduleNextPoll()
  }

  /**
   * Self-scheduling tick. `setInterval` cannot change period, and the period is
   * now a property of who is listening (D465), so the loop re-arms itself.
   */
  private scheduleNextPoll(): void {
    // A session reaped upstream (`handleSessionGone`) nulls `sessionId` and
    // stops the loop; re-arming here would tick forever without pulling, which
    // is the orphan the mid-create race guard exists to prevent.
    if (this.closed || !this.sessionId) return
    const intervalMs = this.currentPollIntervalMs()
    if (intervalMs !== this.pollIntervalMs) {
      const previous = this.pollIntervalMs
      this.pollIntervalMs = intervalMs
      // A cadence nobody can see is a cadence nobody can debug: an operator
      // asking why one camera's audio lags another's gets the answer here.
      this.logger?.info('audio-codec: poll cadence', {
        meta: {
          intervalMs,
          previousMs: previous,
          reason: intervalMs === REALTIME_POLL_INTERVAL_MS ? 'realtime-consumer' : 'plane-only',
          maxPcmPerPoll: MAX_PCM_PER_POLL,
        },
      })
    }
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.pollOnce().finally(() => {
        this.scheduleNextPoll()
      })
    }, intervalMs)
    if (typeof this.pollTimer.unref === 'function') this.pollTimer.unref()
  }

  private async pollOnce(): Promise<void> {
    const sid = this.sessionId
    if (!sid || this.closed) return
    const nodeId = this.sessionNodeId ?? undefined
    try {
      const pcms = await this.api.pullPcm({
        sessionId: sid,
        ...(nodeId ? { nodeId } : {}),
        maxCount: MAX_PCM_PER_POLL,
      })
      for (const pcm of pcms) {
        this.appendPcm(pcm)
      }
    } catch (err) {
      // Stop polling and forget the dead session id when the upstream
      // cap reaped it; the next pushed RTP packet will reopen via
      // ensureSession(). Without this the timer fires every 40ms forever
      // and the broker logs ~25 warn/s per dead session per camera.
      if (isSessionGone(err)) {
        this.handleSessionGone(sid)
        return
      }
      this.warnThrottled('audio-codec: pullPcm failed', errMsg(err))
    }
  }

  // ── Sample accumulator ──────────────────────────────────────────────────

  /**
   * Emit a freshly-pulled PCM frame as a DecodedAudioChunk immediately.
   * No accumulator: realtime WebRTC consumers get audio at the codec's
   * native cadence (~21-128ms per frame). ML analyzers that need a
   * fixed-window input (YAMNet, Apple SA) aggregate at their own
   * pipeline side from the pull-based AudioChunkPlane subscription.
   *
   * `pcm.pts` is a codec-relative PTS (often starts at 0), not a
   * wall-clock; downstream consumers interpret the chunk timestamp as
   * ms-since-epoch, so we stamp with `Date.now()` to match the
   * `AudioRtpDecoder` path.
   */
  private appendPcm(pcm: {
    data: Uint8Array
    sampleRate: number
    channels: number
    pts: number
  }): void {
    if (pcm.data.byteLength === 0) return
    // Buffer.from(uint8array) deep-copies — safe to keep across the
    // RPC tick that owns the source buffer.
    this.emit({
      data: Buffer.from(pcm.data),
      sampleRate: pcm.sampleRate,
      channels: pcm.channels,
      timestamp: Date.now(),
    })
  }

  // ── Recovery + warn coalescing ──────────────────────────────────────────

  /**
   * Invoked from any push/pull path when the cap returns
   * `decode session not found`. Drops our cached session id + tears
   * down the poll loop so subsequent traffic re-creates the session
   * lazily. Safe to call multiple times: second caller sees a null
   * sessionId and noops.
   */
  private handleSessionGone(staleSid: string): void {
    if (this.sessionId !== staleSid) return
    this.sessionId = null
    this.sessionNodeId = null
    if (this.pollTimer) {
      clearTimeout(this.pollTimer)
      this.pollTimer = null
    }
    // No accumulator to drain — each PCM frame from the reaped
    // session was already emitted at pull time.
    this.warnThrottled(
      'audio-codec: session reaped upstream — will re-create on next packet',
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

  /**
   * Logs at most once per WARN_THROTTLE_MS per (label,detail) pair and
   * folds suppressed counts into the next log line so we keep visibility
   * into chronic failures without flooding winston (whose JSON encode +
   * sync write blocks the broker's event loop at >100/s).
   */
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
      meta: {
        codec: this.cfg.codec,
        error: detail,
        ...(suppressed > 0 ? { suppressedSinceLastLog: suppressed } : {}),
      },
    })
  }
}
