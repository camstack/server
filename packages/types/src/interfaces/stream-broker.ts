import type { z } from 'zod'
import type {
  AudioStreamPick,
  BrokerStatsSchema,
  BrokerStatusSchema,
  SubscribeAudioChunksResult,
} from '../capabilities/schemas/streaming-shared.js'
import type { BrokerConsumerAttribution } from '../capabilities/stream-broker.cap.js'
import type { FrameRef } from '../types/frame-view.js'
import type { FrameFormat } from '../types/io.js'
import type { AudioChunkFormat } from '../audio/audio-chunk-format.js'

export type Unsubscribe = () => void

/**
 * Discriminator for `StreamSource.type`. Values that the broker
 * understands today:
 *
 * - `'rtsp'`     — pull mode. Broker connects to a `rtsp://` URL,
 *                   demuxes RTP, exposes raw RTP via `onVideoRtp`.
 * - `'rtmp'`     — pull mode. Broker connects to a `rtmp://` URL,
 *                   demuxes flv into AnnexB packets. No source RTP
 *                   available (RTMP carries no RTP), so the WebRTC
 *                   path falls back to AnnexB → writeVideoNals.
 *                   Reserved — implementation pending.
 * - `'push'`     — push mode. Provider addon delivers AnnexB packets
 *                   via `pushEncodedPacket()` (Reolink Baichuan and
 *                   other event-stream sources).
 * - `'push-rtp'` — push mode with raw RTP packets. Provider addon
 *                   delivers source RTP via `pushVideoRtp()` AND
 *                   AnnexB-equivalents via `pushEncodedPacket()` so
 *                   downstream consumers (decoder, restreamer) keep
 *                   working. Lets the WebRTC path use the H.265
 *                   repacketizer for push-mode H.265 streams. Reserved
 *                   — implementation pending.
 * - `'placeholder'` — silent black-image placeholder reader.
 *
 * String type instead of a literal union so addons remain free to
 * add new source types — the broker's switch statement falls through
 * to "data is pushed externally" for unknown values.
 */
export type StreamSourceType =
  | 'rtsp'
  | 'rtmp'
  | 'push'
  | 'push-rtp'
  | 'rfc4571'
  | 'placeholder'
  | (string & {})

export interface StreamSource {
  readonly type: StreamSourceType
  /** Stream URL — required for pull-based sources (rtsp, rtmp). Not used for push sources. */
  readonly url: string
  readonly videoCodec?: string
  readonly audioCodec?: string
  readonly metadata?: Readonly<Record<string, unknown>>
  /**
   * Push-source flag — when true, a stall in the input stream is
   * treated as a valid suspension (battery cameras intentionally go
   * silent between motion events) rather than an error. The broker
   * stops emitting the black-image placeholder and pauses the watchdog
   * until the next packet arrives. Default: false (legacy behaviour —
   * stall is an error).
   */
  readonly allowStall?: boolean
  /**
   * When set, the broker ingests this source THROUGH ffmpeg (`-c copy`) instead
   * of a native TS client — the "ffmpeg parser". Carries the transport + operator
   * normalization args. Set by the manager from the per-camStream `sourceParser`
   * override. Absent = native ingest.
   */
  readonly ffmpegParser?: {
    readonly transport: 'tcp' | 'udp'
    readonly inputArgs?: readonly string[]
    readonly outputArgs?: readonly string[]
  }
}

export interface StreamSourceOption {
  readonly id: string
  readonly label: string
  readonly source: StreamSource
  readonly resolution?: { readonly width: number; readonly height: number }
  readonly primary?: boolean
}

export interface EncodedPacket {
  readonly type: 'video' | 'audio'
  readonly data: Buffer
  readonly pts: number
  readonly dts: number
  readonly keyframe: boolean
  readonly codec: string
  /**
   * `true` when the packet was synthesized by the broker's placeholder
   * pump (state-aware "RECONNECTING" / "SLEEPING" / etc. keyframes
   * pushed at 1Hz while no real RTP is flowing). Consumers that
   * accumulate per-stream codec state (sticky SPS/PPS, decoder config)
   * MUST treat these as throwaway: the placeholder is a different
   * resolution and parameter set than the live camera, so caching its
   * SPS/PPS and prepending them to real keyframes silently corrupts
   * the decoder state and freezes the WebRTC viewer on the last
   * placeholder until the consumer is re-created. Absent on packets
   * produced from real source data.
   */
  readonly isPlaceholder?: boolean
}

