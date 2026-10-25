/**
 * IntercomOrchestrator (Hikvision flavor) — wires WebRTC peer +
 * audio-codec decode + a vendor-specific talk session into a single
 * lifecycle the `intercom` cap router drives.
 *
 * Pipeline:
 *
 *   browser ─ Opus RTP ─▶  IntercomWebrtcPeer (werift)
 *                            │
 *                            ▼ onOpusFrame(payload)
 *                          audio-codec cap (decode + resample to 8 kHz mono)
 *                            │
 *                            ▼ pullPcm(...)
 *                          IIntercomTalkSession.feedPcm(buf)
 *                            │
 *                            ▼ G.711 encode
 *                          camera ISAPI sticky `audioData` PUT
 *
 * NOTE — Phase 1 duplication: this orchestrator mirrors
 * `addon-provider-reolink/src/intercom-orchestrator.ts` with the only
 * substantive difference being the `talkSession` is supplied by the
 * caller (instead of being constructed inline as a `ReolinkIntercomSession`).
 * Phase 1.5 will hoist a single shared orchestrator + talk-session
 * interface into a common package; today the two providers each carry
 * their own copy because cross-addon imports are forbidden.
 */

import type { IntercomAbility, IScopedLogger } from '@camstack/types'

/**
 * Why an intercom session ended. Threaded through `stop()` and surfaced
 * in the "intercom session closed" log + `onClosed` subscribers so a
 * normal operator stop is distinguishable from a failure. Without this
 * the logs only ever showed a clean close regardless of cause.
 *
 *   - `user-stop`         operator / UI ended the talk session normally
 *   - `remote-closed-put` the camera tore down the sticky audioData PUT
 *   - `ice-disconnected`  the WebRTC peer's ICE transport failed/closed
 *   - `codec-error`       the audio-codec decode session errored
 *   - `put-error`         the audioData PUT errored (non-2xx / socket)
 *   - `peer-closed`       the WebRTC peer reported a non-ICE close
 *   - `error`             any other unclassified teardown error
 */
export type IntercomCloseReason =
  | 'user-stop'
  | 'remote-closed-put'
  | 'ice-disconnected'
  | 'codec-error'
  | 'put-error'
  | 'peer-closed'
  | 'error'

/** Optional teardown context passed into `stop()`. */
export interface IntercomStopOptions {
  readonly reason?: IntercomCloseReason
  /** The Error that triggered the teardown, when applicable. Its
   *  `message` is logged alongside the reason. */
  readonly error?: unknown
}

/** Snapshot of a closed session, delivered to `onClosed` subscribers. */
export interface IntercomCloseInfo {
  readonly sessionId: string
  readonly reason: IntercomCloseReason
  /** Triggering error message when the close was failure-driven. */
  readonly error?: string
  readonly framesPushed: number
  readonly pcmBytesPushed: number
  readonly durationMs: number
}

/** Subscriber callback for session-close notifications. */
export type IntercomCloseListener = (info: IntercomCloseInfo) => void

/** Vendor-neutral talk-session contract. The orchestrator drives any
 *  implementation that exposes this surface — Reolink (IMA ADPCM) and
 *  Hikvision (G.711 sticky-PUT) both fit. */
export interface IIntercomTalkSession {
  /** True once `start()` resolved and `stop()` hasn't been called. */
  readonly isOpen: boolean
  /** Negotiated PCM source rate the caller MUST resample to before
   *  calling `feedPcm`. The orchestrator passes this verbatim into
   *  `audio-codec.createDecodeSession({ targetSampleRate })`. */
  readonly sampleRate: number
  /** The firmware's talk-back format, for `IntercomStatus.ability`. The
   *  session is the only party that knows its own codec and its ENFORCED
   *  backlog; surfacing it here is what lets the WebRTC path write the
   *  field instead of copying `previous?.ability` forward forever (D281). */
  readonly ability: IntercomAbility
  start(): Promise<void>
  feedPcm(buf: Buffer): void
  stop(reason?: IntercomCloseReason): Promise<void>
  /** Optional: subscribe to a camera-initiated teardown (e.g. the
   *  sticky audioData PUT was closed by the camera or errored). The
   *  orchestrator uses this to tear the whole session down with a
   *  precise reason (`remote-closed-put` / `put-error`) instead of the
   *  camera leg dying silently while WebRTC stays open. */
  onClose?(cb: (info: { reason: IntercomCloseReason; error?: unknown }) => void): void
}

