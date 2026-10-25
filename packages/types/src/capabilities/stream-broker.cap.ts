import { z } from 'zod'
import { EncodeProfileSchema } from '../encode-profile.js'
import {
  type CapabilityDefinition,
  event,
  type InferProvider,
  method,
} from './capability-definition.js'
import {
  BrokerStatsSchema,
  CameraStreamSchema,
  CamProfileSchema,
  CamStreamKindSchema,
  CamStreamResolutionSchema,
  DecodedAudioChunkSchema,
  ProfileSlotSchema,
  SubscribeAudioChunksInputSchema,
  SubscribeAudioChunksResultSchema,
} from './schemas/streaming-shared.js'

/** Stream delivery format. (Relocated from the retired `streaming-engine` cap.) */
export const StreamFormatSchema = z.enum(['webrtc', 'hls', 'mjpeg', 'rtsp'])
export type StreamFormat = z.infer<typeof StreamFormatSchema>

/** A container `produceEventMedia` can emit. */
export const EventMediaKindSchema = z.enum(['mp4', 'gif'])
export type EventMediaKind = z.infer<typeof EventMediaKindSchema>

/**
 * One produced artifact, referenced by HANDLE.
 *
 * Never inline bytes: a produced clip is 200 KB–5 MB and every consumer of this
 * method is in another runner ([D9](../../../../docs/decisions/adr-0009.md),
 * [D18](../../../../docs/decisions/adr-0018.md) — cross-process media is fetched
 * on demand, compressed, by handle). `bytes` is here so a caller can decide
 * whether it wants the fetch at all.
 */
export const EventMediaArtifactSchema = z.object({
  kind: EventMediaKindSchema,
  /** Opaque, single-camera, short-lived. Redeem with `fetchEventMedia`. */
  handle: z.string(),
  /**
   * The node holding the bytes — the ROUTING key for `fetchEventMedia`.
   *
   * `stream-broker` is a singleton cap and an unpinned call never leaves the
   * hub, so a handle produced on an agent's broker would be redeemed against
   * the hub's store and come back `null`. Same contract, same field name and
   * the same reason as `FrameHandleSchema.nodeId`: the producer stamps where it
   * lives and the consumer pins to it.
   */
  nodeId: z.string(),
  mime: z.string(),
  bytes: z.number().int(),
  width: z.number().int(),
  height: z.number().int(),
})
export type EventMediaArtifact = z.infer<typeof EventMediaArtifactSchema>

/**
 * What a production actually covered — the answer to the only question an
 * operator asks about a notification clip.
 *
 * `fromTs`/`toTs` are WALL CLOCK, derived from the ring's own packet timeline,
 * so a caller can state "this clip starts 4.1 s before the event" instead of
 * inferring it from a duration. A production whose `fromTs` is later than the
 * event is a production with no pre-roll, and that is exactly the defect this
 * method exists to make visible rather than plausible.
 */
export const EventMediaCoverageSchema = z.object({
  fromTs: z.number(),
  toTs: z.number(),
  /** Encoded packets in the muxed window. */
  packets: z.number().int(),
})
export type EventMediaCoverage = z.infer<typeof EventMediaCoverageSchema>

/**
 * The result of ONE cut, in every container the caller asked for.
 *
 * Every artifact in `media` came out of the SAME window of the SAME rendition —
 * that is the whole reason this is one method rather than one call per format.
 * A consumer attaching a gif and a video can no longer show two different
 * moments, because it never chose two sources.
 */
export const EventMediaProductionSchema = z.object({
  media: z.array(EventMediaArtifactSchema).readonly(),
  coverage: EventMediaCoverageSchema,
  /** The rendition actually cut from — what the default or the fallback chose. */
  profile: CamProfileSchema,
  /** `copy` = the camera's own H.264, untouched. `encode` = re-encoded (H.265
   *  source, a downscale, or a playback rate other than 1). */
  video: z.enum(['copy', 'encode']),
})
export type EventMediaProduction = z.infer<typeof EventMediaProductionSchema>

const RtspRestreamEntrySchema = z.object({
  brokerId: z.string(),
  url: z.string(),
  mutedUrl: z.string(),
  enabled: z.boolean(),
  /**
   * Source-stream codec / resolution for the camStream this entry serves
   * (the broker's "high"/"mid"/"low" profile slot for this device).
   * Used by exporter pickers (`pickPreferredRtspEntry`) to resolve
   * `streamPreference: 'auto'` to the slot whose source is closest to
   * the consumer's target — Alexa wants ~720p, HomeKit wants ~1080p,
   * and there's no point dialling the 4K slot for an Echo Show. Absent
   * when the source publisher never advertised the field; pickers fall
   * back to first-enabled in that case.
   */
  codec: z.string().optional(),
  resolution: z
    .object({
      width: z.number().int().positive(),
      height: z.number().int().positive(),
    })
    .optional(),
})

export const BrokerRtspClientSchema = z.object({
  sessionId: z.string(),
  remoteAddr: z.string(),
  /** Client `User-Agent` (e.g. `recorder` for the recorder's RTSP pull), or
   *  null/absent when the client sent none. Lets the UI label a consumer by
   *  purpose. Optional so a client built against an older schema stays valid. */
  userAgent: z.string().nullish(),
  playing: z.boolean(),
  muted: z.boolean(),
  connectedAt: z.number(),
  lastRtpAt: z.number(),
  bytesSent: z.number(),
})