/**
 * Audio metadata declared by push-source providers before they emit the
 * first audio `EncodedPacket`. Mirrors the slice of an SDP audio track
 * the broker actually consumes — `codec` is canonical lowercase
 * ('aac' | 'opus' | 'pcmu' | 'pcma' | ...).
 *
 * `extraData` carries codec-specific config bytes (e.g. AAC
 * AudioSpecificConfig) when the codec needs them at decoder-init time.
 */
export interface PushAudioInfo {
  readonly codec: string
  readonly sampleRate: number
  readonly channels: number
  readonly extraData?: Uint8Array
}

export interface DecodedFrame {
  readonly data: Buffer
  readonly width: number
  readonly height: number
  readonly format: FrameFormat
  readonly timestamp: number
  /** Wall-clock ms (Date.now) when the frame was committed to the shm ring.
   *  Unlike `timestamp` (codec PTS), this is diff-able against Date.now() to
   *  measure frame age (capture→processing). Absent on non-shm frame sources. */
  readonly capturedAt?: number
  /** Process-local lazy source. Present with an empty `data` buffer on the co-located path. */
  readonly frameRef?: FrameRef
  /**
   * True when this frame came out of a session's PRE-ROLL catch-up burst —
   * retained history replayed at session open rather than live footage.
   *
   * It exists so a consumer can ROUTE the frame, not merely label it: history
   * belongs in the runner's bounded pre-roll lane (FIFO, drained strictly
   * behind live), never in the latest-only live detection queue, which would
   * collapse a whole burst to its newest frame. A frame carrying this ALWAYS
   * carries a `capturedAt` measured on the session media clock, not a fresh
   * wall clock.
   */
  readonly preRoll?: boolean
}

export interface DecodedAudioChunk {
  readonly data: Buffer
  readonly sampleRate: number
  readonly channels: number
  readonly timestamp: number
  /**
   * Byte format of `data`. ABSENT MEANS `f32le` (D455). A chunk carrying
   * `pcmu` / `pcma` holds ONE byte per sample and is only ever delivered to a
   * subscription whose `accept` list named that format.
   */
  readonly format?: AudioChunkFormat
}

export interface AudioSubscribeOptions {
  /**
   * Caller identity tag (Phase 10). Surfaced by `listClients` so operators
   * can tell who's holding the broker open. Short and stable
   * (`audio-analyzer`, …). Missing tag → recorded as `'unknown'`.
   */
  readonly tag?: string
  /**
   * Byte formats this subscriber can READ (D455). The broker serves a chunk's
   * own format when it is named here and expands to `f32le` otherwise, so a
   * subscriber is never handed bytes it cannot interpret. Absent = `f32le`.
   */
  readonly accept?: readonly AudioChunkFormat[]
}

/**
 * Broker lifecycle state. Inferred from `BrokerStatusSchema` — the enum the
 * wire actually validates against.
 */
export type BrokerStatus = z.infer<typeof BrokerStatusSchema>

/**
 * Live broker telemetry: the payload of `streamBroker.getBrokerStats` and of
 * the stats push the admin-UI panel subscribes to.
 *
 * Inferred from `BrokerStatsSchema` in
 * `capabilities/schemas/streaming-shared.ts`, which is the schema the cap
 * method validates its output against — so the schema IS the type. This was a
 * hand-written twin until 2026-08-08: two shapes, neither generated from the
 * other, and a field added to one and not the other compiled fine and then
 * silently disappeared on the wire. Every field is documented on the schema;
 * do not restate it here, and never re-introduce a second declaration.
 */
export type BrokerStats = z.infer<typeof BrokerStatsSchema>