/** Audio-codec cap façade the orchestrator needs. Mirrors a subset of
 *  `audioCodecCapability`'s methods so the call site can pass the full
 *  `ctx.api.audioCodec` router straight through. */
export interface IntercomAudioCodecApi {
  createDecodeSession(input: {
    codec: string
    sourceSampleRate: number
    sourceChannels: number
    targetSampleRate: number
    targetChannels: number
    /** Output PCM format. Defaults to 'f32le' on the cap side; the
     *  intercom orchestrator pins it to 's16le' so the G.711 encoder
     *  can read the buffer as Int16Array. */
    targetFormat?: 'f32le' | 's16le'
    tag?: string
  }): Promise<{ sessionId: string; nodeId: string }>
  pushEncodedFrame(input: {
    sessionId: string
    nodeId?: string
    data: Uint8Array
    pts?: number
  }): Promise<void>
  pullPcm(input: {
    sessionId: string
    nodeId?: string
    maxCount: number
  }): Promise<readonly { data: Uint8Array; sampleRate: number; channels: number; pts: number }[]>
  closeSession(input: { sessionId: string; nodeId?: string }): Promise<void>
}

/** Minimal WebRTC peer contract the orchestrator drives. */
export interface IntercomWebrtcPeer {
  createOffer(): Promise<{ sdp: string }>
  setAnswer(sdp: string): Promise<void>
  onOpusFrame(cb: (frame: Buffer, pts: number) => void): void
  /** Subscribe to raw ICE connection-state transitions. Optional so
   *  minimal/test peers don't have to implement it; when present the
   *  orchestrator tears down with `ice-disconnected` on a
   *  `failed`/`disconnected`/`closed` transition. */
  onIceStateChange?(cb: (state: string) => void): void
  close(): Promise<void>
}

/** Factory passed into the orchestrator so the DI seam stays small. */
export type IntercomWebrtcPeerFactory = (deps: { logger: IScopedLogger }) => IntercomWebrtcPeer

/** Factory for the camera-side talk session. Lazy-built per session so
 *  the orchestrator can fail-fast on the camera leg before allocating
 *  WebRTC + codec resources. */
export type IntercomTalkSessionFactory = (deps: { logger: IScopedLogger }) => IIntercomTalkSession

export interface IntercomOrchestratorOptions {
  readonly deviceTag: string
  readonly logger: IScopedLogger
  readonly audioCodec: IntercomAudioCodecApi
  readonly peerFactory: IntercomWebrtcPeerFactory
  readonly talkSessionFactory: IntercomTalkSessionFactory
  /** Opus codec params the browser ships. Default 48 kHz mono. */
  readonly opusSampleRate?: number
  readonly opusChannels?: number
}

interface ActiveSession {
  readonly sessionId: string
  readonly peer: IntercomWebrtcPeer
  readonly talkSession: IIntercomTalkSession
  readonly codec: { sessionId: string; nodeId: string }
  closed: boolean
  readonly startedAtMs: number
  framesPushed: number
  pcmBytesPushed: number
  /** Wall-clock of the last throttled per-frame stats log. */
  lastStatsLogAtMs: number
  /** Snapshot of `framesPushed` at the last stats log, so each tick
   *  reports the delta as well as the cumulative totals. */
  lastStatsFramesPushed: number
  lastStatsPcmBytesPushed: number
}

const DEFAULT_OPUS_SAMPLE_RATE = 48_000
const DEFAULT_OPUS_CHANNELS = 1
/** Per-frame stats are summarised at most once per this interval so the
 *  per-frame path never spams the log (audio runs ~50 frames/sec). */