export const BrokerAudioClientSchema = z.object({
  tag: z.string(),
  subscribedAt: z.number(),
  chunksDelivered: z.number(),
})

/**
 * Identifies who is holding an encoded / raw-RTP subscription open on
 * the broker. Populated by the subscribing addon when it attaches —
 * defaults to `{ kind: 'unknown' }` for callers that haven't been
 * migrated. The widget surfaces every field that's set so an operator
 * can answer "who is keeping cam X warm?" without grepping logs.
 */
export const BrokerConsumerKindSchema = z.enum([
  'alexa',
  'homekit',
  'webrtc-browser',
  'webrtc-mobile',
  'webrtc-whep',
  'rtsp-listen',
  'derived-broker',
  'recording',
  'pipeline',
  'snapshot',
  'warmup',
  'unknown',
])
export type BrokerConsumerKind = z.infer<typeof BrokerConsumerKindSchema>

export const BrokerConsumerAttributionSchema = z
  .object({
    kind: BrokerConsumerKindSchema,
    /**
     * Free-form label intended to disambiguate consumers OF THE SAME kind
     * on the same broker — e.g. user name, device alias. Should NOT repeat
     * the kind / cam / cam-stream / sessionId (those are surfaced by
     * dedicated fields). When empty the widget falls back to `${kind} ·
     * <sessionId tail>`.
     */
    label: z.string().optional(),
    /**
     * Which part of the encoded plane this subscription consumes:
     *   - `'audio'` — audio packets only
     *   - `'video'` — video packets only
     *   - `'both'`  — both video + audio (typical for AnnexB push paths
     *                 that don't split the source RTP)
     *
     * Missing field means "unknown" — older callers and the legacy
     * paths that haven't been migrated yet.
     */
    media: z.enum(['audio', 'video', 'both']).optional(),
    /**
     * Codec the consumer receives AFTER any per-session re-encoding. For
     * a WebRTC session this is the negotiated egress codec (e.g. `H264`,
     * `H265`, `Opus`, `Pcmu`); for an RTSP restreamer it mirrors the
     * source codec. Surfaced in the widget chip so operators see at a
     * glance whether a viewer is on H.264 (Echo) or H.265 (Safari).
     */
    targetCodec: z.string().optional(),
    /**
     * Whether the broker is re-encoding for this consumer:
     *   - `'passthrough'` — bytes flow source→consumer without ffmpeg
     *   - `'repacketize'` — RTP payload is re-packetized but NOT re-encoded
     *                       (preserves frames, just rebuilds headers; e.g.
     *                       the H.265 repacketizer path)
     *   - `'transcode'`   — a full encode/decode round (ffmpeg, libx264,
     *                       libav…); the most expensive path
     */
    transport: z.enum(['passthrough', 'repacketize', 'transcode']).optional(),
    /** Remote peer IP if the consumer terminates a network socket. */
    remoteAddr: z.string().optional(),
    /**
     * Server-read User-Agent of the originating client; enriched by the hub
     * from the tRPC request context (browser sessions).
     */
    userAgent: z.string().optional(),
    /** Authenticated user id (CamStack OAuth subject) when known. */
    userId: z.string().optional(),
    /** Higher-level session identifier (Alexa Echo sessionId, HAP session, …). */
    sessionId: z.string().optional(),
    /** Free-form key/value extras (e.g. clientHints from a WebRTC offer). */
    extra: z.record(z.string(), z.string()).optional(),
  })
  .readonly()
export type BrokerConsumerAttribution = z.infer<typeof BrokerConsumerAttributionSchema>

export const BrokerEncodedClientSchema = z.object({
  /** Stable id assigned on attach; used by `killClient`. */
  id: z.string(),
  /** Which broker fanout the subscriber rides — annexB encoded packets vs raw RTP. */
  channel: z.enum(['annexb', 'rtp']),
  attribution: BrokerConsumerAttributionSchema,
  subscribedAt: z.number(),
  /** Total packets delivered (annex-B EncodedPackets or RTP byte-buffers). */
  packetsDelivered: z.number(),
})
export type BrokerEncodedClient = z.infer<typeof BrokerEncodedClientSchema>

export const BrokerClientsSchema = z.object({
  rtsp: z.array(BrokerRtspClientSchema).readonly(),
  audio: z.array(BrokerAudioClientSchema).readonly(),
  encoded: z.array(BrokerEncodedClientSchema).readonly(),
  pipeClients: z.number(),
  /** Total encoded + raw-RTP callback subscriber count (sum of `encoded[].length`). */
  encodedSubscribers: z.number(),
})

export type BrokerRtspClient = z.infer<typeof BrokerRtspClientSchema>
export type BrokerAudioClient = z.infer<typeof BrokerAudioClientSchema>
export type BrokerClients = z.infer<typeof BrokerClientsSchema>

/**
 * How many people are watching one camera LIVE right now — see
 * `getLiveViewerCounts`. A camera with nobody watching is absent from the list
 * (so `viewers` is always at least 1): the listing carries the cameras that
 * have viewers, never a row of zeros.
 */