export interface IStreamBroker {
  readonly deviceId: string
  readonly status: BrokerStatus
  readonly suspended: boolean
  start(source: StreamSource): Promise<void>
  stop(): Promise<void>
  /**
   * Push an encoded packet into the broker from an external source.
   *
   * Used by camera provider addons that deliver media data directly
   * (e.g. the Reolink Baichuan protocol) instead
   * of exposing an RTSP URL for the broker to pull from.
   *
   * The broker fans out the packet to all consumers: pre-buffer, RTSP
   * restreamer, TCP pipe, decoder sessions, and encoded subscribers.
   */
  pushEncodedPacket(packet: EncodedPacket): void
  /**
   * Push-source audio metadata. Push providers (Reolink Baichuan and
   * the like) call this BEFORE the first audio EncodedPacket so
   * the broker can wire the audio-codec capability — RTSP sources get
   * the same data from the SDP audio track. Repeat calls update the
   * declared codec; calling with `null` retracts (broker tears down
   * any audio decode session).
   *
   * Typical Reolink Baichuan audio: AAC-LC 16 kHz mono. Cameras that
   * push G.711 should still call this so the broker can bypass the
   * codec cap for the supported native codecs.
   */
  pushAudioInfo?(info: PushAudioInfo | null): void
  /**
   * Push a raw video RTP packet from an external source (used by
   * `'push-rtp'`-typed sources, e.g. Reolink Baichuan adapter that
   * synthesizes RTP from its packetizer-friendly access units). The
   * broker fans out to `onVideoRtp` subscribers, including the
   * WebRTC server's H.265 repacketizer path.
   *
   * Sources that don't carry per-packet RTP MAY ignore this entirely
   * and call only `pushEncodedPacket`. Implementations are free to
   * be a no-op when no RTP subscribers exist.
   */
  pushVideoRtp?(rtpData: Buffer): void
  /**
   * Subscribe to AnnexB-encoded packets. The optional `attribution`
   * blob identifies the consumer in the broker's `listClients()` /
   * widget output ("Alexa cam 54 / sessionId=...", "HAP iOS", etc).
   * Callers that don't have identity context pass nothing and land
   * as `kind: 'unknown'`.
   */
  onEncodedData(
    callback: (packet: EncodedPacket) => void,
    attribution?: BrokerConsumerAttribution,
  ): Unsubscribe
  /**
   * Subscribe to source video RTP packets (raw on-wire bytes, before
   * depacketization). Used by the WebRTC server's H.265 path to feed
   * a packet-level repacketizer that preserves the original RTP header
   * layout — Chrome's HEVC depacketizer is sensitive to it.
   *
   * Sources that don't have an underlying RTP wire (e.g. event streams
   * that call `pushEncodedPacket`) MAY register zero callbacks
   * and emit nothing. `attribution` works the same as `onEncodedData`.
   */
  onVideoRtp(
    callback: (rtpData: Buffer) => void,
    attribution?: BrokerConsumerAttribution,
  ): Unsubscribe
  /**
   * Re-tag every subscriber whose attribution carries `sessionId` with the
   * supplied patch (e.g. a remote address discovered once ICE connects). The
   * stored attribution is replaced with a freshly merged object — never
   * mutated. Returns true when at least one entry matched.
   */
  updateConsumerAttributionBySession(
    sessionId: string,
    patch: Partial<BrokerConsumerAttribution>,
  ): boolean
  /**
   * Codec parameter sets harvested from the camera's SDP (sprop-vps /
   * sprop-sps / sprop-pps). Cameras like Reolink high-profile streams
   * publish VPS/SPS/PPS only via SDP — Chrome's HEVC decoder needs them
   * to initialise. Returns null when the broker hasn't connected yet
   * or the camera ships param sets in-band.
   */
  getSdpParameterSets(): ReadonlyArray<Buffer> | null
  /**
   * Subscribe to SDP-derived VPS/SPS/PPS deliveries. Fires once
   * synchronously if the broker already has them (late-subscriber
   * shape), and again every time `onVideoTrack` repopulates them on a
   * reader rebuild. Used by the WebRTC server's H.265 path so a
   * session created during the wake-up window — when
   * `getSdpParameterSets()` still returns null — can seed its
   * `H265Repacketizer` once the camera's first RTP+SDP arrive.
   */
  onSdpParameterSets(callback: (ps: ReadonlyArray<Buffer>) => void): Unsubscribe
  /**
   * Subscribe to SOURCE RESTARTS — every dial after the first, carrying a
   * short reason (`dial#2`, …). The WebRTC server subscribes for EVERY
   * session shape (RTP passthrough, AnnexB, transcode): each holds parameter
   * sets and a bootstrap latch belonging to the connection that ended, so a
   * re-dial must re-sync them rather than leave the session decoding against
   * a dead mapping.
   *
   * Fires on the DIAL, not on the first packet: a restart that never delivers
   * must still be observable rather than silently indistinguishable from a
   * healthy stream. The returned function detaches ONE subscriber (a broker
   * fans out to many live sessions).
   */
  onSourceRestart(observer: (reason: string) => void): Unsubscribe
  /**
   * Source type as configured at `start()` — see `StreamSourceType`
   * for the supported values. `null` before `start()` resolves.
   */
  getSourceType(): StreamSourceType | null
  /**
   * True when the broker can emit source RTP packets via
   * `onVideoRtp` — i.e. the source is RTSP (pull) or push-rtp.
   * RTMP and bare push (AnnexB-only) sources return false.
   * Routing decisions in the WebRTC server (e.g. "use the H.265
   * repacketizer") should consult this rather than string-comparing
   * the source type.
   */
  isRtpSource(): boolean
  /**
   * Open a decoded audio-chunk subscription (Phase 5 / D9) — the
   * serialisable replacement for the live-object `onDecodedAudioChunk`
   * callback. The broker registers a per-subscription bounded FIFO queue
   * and returns a `subscriptionId` the consumer polls via
   * `pullAudioChunks`. Reachable over tRPC (the
   * `stream-broker.subscribeAudioChunks` cap method) so a consumer in a
   * separate process can subscribe — chunk bytes travel inline on the RPC
   * wire (audio chunks are tiny, no shm needed).
   */
  subscribeAudioChunks(options?: AudioSubscribeOptions): SubscribeAudioChunksResult
  /**
   * Drain up to `maxCount` `DecodedAudioChunk`s for an audio-chunk
   * subscription, in FIFO arrival order.
   */
  pullAudioChunks(subscriptionId: string, maxCount: number): readonly DecodedAudioChunk[]
  /** Release an audio-chunk subscription. Returns `true` when it existed. */
  unsubscribeAudioChunks(subscriptionId: string): boolean
  getStats(): BrokerStats
  getLocalStreamUrl(): string
  /**
   * Get the pre-buffer (current GOP from the last keyframe), for late-joining
   * consumers to start decoding immediately. Two mutually-exclusive forms by
   * source: AnnexB (`getPreBuffer`) for push/AnnexB sources (writeVideoNals
   * path); raw source RTP (`getRtpPreBuffer`) for RTP sources (RTSP) on the
   * repacketizer path. A given broker populates exactly ONE of them.
   */
  getPreBuffer(): readonly EncodedPacket[]
  /** Raw source-RTP pre-buffer (current GOP) — RTP sources only; [] otherwise. */
  getRtpPreBuffer(): readonly Buffer[]
  /** Set the pre-buffer duration in seconds (0 to disable, max 30). */
  setPreBufferDuration(seconds: number): void
  /** Get the current pre-buffer duration in seconds. */
  getPreBufferDuration(): number
  setPreBufferEnabled(enabled: boolean): void
}

