/**
 * Intercom orchestrator — wires the three async layers required to
 * push browser-mic audio onto a Reolink camera's talk channel:
 *
 *   browser  ──── Opus RTP ────►  IntercomWebrtcPeer (werift)
 *                                   │
 *                                   ▼ onOpusFrame(payload)
 *                                 audio-codec cap (decode + resample)
 *                                   │
 *                                   ▼ pullPcm(...)
 *                                 ReolinkIntercomSession.feedPcm(buf)
 *                                   │
 *                                   ▼ ADPCM
 *                                 camera dedicated talk channel
 *
 * Lifecycle (driven by `intercom` cap router calls):
 *   1. `start()` — spin up the WebRTC peer (createOffer), open the
 *      audio-codec decode session, open the Reolink talk session,
 *      wire `onOpusFrame` → push-encoded → pull-PCM → feedPcm.
 *      Returns `{sessionId, sdpOffer}` for the cap router to surface
 *      to the client.
 *   2. `handleAnswer(sessionId, sdpAnswer)` — set remote description
 *      on the peer; once ICE completes, RTP starts flowing.
 *   3. `stop(sessionId)` — close everything in reverse order: WebRTC
 *      peer first (so no more pushes hit the codec session after
 *      close), then audio-codec session, then talk session. Each
 *      teardown is best-effort + idempotent.
 *
 * The WebRTC peer is supplied by the caller (DI) so:
 *   - Unit tests can pass a fake peer with manual `emitOpusFrame()`
 *     and assert the audio-codec / talk-session pipeline behaviour
 *     without standing up a real RTCPeerConnection.
 *   - Future variants (e.g. an audio-only sub-cap on the
 *     `addon-stream-broker`) can plug in different peer impls
 *     without touching the orchestrator.
 *
 * This module deliberately knows NOTHING about werift — the
 * concrete WebRTC peer lives in `intercom-webrtc-peer.ts` and is
 * imported only by the cap registration site in `reolink-camera.ts`.
 */

import type { IntercomAbility, IScopedLogger } from '@camstack/types'
import { ReolinkIntercomSession } from './intercom-session.js'
import type { ReolinkBaichuanApi } from '@apocaliss92/nodelink-js'

/**
 * Audio-codec cap façade — narrow surface the orchestrator needs.
 * Mirrors the methods on `audioCodecCapability` exactly; passing the
 * full `ctx.api.audioCodec` router from the call site is fine.
 */