export const LiveViewerCountSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  viewers: z.number().int().positive(),
})
export type LiveViewerCount = z.infer<typeof LiveViewerCountSchema>

export const PlaceholderReasonSchema = z.enum([
  'reconnecting',
  'sleeping',
  'offline',
  'disabled',
  'waking',
])
export type PlaceholderReason = z.infer<typeof PlaceholderReasonSchema>

// ── getStreamWithCodec: shared codec-targeted read API ──────────────

const VideoCodecTargetSchema = z.enum(['h264', 'h265', 'copy'])
export type VideoCodecTarget = z.infer<typeof VideoCodecTargetSchema>

const AudioCodecTargetSchema = z.enum(['aac', 'opus', 'pcmu', 'copy', 'none'])
export type AudioCodecTarget = z.infer<typeof AudioCodecTargetSchema>

export const GetStreamWithCodecInputSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  /** Target codec. `'copy'` = passthrough (no re-encode). */
  video: VideoCodecTargetSchema,
  /** Target audio codec. `'copy'` = passthrough. Defaults to `'aac'`. */
  audio: AudioCodecTargetSchema.optional(),
  /** Target a profile's assigned source camStream. Required to resolve a source. */
  profile: CamProfileSchema.optional(),
  /** Optional output resolution target. When set: drives the transcode
   *  output scale (downscale toward WxH), and — when `profile` is absent —
   *  selects the published source closest to this resolution. Ignored for
   *  `video:'copy'` scaling (a copy can't be rescaled), but still used for
   *  source selection. */
  targetResolution: z
    .object({ width: z.number().int().positive(), height: z.number().int().positive() })
    .optional(),
  /** Extra ffmpeg output flags appended verbatim by the consumer (in code).
   *  Folded into the pipeline key so different args never share a child. */
  outputArgs: z.array(z.string()).optional(),
  /** Opt-in: carry transcoded audio over an RTP sidecar grafted into the
   *  restreamer SDP (only for re-encoded audio targets — aac/opus/pcmu).
   *  Default/absent = the live-verified video-only egress. */
  audioEgress: z.boolean().optional(),
  /** Host to embed in the returned restream `url`. The broker is hub-only, so
   *  its restream URLs default to `127.0.0.1` (consumable only from the hub).
   *  A REMOTE consumer (e.g. a recorder running on an agent designated as the
   *  recording node) passes the hub's cluster-resolvable host here so the
   *  returned `rtsp://<host>:<port>/<token>` is dialable from that node. The
   *  port/token (and the underlying restreamer, bound on 0.0.0.0) are
   *  unchanged — `hostname` only rewrites the client-facing dial address.
   *  Absent/empty = `127.0.0.1` (the hub-local default). */
  hostname: z.string().optional(),
  tag: z.string().optional(),
})
export type GetStreamWithCodecInput = z.infer<typeof GetStreamWithCodecInputSchema>

export const RtpSourceSchema = z.object({
  url: z.string(),
  /**
   * The SENTRY counterpart of {@link url} — the dial that asks for the stream
   * WITHOUT asking for the camera — or `null` when this camera offers none.
   *
   * The broker answers it because the broker is the only thing that can:
   * eligibility is `sentryEligible` (a BATTERY camera that DECLARES the signals
   * cap), asked of facts only the broker holds. A consumer re-deriving it from
   * cap bindings would be a second authority, and two authorities on the same
   * question is how a composite camera ends up dialling a sleeping camera
   * because its own copy of the rule was a release behind.
   *
   * `null` is a real answer and is never a live url in disguise: a consumer
   * that silently fell back to {@link url} would perform exactly the wake this
   * field exists to prevent. Only a PASSTHROUGH acquisition can offer one — a
   * transcode hands back an egress the broker is feeding itself, which has no
   * sentry counterpart.
   */
  sentryUrl: z.string().nullable().optional(),
  videoCodec: z.enum(['H264', 'H265']),
  audioCodec: z.string(),
  resolution: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  transcoded: z.boolean(),
  encoder: z.string(),
  pipelineKey: z.string(),
})
export type RtpSource = z.infer<typeof RtpSourceSchema>

// ── acquireEgressTranscode: THE cluster-reachable ffmpeg primitive ──
//
// One capability method through which every live-media consumer asks for an
// encoded stream. It exists as a CAPABILITY rather than an internal module so
// the transcode is PLACEABLE: `stream-broker` is a `mode: 'singleton'` cap with
// `placement: "any-node"`, and `classifyCapRoute` gives Priority 1 to
// `hub-in-process`, so an unpinned call never leaves the hub — placement is a
// caller-side `nodePin(nodeId)`, exactly as the recorder and pipeline-runner
// already pin their broker calls. See `docs/decisions/adr-0067.md` for what
// still has to be true before a transcode can genuinely run off-hub.