const FRAME_STATS_INTERVAL_MS = 2_000

export class IntercomOrchestrator {
  private session: ActiveSession | null = null
  private readonly closeListeners: IntercomCloseListener[] = []

  constructor(private readonly opts: IntercomOrchestratorOptions) {}

  get isOpen(): boolean {
    return this.session !== null && !this.session.closed
  }

  /**
   * The live talk session's firmware ability, or `null` when no session is
   * open. Read by the camera at `startSession` so the WebRTC path writes
   * `IntercomStatus.ability` from the same source the raw-PCM path does.
   */
  get ability(): IntercomAbility | null {
    return this.session === null || this.session.closed ? null : this.session.talkSession.ability
  }

  /**
   * Subscribe to session-close notifications. The listener fires exactly
   * once per session with the resolved `IntercomCloseReason` + stats, so
   * the camera layer can surface WHY a talk session ended (the prime
   * diagnostic for "intercom deactivated immediately").
   */
  onClosed(listener: IntercomCloseListener): void {
    this.closeListeners.push(listener)
  }

  async start(): Promise<{ sessionId: string; sdpOffer: string }> {
    if (this.session && !this.session.closed) {
      await this.stop(this.session.sessionId, { reason: 'user-stop' }).catch(() => {
        /* swallow */
      })
    }

    const sessionId = generateSessionId()
    const opusRate = this.opts.opusSampleRate ?? DEFAULT_OPUS_SAMPLE_RATE
    const opusChannels = this.opts.opusChannels ?? DEFAULT_OPUS_CHANNELS

    // 1. Camera-facing talk session FIRST so we fail fast on a
    //    rejecting/unreachable camera before allocating WebRTC + codec.
    const sessionLogger = this.opts.logger.withTags?.({ sessionId }) ?? this.opts.logger
    const talkSession = this.opts.talkSessionFactory({ logger: sessionLogger })
    try {
      await talkSession.start()
    } catch (err) {
      this.opts.logger.warn('intercom: talk session open failed', {
        meta: { error: errMsg(err) },
      })
      throw err
    }
    const targetRate = talkSession.sampleRate

    // 2. Audio-codec decode session — Opus → PCM s16le @ camera rate.
    let codec: { sessionId: string; nodeId: string }
    try {
      codec = await this.opts.audioCodec.createDecodeSession({
        codec: 'opus',
        sourceSampleRate: opusRate,
        sourceChannels: opusChannels,
        targetSampleRate: targetRate,
        targetChannels: 1,
        // CRITICAL: explicitly request s16le PCM. The cap defaults to
        // 'f32le' (32-bit float) and the G.711 encoder reads the buffer
        // as Int16Array — mismatch produces pure noise on the camera
        // speaker. See Reolink intercom for the same fix.
        targetFormat: 's16le',
        tag: `intercom:${this.opts.deviceTag}:${sessionId}`,
      })
    } catch (err) {
      await talkSession.stop('codec-error').catch(() => {
        /* swallow */
      })
      this.opts.logger.error('intercom: audio-codec createDecodeSession failed', {
        meta: { error: errMsg(err), opusRate, opusChannels, targetRate },
      })
      throw err
    }
    this.opts.logger.info('intercom: audio-codec decode session opened', {
      meta: {
        sessionId,
        codecSessionId: codec.sessionId,
        codecNodeId: codec.nodeId,
        opusRate,
        opusChannels,
        targetRate,
      },
    })

    // 3. WebRTC peer — last resource opened so cleanup ordering
    //    matches the open ordering in reverse.
    const peer = this.opts.peerFactory({ logger: sessionLogger })
    const active: ActiveSession = {
      sessionId,
      peer,
      talkSession,
      codec,
      closed: false,
      startedAtMs: Date.now(),
      framesPushed: 0,
      pcmBytesPushed: 0,
      lastStatsLogAtMs: Date.now(),
      lastStatsFramesPushed: 0,
      lastStatsPcmBytesPushed: 0,
    }
    this.session = active

    peer.onOpusFrame((frame, pts) => {
      void this.handleOpusFrame(active, frame, pts).catch((err: unknown) => {
        this.opts.logger.debug('intercom: opus frame pump error (dropped)', {
          meta: { error: errMsg(err) },
        })
      })
    })

    // Observe a camera-initiated teardown of the talk leg (sticky PUT
    // closed/errored) so the whole session tears down with the precise
    // reason instead of the camera leg dying while WebRTC stays open.
    talkSession.onClose?.((info) => {
      if (active.closed) return
      this.opts.logger.warn('intercom: talk session closed by camera — tearing down', {
        meta: {
          sessionId,
          reason: info.reason,
          error: info.error !== undefined ? errMsg(info.error) : undefined,
        },
      })
      void this.stop(sessionId, info).catch(() => {
        /* swallow */
      })
    })

    // Observe ICE transitions so an `failed`/`disconnected`/`closed`
    // transport tears the session down with a precise reason rather than
    // silently stalling audio. A prime suspect for "talk drops right
    // after activating".
    peer.onIceStateChange?.((state) => {
      const lowered = state.toLowerCase()
      if (active.closed) return
      if (lowered === 'failed' || lowered === 'disconnected' || lowered === 'closed') {
        this.opts.logger.warn('intercom: ICE transport down — closing session', {
          meta: { sessionId, state },
        })
        void this.stop(sessionId, {
          reason: 'ice-disconnected',
          error: new Error(`ICE state: ${state}`),
        }).catch(() => {
          /* swallow */
        })
      }
    })

    let offer: { sdp: string }
    try {
      offer = await peer.createOffer()
    } catch (err) {
      await this.stop(sessionId, { reason: 'peer-closed', error: err }).catch(() => {
        /* swallow */
      })
      this.opts.logger.warn('intercom: webrtc createOffer failed', {
        meta: { error: errMsg(err) },
      })
      throw err
    }

    this.opts.logger.info('intercom session opened', {
      meta: {
        sessionId,
        targetRate,
        opusRate,
        opusChannels,
        codecSessionId: codec.sessionId,
        codecNodeId: codec.nodeId,
      },
    })
    return { sessionId, sdpOffer: offer.sdp }
  }