export interface IntercomAudioCodecApi {
  createDecodeSession(input: {
    codec: string
    sourceSampleRate: number
    sourceChannels: number
    targetSampleRate: number
    targetChannels: number
    /** Output PCM format. Defaults to 'f32le' on the cap side; the
     *  intercom orchestrator pins it to 's16le' so the talk session
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

/**
 * Minimal WebRTC peer contract the orchestrator drives. Implementations
 * own the werift `RTCPeerConnection` lifecycle; the orchestrator only
 * sees the SDP exchange + the Opus frame stream. The `onOpusFrame`
 * callback is registered before `createOffer()` returns so the impl
 * can fire it as soon as RTP starts flowing post-handshake.
 */
export interface IntercomWebrtcPeer {
  /** Build the SDP offer (sendrecv audio) and return its serialized
   *  form. The peer creates the underlying RTCPeerConnection and
   *  audio-recvonly transceiver inside this call. */
  createOffer(): Promise<{ sdp: string }>
  /** Apply the browser's SDP answer. After this resolves and ICE
   *  completes, `onOpusFrame` callbacks start firing. */
  setAnswer(sdp: string): Promise<void>
  /** Subscribe to incoming Opus frames (one call per RTP packet
   *  payload). May be invoked before or after `createOffer` — the
   *  impl buffers callbacks until the receiver track is wired. */
  onOpusFrame(cb: (frame: Buffer, pts: number) => void): void
  /** Best-effort teardown. Idempotent — safe to call multiple times. */
  close(): Promise<void>
}

/** Factory passed into the orchestrator so the DI seam stays small.
 *  The factory is invoked once per session — implementations can hold
 *  per-session state (peer connection, ICE candidates) without
 *  global singletons. */
export type IntercomWebrtcPeerFactory = (deps: { logger: IScopedLogger }) => IntercomWebrtcPeer

/**
 * Configuration the orchestrator needs at construction time. Heavy
 * dependencies (audio-codec router, Reolink API) are passed in by the
 * cap registration site — the orchestrator itself stays vendor-
 * neutral above the talk-session boundary.
 */
export interface IntercomOrchestratorOptions {
  readonly deviceTag: string
  readonly channel: number
  readonly api: ReolinkBaichuanApi
  readonly logger: IScopedLogger
  readonly audioCodec: IntercomAudioCodecApi
  readonly peerFactory: IntercomWebrtcPeerFactory
  /**
   * Sample rate the camera negotiated for IMA ADPCM (Reolink typical:
   * 16000). Resolved at the camera-side from the live talk session
   * post-`start()`; we accept it as an option here so the
   * orchestrator can be unit tested without booting the real lib.
   * Defaults to `16000` when unset.
   */
  readonly cameraSampleRate?: number
  /**
   * Opus codec parameters the browser ships. Default: 48 kHz / 1
   * channel — the audio-codec cap handles resampling down to the
   * camera's rate. Override for stereo intercom devices (none of
   * the supported Reolinks ship stereo at the moment).
   */
  readonly opusSampleRate?: number
  readonly opusChannels?: number
  /**
   * Battery-cam pre-wake hook.
   * When provided, called BEFORE `talkSession.start()` so the cam is
   * awake at handshake time. The hook runs ONLY when the implementer
   * wants to wake — typically gated on `isBatteryCam && isSleeping`
   * at the call site so wired cams skip the cost. Best-effort: a
   * thrown error from the hook bubbles up and aborts session start.
   */
  readonly wakeBeforeStart?: () => Promise<void>
  /**
   * Per-camera intercom tuning settings — mirror the Reolink schema
   * fields with the same names. All optional: each falls back to the
   * `ReolinkIntercomSession` defaults. See `schema.ts` for the
   * operator-facing range descriptions.
   */
  readonly blocksPerPayload?: number
  readonly maxBacklogMs?: number
  readonly outputGain?: number
}

/**
 * Why an intercom session ended. Surfaced in the "intercom session closed"
 * log so an immediate-close is instantly diagnosable from a single line
 * (mirrors the close-reason discipline in the Hikvision provider). Add new
 * variants here rather than logging ad-hoc strings.
 */
export type IntercomCloseReason =
  /** The cap router / client called `stopSession` explicitly. */
  | 'client-stop'
  /** A second `start()` arrived while this session was still open; the stale
   *  session is torn down first. */
  | 'superseded-by-new-start'
  /** `start()` failed partway through and is unwinding what it had opened
   *  (createOffer threw, codec session failed after talk opened, …). */
  | 'start-failed-cleanup'

interface ActiveSession {
  readonly sessionId: string
  readonly peer: IntercomWebrtcPeer
  readonly talkSession: ReolinkIntercomSession
  readonly codec: { sessionId: string; nodeId: string }
  closed: boolean
  /** Anchored zero-PTS reference for monotonic frame stamping. */
  readonly startedAtMs: number
  framesPushed: number
  pcmBytesPushed: number
  /** True once the browser's SDP answer has been applied — lets the close log
   *  distinguish "never completed the handshake" from "was live". */
  answerApplied: boolean
}

/** Default Opus parameters used when the orchestrator caller doesn't
 *  override them. Browser Opus is canonically 48 kHz; mono is the only
 *  practical choice for an intercom (the camera's talk channel is
 *  mono — sending stereo would just cost bandwidth). */
const DEFAULT_OPUS_SAMPLE_RATE = 48_000
const DEFAULT_OPUS_CHANNELS = 1
const DEFAULT_CAMERA_SAMPLE_RATE = 16_000

export class IntercomOrchestrator {
  private session: ActiveSession | null = null

  constructor(private readonly opts: IntercomOrchestratorOptions) {}

  /** True while a session is open (between `start()` resolve and
   *  `stop()` resolve). */
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
   * Open a fresh WebRTC peer + audio-codec decode session + Reolink
   * talk session, wire them, return the SDP offer. Throws (and tears
   * down everything it had spun up) on any failure — the cap router
   * surfaces the error to the client unchanged.
   *
   * Single-active-session semantics: a second `start()` while the
   * first is still open closes the old session before opening the
   * new one. The cap router enforces this on the caller side via
   * `intercomSessions.size === 1` invariants.
   */
  async start(): Promise<{ sessionId: string; sdpOffer: string }> {
    if (this.session && !this.session.closed) {
      // Reuse callers may double-call `start` on flaky clients; close
      // the stale session before standing up a new one. Idempotent
      // teardown means the previous peer + codec + talk session all
      // unwind cleanly.
      await this.stop(this.session.sessionId, 'superseded-by-new-start').catch(() => {
        /* swallow */
      })
    }

    const sessionId = generateSessionId()
    const cameraRate = this.opts.cameraSampleRate ?? DEFAULT_CAMERA_SAMPLE_RATE
    const opusRate = this.opts.opusSampleRate ?? DEFAULT_OPUS_SAMPLE_RATE
    const opusChannels = this.opts.opusChannels ?? DEFAULT_OPUS_CHANNELS

    // Lifecycle: NEGOTIATE. First line emitted for any talk attempt — its
    // presence proves the cap provider was reached (vs the routing-layer
    // failure that hid the missing-registration bug, which produced zero
    // intercom logs at all).
    this.opts.logger.info('intercom: negotiate (opening session)', {
      meta: { sessionId, channel: this.opts.channel, opusRate, opusChannels },
    })

    // 0. Battery-cam pre-wake.
    //    The talk session handshake against a sleeping UDP/battery cam
    //    times out before we even get a chance to send PCM; explicit
    //    wake first is the only reliable path. Wired cams pass a no-op
    //    or no hook at all so this branch is free for them.
    if (this.opts.wakeBeforeStart) {
      try {
        await this.opts.wakeBeforeStart()
      } catch (err) {
        this.opts.logger.warn('intercom: pre-wake failed', {
          meta: { error: errMsg(err) },
        })
        throw err
      }
    }

    // 1. Reolink talk session (the camera-facing leg). Open it FIRST
    //    so that if the camera refuses (sleeping battery cam, no talk
    //    permission, …) we fail fast before allocating WebRTC + codec
    //    resources.
    const talkSession = new ReolinkIntercomSession({
      channel: this.opts.channel,
      api: this.opts.api,
      logger: this.opts.logger.withTags?.({ sessionId }) ?? this.opts.logger,
      deviceTag: this.opts.deviceTag,
      ...(this.opts.blocksPerPayload !== undefined
        ? { blocksPerPayload: this.opts.blocksPerPayload }
        : {}),
      ...(this.opts.maxBacklogMs !== undefined ? { maxBacklogMs: this.opts.maxBacklogMs } : {}),
      ...(this.opts.outputGain !== undefined ? { outputGain: this.opts.outputGain } : {}),
    })
    try {
      await talkSession.start()
    } catch (err) {
      this.opts.logger.warn('intercom: talk session open failed', {
        meta: { error: errMsg(err) },
      })
      throw err
    }
    // The lib reports the negotiated rate post-start — use it
    // (overrides the configured default) so the audio-codec resamples
    // to the right target.
    const realCameraRate = talkSession.sampleRate
    const targetRate =
      Number.isFinite(realCameraRate) && realCameraRate > 0 ? realCameraRate : cameraRate

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
        // 'f32le' (32-bit float) and the talk session reads the buffer
        // as Int16Array — mismatch produces pure noise on the camera
        // speaker (each pair of float bytes interpreted as a random
        // int16 sample).
        targetFormat: 's16le',
        tag: `reolink-intercom:${this.opts.deviceTag}:${sessionId}`,
      })
    } catch (err) {
      await talkSession.stop().catch(() => {
        /* swallow */
      })
      this.opts.logger.warn('intercom: audio-codec createDecodeSession failed', {
        meta: { error: errMsg(err), opusRate, opusChannels, targetRate },
      })
      throw err
    }

    // 3. WebRTC peer — last resource opened so cleanup ordering
    //    matches the open ordering in reverse.
    const peer = this.opts.peerFactory({ logger: this.opts.logger })
    const active: ActiveSession = {
      sessionId,
      peer,
      talkSession,
      codec,
      closed: false,
      startedAtMs: Date.now(),
      framesPushed: 0,
      pcmBytesPushed: 0,
      answerApplied: false,
    }
    this.session = active

    // Wire the pump BEFORE createOffer — werift may emit RTP as soon
    // as ICE completes; subscribing late risks losing the first
    // packet.
    peer.onOpusFrame((frame, pts) => {
      // Best-effort fire-and-forget: a slow audio-codec decode must
      // never block the WebRTC RTP receive loop. Errors are logged
      // and the frame is dropped — Opus FEC + the talk session's
      // own backlog clamping cover transient losses.
      void this.handleOpusFrame(active, frame, pts).catch((err: unknown) => {
        this.opts.logger.debug('intercom: opus frame pump error (dropped)', {
          meta: { error: errMsg(err) },
        })
      })
    })

    let offer: { sdp: string }
    try {
      offer = await peer.createOffer()
    } catch (err) {
      await this.stop(sessionId, 'start-failed-cleanup').catch(() => {
        /* swallow */
      })
      this.opts.logger.warn('intercom: webrtc createOffer failed', {
        meta: { error: errMsg(err) },
      })
      throw err
    }

    // Lifecycle: OPEN. Talk session + codec + peer all up, SDP offer ready
    // to hand back to the client. The next expected line is "SDP answer
    // accepted" (handleAnswer) then PCM flowing (handleOpusFrame).
    this.opts.logger.info('intercom session opened', {
      meta: {
        sessionId,
        channel: this.opts.channel,
        targetRate,
        codecSessionId: codec.sessionId,
        codecNodeId: codec.nodeId,
      },
    })
    return { sessionId, sdpOffer: offer.sdp }
  }