/**
 * The encode request — **structured and serialisable, with NO raw-flag escape
 * hatch.** This is deliberate and it is the one lesson taken from
 * `getStreamWithCodec`: that method's `outputArgs: string[]` is simultaneously
 * its extensibility mechanism AND part of `pipelineKeyFor`'s sharing key, so
 * adding a flag silently forks the shared child, and two consumers that mean
 * the same thing but spell it differently never share. Here every knob is a
 * NAMED field: a new requirement becomes a schema field (and a codegen run),
 * never an opaque array.
 *
 * `inputArgs` / `outputArgs` are omitted from the profile for the same reason.
 * The operator-facing derived-stream transform editor still has them — that is
 * a different surface (`publishCameraStream({ kind: 'derived' })`) with a
 * different purpose (reshaping a badly-behaved SOURCE), and it is unchanged.
 */
export const EgressEncodeSchema = EncodeProfileSchema.omit({
  inputArgs: true,
  outputArgs: true,
})
export type EgressEncode = z.infer<typeof EgressEncodeSchema>

/**
 * How the encoder is bounded. `'tight'` is a one-second VBV window for a
 * consumer whose budget is enforced per second (HomeKit); `'relaxed'` is two
 * seconds, letting a keyframe spike borrow from the next second (a browser,
 * an Echo). Named rather than numeric so the INTENT survives.
 */
export const EgressRateControlSchema = z.enum(['tight', 'relaxed'])
export type EgressRateControl = z.infer<typeof EgressRateControlSchema>

export const EgressTranscodeRequestSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  /** Which published stream to read. */
  source: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('profile'), profile: CamProfileSchema }),
    z.object({ kind: z.literal('cam-stream'), camStreamId: z.string().min(1) }),
  ]),
  encode: EgressEncodeSchema,
  rateControl: EgressRateControlSchema.optional(),
  /**
   * `-bsf:v`. A consumer that negotiates its OWN SDP (HomeKit) cannot carry
   * out-of-band extradata and needs `dump_extra` on both the copy and encode
   * branches. Enumerated, not free text.
   */
  bitstreamFilter: z.enum(['dump_extra', 'h264_mp4toannexb', 'hevc_mp4toannexb']).optional(),
  /**
   * Publish the transcode as a LOCAL push cam stream, instead of leaving the
   * consumer to dial the returned url. The broker picks the id and returns it
   * as `camStreamId` — a caller-supplied one would be circular, since the
   * sharing key is computed FROM this request.
   *
   * The url is still returned and still the contract for a transcode pinned to
   * another node. But dialling it locally costs an RTSP round trip that changes
   * the transport underneath the consumer: a dialled stream is an RTP source,
   * so `isRtpSource()` is true and the session takes the RTP-passthrough +
   * repacketizer branch. The push branch — the one the derived mechanism has
   * live hours on — is never reached. Measured on Alexa: broker registered, RTP
   * arriving, key frame arriving, black screen, on a chain healthy at every
   * other point.
   *
   * Same idea the transport already applies to CALLS, where `classifyCapRoute`
   * gives priority to `hub-in-process` so a local call never leaves the node.
   * This is that rule for media.
   */
  publishLocally: z.boolean().optional(),
  pixelFormat: z.enum(['yuv420p', 'nv12']).optional(),
  /**
   * Operator/consumer override for decode hardware. ABSENT is the normal case
   * and the one that matters: the broker then resolves the backend from the
   * DECODER ADDON's per-node `probedBestHwaccel` (see
   * `@camstack/types` `ffmpeg/hwaccel.ts`), which is the ranking known to work
   * on this hardware — never the raw kernel resolver's qsv-first order.
   */
  decodeHwAccel: z.enum(['auto', 'none', 'videotoolbox', 'vaapi', 'qsv', 'cuda']).optional(),
  /**
   * Host to embed in the returned restream `url`. The broker mints hub-local
   * `127.0.0.1` URLs; a consumer on another node passes a cluster-resolvable
   * host (`NodeTopologyService.reachableHostByNode`) so the returned URL is
   * dialable from there. Same contract as `getStreamWithCodec.hostname` —
   * `substituteRtspHost` rewrites only the dial address, never the restreamer.
   */
  hostname: z.string().optional(),
  /** Attribution for the broker panel. Never part of the sharing key. */
  tag: z.string().optional(),
})
export type EgressTranscodeRequest = z.infer<typeof EgressTranscodeRequestSchema>

export const EgressTranscodeSchema = z.object({
  /** Dial-able RTSP url (host-substituted when `hostname` was supplied). */
  url: z.string(),
  /** Release handle. Refcounted — the child dies when the last holder releases. */
  pipelineKey: z.string(),
  videoCodec: z.enum(['H264', 'H265']),
  resolution: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  transcoded: z.boolean(),
  encoder: z.string(),
  /**
   * The decode backend the child ACTUALLY ran with — `null` for software.
   * Returned rather than assumed: a consumer that asked for hardware and got
   * software needs to be able to see that without reading the broker's logs.
   */
  decodeHwAccel: z.string().nullable(),
  /**
   * Set when `publishLocally` was honoured: attach to THIS instead of dialling
   * `url`, and the session takes the push/deframe transport rather than the
   * RTP-passthrough one. `null` means the consumer must dial.
   */
  camStreamId: z.string().nullable(),
})
export type EgressTranscode = z.infer<typeof EgressTranscodeSchema>