  async handleAnswer(sessionId: string, sdpAnswer: string): Promise<void> {
    const active = this.requireActive(sessionId)
    await active.peer.setAnswer(sdpAnswer)
    this.opts.logger.debug('intercom: SDP answer accepted', {
      meta: { sessionId },
    })
  }

  /**
   * Tear down the active session in reverse-open order. `opts.reason`
   * records WHY (defaults to a normal `user-stop`) and is threaded into
   * the "intercom session closed" log + every `onClosed` subscriber so a
   * clean operator stop is distinguishable from a failure. Idempotent:
   * a stop for an unknown / already-closed session resolves silently and
   * never re-emits the close info.
   */
  async stop(sessionId: string, opts: IntercomStopOptions = {}): Promise<void> {
    const active = this.session
    if (!active || active.sessionId !== sessionId || active.closed) return
    active.closed = true
    this.session = null

    const reason: IntercomCloseReason = opts.reason ?? 'user-stop'
    const errorMessage = opts.error !== undefined ? errMsg(opts.error) : undefined

    // Reverse-order teardown: WebRTC peer first (stop receiving more
    // Opus), then audio-codec decode session, then the camera leg. The
    // talk-session stop carries the reason so the camera leg can log it.
    try {
      await active.peer.close()
    } catch (err) {
      this.opts.logger.debug('intercom: peer.close error (continuing)', {
        meta: { sessionId, error: errMsg(err) },
      })
    }
    try {
      await this.opts.audioCodec.closeSession({
        sessionId: active.codec.sessionId,
        nodeId: active.codec.nodeId,
      })
      this.opts.logger.debug('intercom: audio-codec decode session closed', {
        meta: {
          sessionId,
          codecSessionId: active.codec.sessionId,
          codecNodeId: active.codec.nodeId,
        },
      })
    } catch (err) {
      this.opts.logger.error('intercom: audio-codec.closeSession error (continuing)', {
        meta: { sessionId, codecSessionId: active.codec.sessionId, error: errMsg(err) },
      })
    }
    try {
      await active.talkSession.stop(reason)
    } catch (err) {
      this.opts.logger.debug('intercom: talk-session.stop error (continuing)', {
        meta: { sessionId, error: errMsg(err) },
      })
    }

    const info: IntercomCloseInfo = {
      sessionId,
      reason,
      ...(errorMessage !== undefined ? { error: errorMessage } : {}),
      framesPushed: active.framesPushed,
      pcmBytesPushed: active.pcmBytesPushed,
      durationMs: Date.now() - active.startedAtMs,
    }
    this.opts.logger.info('intercom session closed', { meta: { ...info } })
    for (const listener of this.closeListeners) {
      try {
        listener(info)
      } catch (err) {
        this.opts.logger.debug('intercom: onClosed listener threw', {
          meta: { sessionId, error: errMsg(err) },
        })
      }
    }
  }