/**
 * Manager for stream brokers — the server interacts with this interface,
 * while the concrete implementation lives in the addon-stream-broker package.
 */
/** Per-broker RTSP restream entry (absorbed from the former rtsp-restream capability). */
export interface RtspRestreamEntry {
  readonly brokerId: string
  readonly url: string
  readonly mutedUrl: string
  readonly enabled: boolean
}

/**
 * Phase the runner's per-camera state machine occupies. `'idle'` is the
 * `detectionMode === 'disabled'` resting state — runner registered the
 * camera but never subscribed to detection frames. The other 4 are the
 * historical motion-gated states; their transitions are now driven by
 * `detectionMode` ('always-on' starts in 'active', 'on-motion' starts
 * in 'watching').
 */
export type CameraPhase = 'idle' | 'watching' | 'active' | 'paused' | 'load-shed'

export interface CameraDetectionConfig {
  readonly enabled: boolean
  readonly pipelineEnabled: boolean

  /** Motion sources that activate this camera's pipeline. At least one. */
  readonly motionSources: import('./pipeline-orchestrator-capability.js').OrchestrationMotionSources

  /**
   * Which root detectors run for this camera. Forwarded verbatim onto the
   * runner's attach payload; absent is `['pipeline']` all the way down.
   */
  readonly detectionSources?: import('../capabilities/pipeline-runner.cap.js').DetectionSources