export const streamBrokerCapability = {
  name: 'stream-broker',
  scope: 'system',
  mode: 'singleton',
  exposesDeviceSettings: true,
  methods: {
    /**
     * A device reporting that one of ITS OWN signals just fired.
     *
     * The provider calls this; nothing polls. The broker then decides whether
     * to wake the source, and the decision has two terms that must BOTH hold:
     *
     *  - the signal is ENABLED for this camera (the operator's per-camera
     *    choice — a camera may declare a signal the operator does not want
     *    waking anything), and
     *  - a consumer is actually attached and waiting on the sentry. Waking
     *    a camera nobody is watching is the one thing a battery camera must
     *    never do, and a signal arriving with no consumer is exactly that.
     *
     * Reported, never inferred: a signal that fires while the stream is
     * already up refreshes the hold instead of starting a second one, which is
     * what makes continuous motion keep a camera awake without stacking
     * timers.
     *
     * `code` is the provider's own, from `streamSignals.listSignals`. An
     * unknown code is REFUSED rather than treated as a wildcard wake — a
     * provider and an operator disagreeing about a name must not become a
     * camera that wakes for everything.
     */
    reportStreamSignal: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        /** The provider's signal code. */
        code: z.string().min(1),
        /** Ms epoch. Absent ⇒ now. */
        at: z.number().optional(),
      }),
      z.object({
        /** Whether the broker acted on it, and if not, why. */
        accepted: z.boolean(),
        reason: z.enum(['woke', 'hold-extended', 'not-enabled', 'no-consumer', 'unknown-code']),
      }),
      // A mutation: it can dial a camera. A query that wakes hardware would be
      // a lie to every caller that assumes a read is free.
      { kind: 'mutation' },
    ),
    publishCameraStream: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        camStreamId: z.string().min(1),
        kind: CamStreamKindSchema,
        url: z.string().optional(),
        codec: z.string().optional(),
        resolution: CamStreamResolutionSchema.optional(),
        fps: z.number().positive().optional(),
        label: z.string().optional(),
        deviceFeatures: z.array(z.string()).optional(),
        autoEligible: z.boolean().optional(),
        /** The slot the publisher says this stream IS — see `CameraStreamSchema.profileHint`. */
        profileHint: CamProfileSchema.optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
        /** Required when kind === 'derived' — the source camStreamId the
         *  derived broker reads its encoded plane from.
         *  The runtime guard (broker manager, Task 10) enforces presence for
         *  kind === 'derived'; the schema stays permissive so ts-morph emits
         *  full field types instead of collapsing to ZodEffects. */
        sourceCamStreamId: z.string().min(1).optional(),
        /** Required when kind === 'derived' — the ffmpeg params for the
         *  spawn. Reuses the same brokerId for identical params (single-flight).
         *  Runtime guard in broker manager; schema is permissive (see above). */
        encodeProfile: EncodeProfileSchema.optional(),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    retractCameraStream: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        camStreamId: z.string().min(1),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    assignProfile: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        profile: CamProfileSchema,
        camStreamId: z.string().min(1),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    unassignProfile: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        profile: CamProfileSchema,
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * The HARDWARE behind a device number was replaced
     * (`deviceManager.migrateDevice`). Forget every piece of broker state that
     * described the old box, so the next catalog pull derives everything from
     * the camera that is actually there:
     *
     *  - every `derived:*` stream definition — a derived is authored against a
     *    specific profile layout, and against the wrong hardware its feeder
     *    respawns forever (observed at attempt 2732 on the live hub,
     *    2026-09-01);
     *  - the profile-slot assignment entry, PURGED (not unassigned — unassign
     *    marks the slot manual, which would pin the stale choice instead of
     *    letting `computeInitialAssignment` re-derive it);
     *  - the probe snapshots (`<deviceId>/…` — probed codec/resolution of the
     *    old hardware);
     *  - the persisted RTSP token rows for the device's brokers (keyed
     *    `<deviceId>/<camStreamId>`; the stream ids change with the hardware,
     *    so the rows are dead URLs).
     *
     * An RPC, deliberately — an event is telemetry and may be dropped (D8),
     * and a dropped forget leaves a feeder respawning against a stream that
     * does not exist.
     */
    forgetDeviceHardware: method(
      z.object({ deviceId: z.number().int().nonnegative() }),
      z.object({
        derivedStreamsDeleted: z.array(z.string()).readonly(),
        assignmentsPurged: z.boolean(),
        probeSnapshotsDropped: z.number().int().nonnegative(),
        rtspTokenRowsDeleted: z.number().int().nonnegative(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Render a short GIF or MP4 from the broker's PRE-BUFFER around an instant.
     *
     * The pre-buffer is the only source that already holds the seconds BEFORE
     * an event (it is what it exists for — "when an addon needs the last N
     * seconds of video for clip creation"). Cutting from recorded segments
     * cannot: only finalized segments are addressable and the one covering the
     * moment is still being written, so a segment-sourced clip is either
     * delayed or shows the approach instead of the event (operator,
     * 2026-07-30). It also means a camera does not have to be RECORDING to
     * produce a notification clip.
     *
     * Returns muxed BYTES, never packets: the frame plane never crosses a
     * process boundary at frame rate (D9/D18) — this is one compressed,
     * on-demand payload per notification.
     *
     * Waits up to `postRollSec` for the tail to accumulate, so the window is
     * CENTRED on `aroundMs`.
     */
    renderPreBufferClip: method(
      z.object({
        deviceId: z.number(),
        /** Absent = the LOWEST assigned profile — a notification attachment is
         *  watched on a phone, and the cheap rendition is the right default. */
        profile: CamProfileSchema.optional(),
        aroundMs: z.number(),
        preRollSec: z.number().min(0).max(20).default(3),
        postRollSec: z.number().min(0).max(20).default(5),
        format: z.enum(['gif', 'mp4']).default('gif'),
        maxWidth: z.number().int().min(120).max(1920).default(480),
        /** GIF only — MP4 keeps the source cadence. */
        fps: z.number().int().min(1).max(15).default(5),
        /**
         * Playback rate. A notification clip is GLANCED at on a lock screen,
         * not watched, so 2x is the default: the recipient sees the whole
         * passage in half the time and the GIF is half the bytes. `1` is real
         * time. Applies to MP4 as well — the operator set a speed, not a GIF
         * speed.
         */
        speed: z.number().min(1).max(8).default(2),
      }),
      z.object({
        base64: z.string(),
        mime: z.string(),
        bytes: z.number().int(),
        /** The profile actually rendered (what the default resolved to). */
        profile: CamProfileSchema,
        durationMs: z.number(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * THE production point for event media — one window, every container.
     *
     * `renderPreBufferClip` renders ONE format per call, so a consumer wanting a
     * gif and a video made two calls and got two windows. On 2026-08-08 the
     * operator received exactly that: a gif around a doorbell press and an mp4
     * of the six seconds after it. This method cuts once and derives the rest,
     * so "the attachments agree" is a property of the service instead of a
     * discipline every consumer has to keep.
     *
     * It is also the only place that owns the packets. The broker already
     * retains an AnnexB ring per camera (`setClipRetention`, D32) — the
     * prebuffer — so a production reaches BACKWARDS from the event with no
     * process to spawn and nothing kept warm. It waits out `postSeconds`, muxes
     * the window once (COPYING the camera's own H.264 whenever nothing is being
     * changed), derives any gif from that same mux, and returns HANDLES.
     *
     * Intended for every future consumer, not just notifications: a clips API, a
     * retrain export and an event export all want the same window of the same
     * camera and must not each grow their own renderer.
     */
    produceEventMedia: method(
      z.object({
        deviceId: z.number(),
        /** Absent = the largest H.264 rendition at or below 1080p, which is
         *  also the one that can be copied. Falls back to whatever the ring
         *  actually retained, and the answer says which. */
        profile: CamProfileSchema.optional(),
        aroundMs: z.number(),
        preSeconds: z.number().min(0).max(20).default(4),
        postSeconds: z.number().min(0).max(20).default(6),
        kinds: z.array(EventMediaKindSchema).min(1).default(['mp4']),
        /** GIF geometry. The video keeps the source's own. */
        gifMaxWidth: z.number().int().min(120).max(1280).default(640),
        /**
         * The gif's own PLAYBACK rate in frames per second — what the finished
         * gif runs at, not how many source frames feed it. The decimation that
         * feeds it samples `gifFps / gifSpeed` source frames per second, so at
         * the defaults a 12 fps gif is built out of 3 source frames a second.
         */
        gifFps: z.number().int().min(1).max(15).default(12),
        /**
         * How fast the GIF plays against real time, independent of `speed`.
         *
         * 4× by default, by operator request: a notification gif is glanced at
         * on a lock screen, so a ~12 s window has to be over in ~3 s. It stays
         * a separate knob from `speed` even though both now default to 4 —
         * a caller wanting a real-time video and a fast gif must not have to
         * choose.
         */
        gifSpeed: z.number().min(1).max(8).default(4),
        /**
         * Playback rate of the VIDEO. Also 4× by default, by operator decision.
         *
         * `1` is real time and is the ONLY value that allows the copy branch —
         * anything else forces `libx264` over the window. That was priced
         * before it was chosen: a per-event burst measured at 0.23 s and 254 KB
         * on a real 101 720p cut, against 922 KB for the copy it replaces. A
         * re-encode is capped at 720p (`EVENT_CLIP_ENCODE_MAX_WIDTH`), because
         * once the decode is forced the width stops being free.
         */
        speed: z.number().min(1).max(8).default(4),
      }),
      EventMediaProductionSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Redeem a {@link EventMediaArtifactSchema} handle for its bytes.
     *
     * Separate from the production on purpose (D18): the producing runner keeps
     * the artifact for a few minutes, and a consumer that only wanted the
     * coverage never moves a megabyte. `null` once it has expired — a handle is
     * short-lived by design and a caller that waited too long must see that
     * rather than a zero-length file.
     */
    fetchEventMedia: method(
      z.object({ handle: z.string() }),
      z
        .object({
          base64: z.string(),
          mime: z.string(),
          bytes: z.number().int(),
        })
        .nullable(),
      { kind: 'mutation', auth: 'admin' },
    ),
    listAllCameraStreams: method(z.void(), z.array(CameraStreamSchema).readonly()),
    listAllProfileSlots: method(z.void(), z.array(ProfileSlotSchema).readonly()),
    getBrokerStats: method(z.object({ brokerId: z.string() }), BrokerStatsSchema),
    /**
     * Force a one-shot probe of a single source stream: transiently dial the
     * broker (a `warmup` consumer), capture a fresh `BrokerStats` snapshot for
     * the per-stream "Probed" settings field, then release. Wakes a suspended
     * (incl. battery) stream for a few seconds. `summary` is the rendered
     * probed-values string; `probed` is false if the stream never reached
     * `streaming` within the timeout.
     */
    probeStream: method(
      z.object({ brokerId: z.string() }),
      z.object({ probed: z.boolean(), summary: z.string() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    listClients: method(z.object({ brokerId: z.string() }), BrokerClientsSchema),
    /**
     * People watching each camera LIVE right now, for every camera at once —
     * cheap enough to poll (a walk of the live session maps, no I/O).
     *
     * Counts EXTERNAL viewers only: WebRTC sessions of a viewer kind
     * (`webrtc-browser` / `-mobile` / `-whep`, `alexa`, `homekit`) that are on
     * the live edge, plus RTSP restream clients from outside that are playing.
     * The system's own consumers are never counted: the detection decoder, the
     * recorder, snapshots, the prebuffer hold, audio analysis, and the RTSP
     * dials an agent's derived broker makes. One WebRTC session or RTSP
     * connection is one viewer, so two tabs on one camera read 2.
     *
     * The count is read off the live session maps at call time, so a session
     * that ends — cleanly or by the peer vanishing — stops counting with no
     * counter to leak. It covers the sessions THIS provider serves; a node
     * with its own stream-broker is asked with a `nodeId` pin.
     */
    getLiveViewerCounts: method(z.void(), z.array(LiveViewerCountSchema).readonly(), {
      role: 'viewer',
    }),
    killClient: method(
      z.object({
        brokerId: z.string(),
        channel: z.enum(['rtsp', 'audio']),
        handle: z.string(),
      }),
      z.object({ killed: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    restartProfile: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        profile: CamProfileSchema,
      }),
      z.object({ success: z.boolean() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * LEGACY / observability. Returns a raw per-broker restream URL for a
     * single stream. Prefer {@link getStreamWithCodec} for programmatic
     * CONSUMPTION — it is the single demand-counted entry that rides the
     * broker's one source dial and returns a codec-correct passthrough.
     */
    getStreamUrl: method(
      z.object({ streamId: z.string(), format: StreamFormatSchema }),
      z.object({ url: z.string() }),
    ),
    /**
     * Shared codec-targeted stream API — see Task #184. THE single public
     * stream-acquisition surface for programmatic consumers: single-dial
     * (rides the broker's one source pull) and passthrough-correct
     * (`videoCodec:'auto'` → `-c copy`, never a needless re-encode).
     * Resolution order: source-select → HW transcode → libx264/libx265.
     */
    getStreamWithCodec: method(GetStreamWithCodecInputSchema, RtpSourceSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    releaseStreamWithCodec: method(
      z.object({ pipelineKey: z.string() }),
      z.object({ released: z.boolean(), refcount: z.number().int().nonnegative() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * THE ffmpeg primitive. Acquire an encoded stream matching a structured
     * encode plan; the broker builds the argv through the ONE builder
     * (`@camstack/types` `ffmpeg/invocation.ts`), resolves decode hardware from
     * the DECODER ADDON's per-node ranking, and returns a dialable RTSP url.
     *
     * **Refcounted and deduplicated on EXACT match.** Two requesters whose
     * requests produce the same `egressTranscodeSharingKey` receive the SAME
     * `pipelineKey` and the same child process. Nearly-identical requests are
     * NOT merged.
     *
     * **The handle is immutable.** There is deliberately no `reconfigure`
     * method and this one never accepts a `pipelineKey` alongside encode
     * parameters: a consumer whose requirements change releases and
     * re-acquires. A mutable shared handle is exactly what made Alexa's old
     * `derived:alexa-<id>` stream a co-tenant hazard — one consumer's
     * downgrade dragged every other consumer down with it.
     *
     * Placement: unpinned, `classifyCapRoute` serves this hub-in-process
     * (Priority 1). A caller that wants the transcode elsewhere passes
     * `nodePin(nodeId)` and a `hostname` it can dial.
     */
    acquireEgressTranscode: method(EgressTranscodeRequestSchema, EgressTranscodeSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
    /** Drop one reference. The child dies when the last holder releases. */
    releaseEgressTranscode: method(
      z.object({ pipelineKey: z.string() }),
      z.object({ released: z.boolean(), refcount: z.number().int().nonnegative() }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * ── Decoded audio-chunk plane (Phase 5 / D9) ──────────────────────
     *
     * The serialisable replacement for the live-object `IStreamBroker.
     * onDecodedAudioChunk` callback path. Unlike the video frame plane,
     * audio chunks are tiny (a ~500ms PCM window is a few KB) so they ship
     * their bytes INLINE over tRPC — no shared-memory ring. A consumer:
     *
     *   1. `subscribeAudioChunks({ brokerId, tag })` — the broker registers
     *      a per-subscription bounded FIFO queue and returns a
     *      `subscriptionId`.
     *   2. polls `pullAudioChunks({ subscriptionId, maxCount })` — drains
     *      `DecodedAudioChunk[]` in arrival order (FIFO, no latest-wins
     *      drop: an audio gap is audible / breaks an analysis window). The
     *      queue is generously sized; it only drops its oldest chunk if a
     *      truly stalled consumer lets it overflow.
     *   3. `unsubscribeAudioChunks({ subscriptionId })` on teardown.
     */
    subscribeAudioChunks: method(
      SubscribeAudioChunksInputSchema,
      SubscribeAudioChunksResultSchema,
      { kind: 'mutation' },
    ),
    pullAudioChunks: method(
      z.object({
        subscriptionId: z.string(),
        maxCount: z.number().int().positive().default(8),
      }),
      z.array(DecodedAudioChunkSchema).readonly(),
    ),
    unsubscribeAudioChunks: method(
      z.object({ subscriptionId: z.string() }),
      z.object({ released: z.boolean() }),
      { kind: 'mutation' },
    ),
    setPreBufferDuration: method(
      z.object({ brokerId: z.string(), seconds: z.number().min(0).max(30) }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
    getPreBufferInfo: method(
      z.object({ brokerId: z.string() }),
      z.object({ configuredSec: z.number(), bufferedMs: z.number(), packetCount: z.number() }),
    ),
    getRtspPort: method(z.void(), z.number()),
    /**
     * Enumeration surface — backs the admin RTSP-export picker and
     * `pickPreferredRtspEntry`. Lists every per-broker restream entry. NOT a
     * consumption API: programmatic readers use {@link getStreamWithCodec}.
     */
    getAllRtspEntries: method(
      z.object({ hostname: z.string().optional() }),
      z.array(RtspRestreamEntrySchema).readonly(),
    ),
    /**
     * LEGACY / observability. Resolves one broker's restream entry. Prefer
     * {@link getStreamWithCodec} for programmatic CONSUMPTION so the read is
     * demand-counted and rides the single source dial.
     */
    getRtspEntry: method(
      z.object({ brokerId: z.string(), hostname: z.string().optional() }),
      RtspRestreamEntrySchema.nullable(),
    ),
    regenerateRtspToken: method(z.object({ brokerId: z.string() }), z.string().nullable(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    setRtspEnabled: method(z.object({ brokerId: z.string(), enabled: z.boolean() }), z.void(), {
      kind: 'mutation',
      auth: 'admin',
    }),
    isRtspEnabled: method(z.object({ brokerId: z.string() }), z.boolean()),
    /**
     * ── Per-device audio-plane policy (D83) ───────────────────────────
     *
     * The BROKER-side mute: while `muted`, this node distributes none of
     * the device's audio, on any plane it serves — live (WebRTC / encoded
     * subscribers) AND recording (the RTSP restreamer the recorder pulls,
     * which additionally serves the video-only SDP so the recorder's ffmpeg
     * never declares an audio stream it will not receive).
     *
     * Keyed by `deviceId`, not `brokerId`: every one of a camera's streams
     * carries the same microphone, and a per-stream answer would let main
     * and sub disagree about whether the camera is silent.
     *
     * The state lives in the broker's existing `DeviceOverride` blob — no
     * new store — and the mute is applied to a fresh broker at creation, so
     * a restart, a re-dial or a catalog republish never un-mutes a camera.
     */
    getDeviceAudioMute: method(
      z.object({ deviceId: z.number().int() }),
      z.object({
        muted: z.boolean(),
        /**
         * How many live non-derived brokers currently hold the mute. Purely
         * diagnostic: `muted` is the policy and is authoritative on its own
         * (it applies to brokers that do not exist yet), while this says
         * whether anything is presently being silenced.
         */
        appliedBrokers: z.number().int().nonnegative(),
      }),
    ),
    setDeviceAudioMute: method(
      z.object({ deviceId: z.number().int(), muted: z.boolean() }),
      z.object({ muted: z.boolean(), appliedBrokers: z.number().int().nonnegative() }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  events: {
    onCamStreamDemand: event(
      z.object({
        deviceId: z.number().int().nonnegative(),
        camStreamId: z.string(),
        profile: CamProfileSchema,
      }),
    ),
    onCamStreamIdle: event(
      z.object({
        deviceId: z.number().int().nonnegative(),
        camStreamId: z.string(),
      }),
    ),
    onRequestStreamSourceRefresh: event(
      z.object({
        deviceId: z.number().int().nonnegative(),
        camStreamId: z.string(),
        brokerId: z.string(),
      }),
    ),
  },
} as const satisfies CapabilityDefinition

export type IStreamBrokerProvider = InferProvider<typeof streamBrokerCapability>

export { RtspRestreamEntrySchema }

/**
 * The generated stream-broker client, as an addon sees it through `ctx.api`.
 *
 * Exists for the same reason as {@link SettingsStoreClient}: a caller that
 * hand-writes its own narrow interface over this cap keeps compiling after a
 * method is renamed or removed, and finds out at RUNTIME with a 404. That is
 * exactly what happened to the Alexa exporter — it declared
 * `getProfileSlotsForDevice`, the cap replaced it with `listAllProfileSlots`,
 * the build stayed green, and every Alexa stream went black for weeks.
 *
 * Type against this, never against a local shape.
 */
export type StreamBrokerClient = import('../generated/addon-api.js').AddonApi['streamBroker']