  private async handleOpusFrame(active: ActiveSession, frame: Buffer, pts: number): Promise<void> {
    if (active.closed) return
    active.framesPushed += 1
    try {
      await this.opts.audioCodec.pushEncodedFrame({
        sessionId: active.codec.sessionId,
        nodeId: active.codec.nodeId,
        data: frame,
        pts,
      })
      if (active.closed) return
      const chunks = await this.opts.audioCodec.pullPcm({
        sessionId: active.codec.sessionId,
        nodeId: active.codec.nodeId,
        maxCount: 8,
      })
      if (active.closed) return
      for (const chunk of chunks) {
        const buf = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)
        active.pcmBytesPushed += buf.length
        active.talkSession.feedPcm(buf)
      }
    } catch (err) {
      // A decode-pipeline error is a session-fatal condition (a healthy
      // pump never throws). Surface it as `codec-error` so the close log
      // names the cause instead of silently swallowing the frame.
      this.opts.logger.error('intercom: audio-codec pump error — closing session', {
        meta: {
          sessionId: active.sessionId,
          codecSessionId: active.codec.sessionId,
          codecNodeId: active.codec.nodeId,
          error: errMsg(err),
        },
      })
      void this.stop(active.sessionId, { reason: 'codec-error', error: err }).catch(() => {
        /* swallow */
      })
      return
    }
    this.maybeLogFrameStats(active)
  }

  /**
   * Emit a throttled (≤ once per `FRAME_STATS_INTERVAL_MS`) summary of
   * the audio pump so we can see whether audio actually flows or stalls.
   * Reports cumulative totals + the delta since the last tick — a delta
   * of zero across a window means PCM stopped reaching the camera.
   */
  private maybeLogFrameStats(active: ActiveSession): void {
    const now = Date.now()
    if (now - active.lastStatsLogAtMs < FRAME_STATS_INTERVAL_MS) return
    const framesDelta = active.framesPushed - active.lastStatsFramesPushed
    const pcmBytesDelta = active.pcmBytesPushed - active.lastStatsPcmBytesPushed
    active.lastStatsLogAtMs = now
    active.lastStatsFramesPushed = active.framesPushed
    active.lastStatsPcmBytesPushed = active.pcmBytesPushed
    this.opts.logger.info('intercom audio stats', {
      meta: {
        sessionId: active.sessionId,
        framesPushed: active.framesPushed,
        pcmBytesPushed: active.pcmBytesPushed,
        framesDelta,
        pcmBytesDelta,
        windowMs: now - active.startedAtMs,
      },
    })
  }

  private requireActive(sessionId: string): ActiveSession {
    const active = this.session
    if (!active || active.closed || active.sessionId !== sessionId) {
      throw new Error(`Hikvision intercom: unknown or closed sessionId ${sessionId}`)
    }
    return active
  }
}

function generateSessionId(): string {
  return `intercom-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