  /**
   * Apply the browser's SDP answer. The session is identified by id
   * (callers may have multiple cameras with overlapping intercom
   * sessions in flight — though this orchestrator only tracks one).
   * Mismatched session id throws.
   */
  async handleAnswer(sessionId: string, sdpAnswer: string): Promise<void> {
    const active = this.requireActive(sessionId)
    await active.peer.setAnswer(sdpAnswer)
    active.answerApplied = true
    this.opts.logger.info('intercom: SDP answer accepted (handshake complete)', {
      meta: { sessionId },
    })
  }

  /**
   * Tear down the session in reverse-open order. Idempotent: a stop
   * for an unknown / already-closed session resolves silently. Best-
   * effort: a partial teardown (e.g. peer.close fails) does NOT
   * abort the rest — the next steps still try to release their own
   * resources.
   *
   * `reason` records WHY the session ended — surfaced in the close log so an
   * immediate-close is diagnosable from one line. The cap-router stop path
   * passes nothing and defaults to `'client-stop'`; internal teardown paths
   * (supersede, start-failure cleanup) pass their specific reason.
   */
  async stop(sessionId: string, reason: IntercomCloseReason = 'client-stop'): Promise<void> {
    const active = this.session
    if (!active || active.sessionId !== sessionId || active.closed) return
    active.closed = true
    this.session = null

    // Reverse-order teardown: WebRTC peer first (stop receiving more
    // Opus frames), then audio-codec, then talk session.
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
    } catch (err) {
      this.opts.logger.debug('intercom: audio-codec.closeSession error (continuing)', {
        meta: { sessionId, error: errMsg(err) },
      })
    }
    try {
      await active.talkSession.stop()
    } catch (err) {
      this.opts.logger.debug('intercom: talk-session.stop error (continuing)', {
        meta: { sessionId, error: errMsg(err) },
      })
    }
    // Lifecycle: CLOSE. `reason` + `answerApplied` make immediate-close
    // diagnosis a single-line read: e.g. reason=client-stop with
    // answerApplied=false and framesPushed=0 means the client tore the
    // session down before the WebRTC handshake ever completed.
    this.opts.logger.info('intercom session closed', {
      meta: {
        sessionId,
        reason,
        answerApplied: active.answerApplied,
        framesPushed: active.framesPushed,
        pcmBytesPushed: active.pcmBytesPushed,
        durationMs: Date.now() - active.startedAtMs,
      },
    })
  }

  /**
   * Push one Opus frame into the audio-codec, immediately drain any
   * decoded PCM, and feed it to the talk session. Push-then-pull
   * keeps latency tight: each Opus frame produces ~20ms of PCM and
   * we surface it on the same async tick.
   *
   * Errors here are isolated to a single frame — the caller wraps in
   * a void-fire-and-forget so an audio-codec hiccup doesn't break
   * the RTP receive loop.
   */
  private async handleOpusFrame(active: ActiveSession, frame: Buffer, pts: number): Promise<void> {
    if (active.closed) return
    // Lifecycle: FEED (first frame only). Proves Opus RTP is actually flowing
    // from the browser post-handshake — the boundary between "handshake
    // completed but mic audio never arrived" (ICE/track issue) and "audio
    // arrived but camera rejected it" (talk-session issue).
    if (active.framesPushed === 0) {
      this.opts.logger.info('intercom: first Opus frame received (feeding camera)', {
        meta: { sessionId: active.sessionId },
      })
    }
    active.framesPushed += 1
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
      // The audio-codec emits Uint8Array; talk session expects Buffer.
      // `Buffer.from(chunk.data.buffer, byteOffset, byteLength)` keeps
      // the original storage (no copy).
      const buf = Buffer.from(chunk.data.buffer, chunk.data.byteOffset, chunk.data.byteLength)
      active.pcmBytesPushed += buf.length
      active.talkSession.feedPcm(buf)
    }
  }

  private requireActive(sessionId: string): ActiveSession {
    const active = this.session
    if (!active || active.closed || active.sessionId !== sessionId) {
      throw new Error(`Reolink intercom: unknown or closed sessionId ${sessionId}`)
    }
    return active
  }
}

/** Random-enough session id — no crypto requirement, just needs to be
 *  unique-per-camera across reasonable timescales. */
function generateSessionId(): string {
  return `intercom-${Date.now().toString(36)}-${Math.floor(Math.random() * 0xffffff).toString(36)}`
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