  readonly motionStreamId: string
  readonly detectionStreamId: string

  readonly motionFps: number
  readonly detectionFps: number
  /**
   * The detection rate a session opened by the `device-activity` source is
   * capped to (D392). A device-activity session is LONG — a cleaning run is
   * tens of minutes of continuous activity — so it is analysed at a rate that
   * can be sustained for that long, while a session any other trigger opens
   * keeps `detectionFps`. Resolved by the orchestrator and applied at dispatch
   * (`detectionFpsForTrigger`), so what reaches a runner is still a plain
   * `detectionFps` and no runner needs to know this field exists.
   *
   * OPTIONAL because this config is built at several sites, not all of which
   * resolve the device store. Absent means "not resolved here" and the cap
   * still applies at `ACTIVITY_DETECTION_FPS_DEFAULT` — the safe direction: a
   * long session runs slow rather than at full rate for an hour.
   */
  readonly activityDetectionFps?: number
  readonly motionCooldownMs: number
  /**
   * Orchestrator on-motion session-hold cap (ms). While the session is active
   * and a confirmed non-stationary track is still live, the orchestrator holds
   * the session open past `motionCooldownMs` — up to this many ms since it
   * opened — so a slow subject that stops re-triggering VMD is still tracked.
   * Absent ⇒ the orchestrator's built-in default; `0` disables the hold.
   */
  readonly maxSessionHoldMs?: number
  /**
   * Orchestrator quiet period (ms) closing an `audioMode: 'on-motion'` audio
   * window, measured from the last motion event. Required because
   * camera-native motion is a RISING EDGE ONLY — a window closing solely on
   * `detected:false` never closes on an onboard-only camera. Absent ⇒ the
   * orchestrator's built-in default.
   */
  readonly audioMotionWindowMs?: number

  /**
   * WHICH rung this camera's audio analysis listens on: `auto` (the default —
   * the lowest AVAILABLE native rung) or an explicit `high` / `mid` / `low`.
   * Absent reads as `auto`, so a camera with nothing stored behaves exactly as
   * it always has.
   *
   * A rung, never a cam-stream id. The id is broker-internal and changes when a
   * slot is reassigned; a rung is what the operator sees, and it is what lets a
   * pick the camera no longer publishes be REFUSED by name instead of silently
   * resolving to something else. Replaces the never-written `audioStreamId`
   * (D537) — resolution lives in `selectAudioCamStream`, the one place that
   * also knows an audio-only consumer must never cause a video transcode.
   */
  readonly audioStreamPick?: AudioStreamPick

  /**
   * Operator-facing scheduling modes. Forwarded to `RunnerCameraConfig`;
   * the runner uses these to gate its substream subscribers + phase
   * machine. See `PipelinePhaseMode` for the semantics.
   */
  readonly detectionMode: import('../device/device-profile.js').PipelinePhaseMode
  readonly audioMode: import('../device/device-profile.js').PipelinePhaseMode
  /**
   * When true, the runner dynamically opens the WASM frame-diff analyzer
   * on onboard-motion events and tears it down after the cooldown window.
   * Has no effect when `motionSources` already includes `'analyzer'`.
   * Mirrors `audioMode`'s optional pattern — resolved with operator-wins →
   * default(true) in `resolveDeviceDetectionSettings`.
   */
  readonly onboardMotionDrivesAnalyzer: boolean
  readonly occupancyRecheckEnabled: boolean
  readonly occupancyRecheckSec: number
  readonly occupancyRecheckFrames: number
  /**
   * Whether the session's already-decoded PRE-ROLL is inferred rather than
   * dropped as stale, and how many of its frames the catch-up burst may spend
   * (D411). Carried here because the orchestrator resolves it per camera and
   * the runner is the one that spends it.
   */
  readonly preRollInferenceEnabled: boolean
  readonly preRollInferenceFrames: number
}
