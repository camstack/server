import type {
  BrokerConsumerAttribution,
  BrokerEncodedClient,
  BrokerStats,
  BrokerStatus,
  DecodedAudioChunk,
  EncodedPacket,
  IScopedLogger,
  IStreamBroker,
  StreamSource,
  StreamSourceType,
  Unsubscribe,
} from '@camstack/types'

interface EncodedSubscriberEntry {
  readonly id: string
  readonly channel: 'annexb' | 'rtp'
  attribution: BrokerConsumerAttribution
  readonly subscribedAt: number
  packetsDelivered: number
}

const UNKNOWN_ATTRIBUTION: BrokerConsumerAttribution = { kind: 'unknown' }

import { absorbSignal, holdIsLive, NO_HOLD, type WakeHold } from './wake-hold.js'
import type { AudioSubscribeOptions, SubscribeAudioChunksResult } from '@camstack/types'
import { errMsg, G711_SCALE_CORRECTION_DB, maskUrlCredentials } from '@camstack/types'
import {
  type ChildCostClaimHandle,
  type ChildCostRegistry,
  NO_COST_CLAIM,
} from '@camstack/types/node'
import { CH_RTP } from '../log-channels.js'
import { capPreRollRequestMs, type PrebufferConfig, prebufferRetentionMs } from '../prebuffer.js'
import {
  type PreRollBudget,
  type PreRollMark,
  preRollBudgetBytes,
  RTP_RING_MAX_BYTES,
  selectPreRollStart,
} from '../pre-roll.js'
import { RtmpReader } from '../rtmp/rtmp-reader.js'
import { parseAudioSpecificConfig } from '../rtsp/audio/aac-config.js'
import { g711TrackFor } from '../rtsp/audio/g711-silence.js'
import type { AudioCodec } from '../rtsp/audio-rtp-decoder.js'
import { AudioRtpDecoder, G711_SAMPLE_RATE } from '../rtsp/audio-rtp-decoder.js'
import { deviceIdFromBrokerId } from '../rtsp/broker-device-id.js'
import { FfmpegSourceReader } from '../rtsp/ffmpeg-source-reader.js'
import { buildFfmpegSourceReaderArgs } from '../rtsp/ffmpeg-source-reader-args.js'
import { Rfc4571Reader } from '../rtsp/rfc4571-reader.js'
import type { DepacketizedNal, RtpPacketClass } from '../rtsp/rtp-depacketizer.js'
import { classifyRtpPacket, RtpDepacketizer } from '../rtsp/rtp-depacketizer.js'
import { RtpAccessUnitTracker } from '../rtsp/rtp-access-unit-tracker.js'
import type { AssembledAccessUnit } from './access-unit-assembler.js'
import { AccessUnitAssembler } from './access-unit-assembler.js'
import { NativeRtspClient } from '../rtsp/rtsp-client.js'
import {
  DEFAULT_PRIME_BURST_BOUND,
  type PrimeBurstBound,
  RtspRestreamer,
} from '../rtsp/rtsp-restreamer.js'
import { AudioChunkPlane } from './audio-chunk-plane.js'
import type { AudioCodecCapApi } from './audio-codec-proxy.js'
import { AudioCodecSession } from './audio-codec-session.js'
import { EncodedRingBuffer } from './encoded-ring-buffer'
import { backingStoreBytes, type PacketAllocator } from './owned-buffer'
import { PacketSlabPool, holdPacket, releasePackets } from './slab-pool'
import { type BrokerMemSample, reportConsumerEvent } from './broker-mem-probe'
import { alawToPcm, downsampleUlaw, mulawToPcm, pcmToMulaw } from './g711-mulaw.js'
import { isDerivedOnDemandSource, shouldDeferBrokerStart } from './lazy-dial-sources.js'
import { LAZY_URL_SENTINEL } from './sentry-plan.js'
import {
  type EncodedOpusFrame,
  encodeOpusSilenceFrame,
  OpusEncodeSession,
} from './opus-encode-session.js'
import {
  getPlaceholderFrame,
  type PlaceholderCodec,
  type PlaceholderKind,
} from './placeholder-frames.js'
import { SentryPump, type SentryProvider } from './sentry-pump.js'
import { StreamPipeServer } from './stream-pipe-server'

/**
 * RTSP reconnect backoff — CONSTANTS, and there is no operator knob.
 *
 * A "Reconnection" settings section once offered `initialReconnectDelayMs` /
 * `maxReconnectDelayMs` and described the exponential backoff below. Nothing
 * ever read either field: the backoff has always run on these two numbers, so
 * the section was a form that changed nothing. It was deleted on 2026-08-28
 * (D272) rather than wired, because the reconnect ladder is a transport
 * property the operator has no way to reason about — not a tuning surface.
 */
const INITIAL_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 30_000
/** Grace period before suspending after last consumer leaves. */
const SUSPEND_GRACE_MS = 5_000
/**
 * Grace window before an idle audio-codec decode session is torn down
 * after the last audio consumer detaches. Mirrors the suspend linger
 * pattern: a brief gap between consumers (e.g.
 * a WebRTC renegotiation or an analyzer re-subscribe) must not thrash
 * the upstream decode session create/destroy.
 */
const AUDIO_CONSUMER_LINGER_MS = 5_000
/** Timeout for push-mode sources: if no packet arrives within this window, emit error placeholder. */
const PUSH_STALL_TIMEOUT_MS = 15_000
/** Work-dropping branches on the packet path report at most this often. */
const DROP_REPORT_INTERVAL_MS = 30_000

export class StreamBroker implements IStreamBroker {
  readonly deviceId: string
  /**
   * Numeric device id parsed once from `deviceId` (`101/native` → 101), for
   * `tags.deviceId`. Every log line about a device carries it: "why is 102
   * worse than 101?" is the question every media-gap investigation starts from,
   * and a line without the tag cannot be grouped to answer it.
   */
  private readonly numericDeviceId: number | undefined
  /**
   * Where this broker records the ffmpeg ingest it spawns, so the stream-broker
   * addon reports its OWN per-camera cost through `load-contribution` instead
   * of leaving an observer to join a pid against a camera. Null until the
   * manager injects it; a broker without one still streams, and its ffmpeg is
   * simply unclaimed in the node's process snapshot.
   */
  private costRegistry: ChildCostRegistry | null = null

  private _status: BrokerStatus = 'idle'
  private source: StreamSource | undefined
  /**
   * Manager-supplied resolver that derives the current `StreamSource`
   * from the live cam-stream registry. When set, every dial attempt
   * goes through it so a re-publish (e.g. Reolink updating an
   * `rfc4571` URL after the lib's TCP server idle-tore-down and
   * rebound) is observed transparently — the closure re-resolves a
   * fresh URL on every dial. `null` for tests and stand-alone callers;
   * falls back to the source passed to `start()`.
   */
  private sourceProvider: (() => StreamSource | null) | null = null
  /**
   * Manager-supplied notifier that asks the publishing addon to
   * refresh its loopback transport (e.g. re-run
   * `ensureRfc4571Server`). Called when a managed-loopback dial fails
   * — the publisher republishes with a fresh URL and the next
   * reconnect resolves it via `sourceProvider`. `null` when the
   * broker has no manager attached (tests).
   */
  private requestSourceRefresh: (() => void) | null = null
  /**
   * Last time we asked the publisher to refresh the source — used to
   * dedup the refresh notify. A single connect failure fans out into
   * two events (`socket.on('error')` → onError callback AND the
   * rejected `reader.connect()` promise → .catch); without dedup the
   * publisher's `publishToBroker` runs twice in the same tick.
   * Idempotent on the publisher side (the lib's shared pool catches
   * the second one as `awaiting in-flight create`), but the noise
   * isn't useful. 500 ms is wider than the worst-case fan-out delay.
   */
  private lastRefreshRequestAt = 0
  /** When {@link kickReconnect} last acted, for its own throttle. */
  private lastKickAt = 0
  /** Detected or configured codec — persists across reconnects */
  private detectedCodec: string | undefined
  private readonly audioCodecApi: AudioCodecCapApi | null
  private readonly logger: IScopedLogger | undefined
  private readonly startedAt: number = Date.now()

  /**
   * How many times `start()` has actually dialed. `> 0` at dial time means the
   * next connection is a RESTART, which is what `onSourceRestart` announces.
   */
  private dialCount = 0
  private readonly sourceRestartObservers = new Set<(reason: string) => void>()
  private nativeClient: NativeRtspClient | null = null
  private rfc4571Reader: Rfc4571Reader | null = null
  private rtmpReader: RtmpReader | null = null
  /** Active "ffmpeg parser" ingress reader when `source.ffmpegParser` is set. */
  private ffmpegSourceReader: FfmpegSourceReader | null = null
  /**
   * Where the ffmpeg-parser ingress reads the node's pinned ffmpeg — the
   * manager's LIVE config, asked at each dial rather than copied at creation,
   * so a broker created while a re-resolve was in flight still sees its result.
   * `null` — the ingress REFUSES by name; there is no PATH default (D540).
   */
  private ffmpegBinaryPathSource: () => string | null = () => null
  private rtpDepacketizer: RtpDepacketizer | null = null
  private audioRtpDecoder: AudioRtpDecoder | null = null
  private audioCodecSession: AudioCodecSession | null = null
  /**
   * Live Opus egress encoder — lazily created when a WebRTC session negotiates
   * Opus (`opusConsumerCount > 0`). Encodes the SAME decoded PCM that feeds the
   * PCMU path into 48 kHz Opus access units, emitted as `codec:'opus'`
   * EncodedPackets ALONGSIDE the untouched PCMU packets (strictly additive — the
   * PCMU fan-out stays byte-identical for fallback sessions). Idled when the
   * last Opus consumer detaches. In-process (audio-codec cap / node-av), no
   * ffmpeg. See {@link feedOpusEncoder}.
   */
  private opusEncodeSession: OpusEncodeSession | null = null
  /** Number of attached WebRTC sessions that negotiated Opus (demand gate). */
  private opusConsumerCount = 0
  /**
   * Pending occupancy-linger teardown of {@link audioCodecSession} after
   * the last audio consumer detached. Cancelled when a consumer returns
   * within {@link AUDIO_CONSUMER_LINGER_MS}. See {@link reconcileAudioConsumer}.
   */
  private audioConsumerLingerTimer: ReturnType<typeof setTimeout> | undefined
  private audioRtpSeen = 0
  /** Detected audio codec from RTSP DESCRIBE (e.g. 'PCMU', 'PCMA'). */
  private audioCodec: string | null = null
  /**
   * Full audio track snapshot from the SDP — surfaced in `BrokerStats.audio`
   * so the UI overview / audio-analyzer model picker can pre-select the
   * right model based on per-camera codec + sample rate.
   */
  private audioTrackInfo: {
    codec: string
    sampleRate: number
    channels: number
    supported: boolean
  } | null = null
  /**
   * BROKER-SIDE AUDIO MUTE (D83) — operator policy, not a stream fact.
   *
   * While true this broker distributes NO audio on any plane it serves. It is
   * applied at the three points audio ENTERS the broker (`onAudioRtp`,
   * `pushEncodedPacket`) and re-checked at the single point it LEAVES
   * (`fanOutEncoded`), so a packet already inside a decode session when the
   * mute lands cannot escape.
   *
   * Deliberately NOT cleared by `resetStreamState` / a re-dial: it is device
   * policy that outlives any one connection. `StreamBrokerManager` re-applies
   * it to every freshly created broker for the same reason.
   */
  private audioMuted = false
  /** Audio units dropped by the mute since the current dial. Surfaced in stats. */
  private audioMutedDropped = 0
  /**
   * One-shot per dial: the mute's drop is announced the FIRST time it actually
   * drops something, not once per packet. A broker created while already muted
   * has no transition to log, and a silent drop reads as "the camera has no
   * microphone" — which is the confusion this whole row exists to remove.
   */
  private audioMutedDropLogged = false
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private placeholderTimer: ReturnType<typeof setInterval> | undefined
  /**
   * The sentry pump, armed by the manager via `setPrestreamProvider`.
   * `undefined` on a broker whose manager supplied none — the pre-sentry
   * behaviour, unchanged.
   */
  private sentryPump: SentryPump | undefined
  /** The manager's hook for "real media started" — see `SentryProvider`. */
  private onRealMediaStarted: (() => void) | undefined
  /**
   * Latched once real media has been seen on this session.
   *
   * The lazy branch is re-entered on every materialize poll tick, so stopping
   * the pump is not enough on its own: the very next tick would re-open a
   * window that real bytes have already closed, and the consumer would get a
   * still picture painted over live video every second. Reset on broker stop
   * and suspend, so a battery camera that goes back to sleep gets its sentry
   * again on the next wake.
   */
  private sentryWindowClosed = false
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
  /**
   * Dial rate-limiter (2026-07-23 storm fix): the earliest wall-clock at
   * which ANY caller may dial the source again. Armed on every dial ATTEMPT
   * with the current backoff window. The 30s reconnect timer was honored on
   * ITS path, but parallel dial channels (demand resume, broker recreation)
   * re-dialed instantly — an unreachable camera (105 EHOSTUNREACH) looped
   * hundreds of dials/sec, the relayed log flood ballooned hub-main to
   * 1.9 GB in 4 h and starved the HTTPS API. This gate makes the backoff a
   * BROKER-level invariant instead of a per-path courtesy.
   */
  private nextDialAllowedAt = 0
  /**
   * "First video" watchdog. Battery-cam rfc4571 sources sometimes
   * complete TCP handshake on the loopback but the lib's dedicated
   * session never delivers video bytes (camera fails to start the
   * upstream Baichuan stream after wake, or stream subscription gets
   * stuck). The user's manual workaround was to click restart on the
   * WebRTC viewer — that closed the broker, tore the lib's session
   * down, and on reopen the dedicated session attached cleanly.
   *
   * This watchdog automates that: it arms when either reader's
   * `onVideoTrack` fires (TCP up, SDP parsed) — the callback factory is
   * shared, so native RTSP arms it too — and cancels at the first
   * `onVideoRtp` callback. If it elapses without a single video RTP
   * packet (measured PER DIAL — `videoRtpSeen` is reset on every dial),
   * it destroys the reader and re-dials; for an `rfc4571` loopback source
   * it also asks the publisher for a fresh source first. Exactly what the
   * manual restart did.
   */
  private firstVideoWatchdog: ReturnType<typeof setTimeout> | undefined
  /**
   * Wall-clock timeout for the first-video watchdog. Long enough that
   * a healthy live cam comfortably emits its first IDR within the
   * window (typical: ~1-2s after rfc4571 TCP connect on PoE cams,
   * ~2-5s on battery cams that need to align stream subscription with
   * the video pipeline post-wake), but short enough that a stuck
   * dedicated session is detected before the WebRTC client gives up
   * on the offer (Chrome's default ICE-disconnect timeout is ~15s).
   */
  private static readonly FIRST_VIDEO_TIMEOUT_MS = 8_000

  /**
   * The first-video deadline for a dial that FOLLOWED a lazy materialize.
   *
   * 8 s was sized against Chrome's ~15 s ICE-disconnect: detect a stuck stream
   * before the viewer's browser gives up. That reasoning holds for a source
   * that is already open and has stalled. It is exactly wrong for a COLD open
   * behind a lazy publisher.
   *
   * Measured on the wyze bridge (devices 3838/3836, 2026-08-20): a successful
   * open costs **12.4 s** — `WyzeRfc4571Server` waits for the first keyframe
   * with a 10 s ceiling, on top of ~2 s of DTLS handshake. At 8 s the watchdog
   * tore down a connection that was two seconds from delivering, and the cost
   * of that teardown is not "try again quickly": the bridge closes its P2P
   * server 30 s after the last client, so the next dial repays the whole cold
   * open. Chrome had given up either way; the only thing the short deadline
   * changed was whether the NEXT viewer paid for it again too.
   *
   * 20 s covers the measured open with margin and still fires well inside the
   * activity watchdog's own recovery path for a connection that is genuinely
   * dead.
   */
  private static readonly LAZY_MATERIALIZE_FIRST_VIDEO_TIMEOUT_MS = 20_000

  /**
   * How long after a lazy materialize was REQUESTED a dial still counts as
   * "this one is the cold open we asked for". Past it the source is an
   * ordinary open and takes the ordinary deadline.
   */
  private static readonly MATERIALIZE_RECENT_MS = 30_000

  /**
   * Poll cadence while a lazy publisher is materializing its upstream.
   *
   * The exponential backoff is the right shape for a source that is FAILING
   * and the wrong one for a source that is being built: the publisher answers
   * in ~12 s, and 1-2-4-8-16 s means the broker learns about it at 16 — up to
   * 4 s of pure quantisation on every wyze cold open. Waiting at a flat 1 s
   * costs one cheap re-resolve per second against a bounded deadline.
   */
  private static readonly MATERIALIZE_POLL_MS = 1_000

  /**
   * Bound on the flat-poll wait. Past it the materialize is not slow, it has
   * failed, and the ordinary exponential backoff is the right answer again.
   * Sized at the measured open (12.4 s) plus room for one retry inside the
   * publisher.
   */
  private static readonly MATERIALIZE_WAIT_MS = 20_000

  /**
   * When the current lazy materialize was first requested, or `0` when none is
   * outstanding. Drives BOTH the flat poll above and the extended first-video
   * deadline — one fact, read in two places, so a materialize cannot be "in
   * progress" for the dial loop and "not happening" for the watchdog.
   */
  private materializeRequestedAt = 0

  /**
   * The hold a camera's own signal bought. See `wake-hold.ts` — a term of
   * {@link hasLiveIntent}, so the predicate's owner owns the state: putting it
   * in the manager would give two places a vote on whether to dial.
   */
  private wakeHold: WakeHold = NO_HOLD
  /** Fires when the hold lapses, so the suspend happens instead of waiting for
   *  an unrelated edge. Re-armed on every extension. */
  private wakeHoldTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * Rolling source-RTP activity watchdog. Distinct from the first-video
   * watchdog: this one ARMS at DIAL time (so a connection that opens the
   * loopback TCP but never delivers media is still detected) and RESETS on
   * every RTP packet thereafter. If no packet arrives within
   * `RTP_ACTIVITY_TIMEOUT_MS`, the reader is torn down and reconnected.
   *
   * Two failure modes, one timer:
   *  - a rebooted-Reolink rfc4571 source that opens the socket but never
   *    starts its dedicated session (arm-at-dial catches this in ~8s); and
   *  - a Wi-Fi-attached IP camera that silently stalls mid-stream under
   *    packet loss — ICE/DTLS stay healthy and `rtpPacketsSent` keeps
   *    advancing (replaying the GOP cache), but source-side time progresses
   *    only in tiny bursts, so the viewer freezes with no recovery.
   *
   * The watchdog kills+restarts the reader when no data arrives within
   * `RTP_ACTIVITY_TIMEOUT_MS` (8s — same as `FIRST_VIDEO_TIMEOUT_MS`).
   *
   * Reused across the native RTSP and RFC 4571 readers — both flow through
   * `buildRtpStreamCallbacks` and call `kickRtpActivityWatchdog()` per
   * packet, and both arm it at dial. push-rtp arms it on its first pushed
   * packet; push / RTMP (provider-driven) sources sit out because they have
   * no native reader to tear down.
   */
  private rtpActivitySweep: ReturnType<typeof setInterval> | undefined
  /**
   * Wall-clock ms of the most recent source-RTP packet, or `0` while the
   * watchdog is disarmed.
   *
   * This is the whole of the per-packet work. The watchdog used to re-arm a
   * `setTimeout` on EVERY packet (`clearTimeout` + `setTimeout`), and the
   * comment here called that "negligible". It was not: at 30 cameras and
   * 80-100 packets/s each, that is ~3 000 `Timeout` objects allocated,
   * inserted into and removed from libuv's timer heap every second, in the
   * process that already spends 68% of a full core in GC. Writing a number
   * allocates nothing; one sweep timer per broker replaces ~100 arms/s.
   */
  private lastRtpActivityAt = 0
  /** Number of times the activity watchdog fired in this broker's lifetime
   *  (incremented on expiry, NOT on arm/cancel). Surfaced via the test
   *  seam so unit tests can assert recovery behavior without inspecting
   *  private timer handles. */
  private rtpActivityWatchdogFiredCount = 0
  /** Activity watchdog timeout. Matches `FIRST_VIDEO_TIMEOUT_MS` so a
   *  healthy live source comfortably stays ahead (PCMU audio is 50pps,
   *  H.264 video is 30fps → 80pps minimum on a working stream) while a
   *  real stall is detected before Chrome's ~15s ICE-disconnect timer
   *  has any chance to fire. */
  /** How many times a resume re-asks the registry before it stops asking. */
  private static readonly RESUME_RETRY_MAX = 5
  /** Spacing of those asks — long enough for a catalog reconcile to land. */
  private static readonly RESUME_RETRY_DELAY_MS = 3_000
  private resumeRetryTimer: NodeJS.Timeout | undefined
  private resumeRetryAttempts = 0
  private resumeRetryExhausted = false
  /** One line per suspension when packets arrive with no watchdog armed. */
  private suspendedActivityNoted = false
  private static readonly RTP_ACTIVITY_TIMEOUT_MS = 8_000
  /**
   * How often the single sweep timer checks {@link lastRtpActivityAt}.
   *
   * The stall is still declared at exactly `RTP_ACTIVITY_TIMEOUT_MS` of
   * silence; this only bounds how late that verdict can be observed (one
   * sweep, so ≤ 9s worst case rather than exactly 8s). That slack is far
   * inside Chrome's ~15s ICE-disconnect timer, which is the deadline the
   * timeout was chosen against.
   */
  private static readonly RTP_ACTIVITY_SWEEP_MS = 1_000
  /** A source counts as ingesting when its last video packet is younger than this. */
  private static readonly INGESTING_WITHIN_MS = 10_000
  private manualStop = false
  private stopping = false

  private readonly pipeServer: StreamPipeServer
  private readonly rtspRestreamer: import('../rtsp/rtsp-restreamer.js').RtspRestreamer
  private readonly preBuffer: EncodedRingBuffer
  private readonly encodedCallbacks = new Map<
    (packet: EncodedPacket) => void,
    EncodedSubscriberEntry
  >()
  /**
   * Source-RTP video subscribers — receive raw on-wire RTP bytes
   * (no depacketization). Used by the WebRTC server's H.265 path to
   * feed a packet-level repacketizer. See `onVideoRtp`.
   */
  private readonly rtpVideoCallbacks = new Map<(rtpData: Buffer) => void, EncodedSubscriberEntry>()
  private subscriberIdCounter = 0
  /**
   * Codec parameter sets harvested from the camera's SDP (a=fmtp
   * sprop-vps / sprop-sps / sprop-pps). Cameras that ONLY put their
   * VPS/SPS/PPS in the SDP (Reolink high-profile streams, IP-cam
   * vendors that strip param sets from the wire) leave WebRTC sessions
   * without an HEVC decoder configuration — Chrome receives every IDR
   * but VideoToolbox never initialises.
   *
   * We capture them in `onVideoTrack` and replay them as a synthetic
   * EncodedPacket the moment a new encoded-data subscriber registers
   * AND on every keyframe whose NAL stream is missing them. This way
   * `session.ts` populates `lastVps/Sps/Pps` regardless of how the
   * camera ships its parameter sets.
   */
  private sdpParameterSets: ReadonlyArray<Buffer> | null = null
  /**
   * Per-device streaming debug flag. Gates verbose info-level logs
   * around RTP/encoded subscriber lifecycle, SDP param set replay,
   * and codec parameter handling. Toggled via the device override
   * `streamingDebug` field. Off by default — production logs stay
   * quiet unless an operator explicitly enables debug for one device.
   */
  private streamingDebug = false
  /**
   * Decoded audio-chunk plane (Phase 5 / D9) — the poll-based, tRPC-reachable
   * replacement for the live-object `onDecodedAudioChunk` callback path.
   * Holds the per-subscription FIFO chunk queues. Assigned in the constructor
   * so it gets a scoped logger child.
   */
  private readonly audioChunkPlane: AudioChunkPlane
  /** Timer for push-mode stall detection. */
  private pushStallTimer: ReturnType<typeof setTimeout> | undefined
  /**
   * Whether the prebuffer holds this stream dialed with zero real subscribers.
   *
   * **Starts OFF, and only {@link setPrebuffer} ever writes it.** It used to
   * start `true`, which is how this broker came to hold a state the settings
   * screen contradicted: `stream-broker-manager` resolved the same question as
   * `enabled ?? false` and showed OFF, while an unconfigured broker was already
   * warm. Neither was "the current configuration" — there were two — and that
   * is the defect D381 retires. Unconfigured now means off; the manager applies
   * the resolved prebuffer to every broker it creates, so the honest default
   * (ON for a mains camera's warm profile) arrives from the one place that
   * decides it.
   */
  private _preBufferEnabled = false
  /**
   * The open prebuffer hold, or `null` when the prebuffer is off.
   *
   * A real object rather than a flag plus a synthetic row, so "who is keeping
   * camera 102 warm?" is answered by something that EXISTS: it has an id, it
   * has a start time, and `hasDemand()` consults it the way it consults every
   * other holder.
   */
  private prebufferHold: { readonly id: string; readonly since: number } | null = null
  /**
   * Seconds of AnnexB video retained SPECIFICALLY so a notification clip can be
   * cut around a past instant (`renderPreBufferClip`). 0 = no clip retention.
   *
   * Deliberately NOT demand: retention is opportunistic and must never keep a
   * camera dialed on its own — it fills only while some real consumer (usually
   * the detection pipeline that produced the event) already has the stream up.
   * A camera nobody is watching yields a shorter clip, which is honest; keeping
   * every stream alive for a clip that may never be asked for is not.
   */
  private clipRetentionSec = 0
  /** The clip ring — allocated only while `clipRetentionSec > 0`. */
  private clipBuffer: EncodedRingBuffer | null = null
  /** Timer for delayed suspend after last consumer leaves. */
  private suspendTimer: ReturnType<typeof setTimeout> | undefined
  /** True while the stream is suspended (ffmpeg killed, no RTSP connection). */
  private _suspended = false
  /**
   * The LAZY url this broker was started from, remembered for as long as it
   * lives.
   *
   * It exists because the published url and the broker's state disagree for
   * about sixteen seconds after a suspend. The catalog still carries the real
   * `tcp://…` socket — the publisher only republishes the sentinel when its
   * sleep poll notices the camera has gone — while the broker has already torn
   * that socket down. In that window `resolveCurrentSource()` truthfully
   * answers with a socket nobody can dial.
   *
   * That cost device 106 its sentry on 2026-09-16: the window re-opened
   * (which `suspend()` does deliberately, for a consumer that never left) with
   * the real url, `planPrestream` refused it `not-lazy`, and the refusal is
   * terminal — the operator's client sat dark for ten seconds and gave up six
   * before the sentinel came back.
   *
   * NOT cleared when `start()` is later called with a materialized url: that
   * happens on every wake, and clearing it there is the bug again. A broker
   * genuinely reconfigured onto a permanent mains source keeps a stale value,
   * which costs nothing — `sentryEligible` (battery + declared signals) is
   * the authority on whether a camera gets a sentry at all, and it is asked
   * first, in the manager.
   */
  private lazySourceUrl: string | undefined
  /**
   * Optional demand-transition observer. Fires `true` the instant demand first
   * appears (a consumer attaches) and `false` when the broker actually suspends
   * after the idle grace — aligned with the broker's own reader spawn/teardown
   * so an EXTERNAL producer (the derived-stream feeder) can mirror the on-demand
   * lifecycle without pinning its source while nobody watches. At most one.
   */
  private demandObserver: ((active: boolean) => void) | null = null
  /** Latched demand state for {@link demandObserver} edge-detection. */
  private demandActive = false

  /** Counter for video RTP packets — drives the milestone diagnostic
   *  log alongside `audioRtpSeen`, so a wake-up cycle that brings audio
   *  back but never video is observable from the structured logs. */
  private videoRtpSeen = 0

  /**
   * What the source RTP packet being handled CARRIES (keyframe / parameter-set
   * content, read from its payload headers by `classifyRtpPacket`) — the flags
   * `captureRtpForPreBuffer` reads. Per packet, not per completed NAL: every
   * fragment of a fragmented IDR carries them, and the ring marks one keyframe
   * AU for the lot.
   */
  private _lastNalKeyframe = false
  private _lastNalParamSet = false
  /**
   * Whether the Annex-B plane (NAL reassembly + access-unit assembly →
   * `EncodedPacket`) is being BUILT for this stream. False while nothing
   * consumes it: the source-RTP path then classifies each packet and copies
   * nothing. Armed at the next keyframe access unit once a consumer attaches
   * (`needsAnnexBPlane`), so the first packet it emits is decodable.
   */
  private annexBPlaneActive = false

  /**
   * Source-RTP pre-buffer: a ring of raw source RTP packets trimmed to
   * begin at the most recent keyframe access unit — i.e. the current GOP so
   * far. A late-joining WebRTC viewer on the repacketizer path replays this
   * on connect (`getRtpPreBuffer`) so its decoder initialises immediately
   * from a keyframe instead of waiting for the camera's next IDR (which can
   * be many seconds away on a long-GOP 4K stream). This is the RTP-level
   * counterpart to the AnnexB `preBuffer`, kept separately because the
   * repacketizer path needs the original RTP wire packets, not AnnexB.
   * Only populated for RTP sources (`isRtpSource()`).
   */
  private rtpRing: Buffer[] = []
  /**
   * Where this stream's source packets are cut (`slab-pool.ts`, D868): the
   * readers copy into the pool's slabs, the ring and the restreamer's keyframe
   * cache hold/release them, and a slab no ring holds is recycled.
   */
  private readonly packetPool = new PacketSlabPool()
  private readonly packetAllocator: PacketAllocator = (src, start, end) =>
    this.packetPool.copy(src, start, end)
  private rtpRingCurAuStart = 0
  private rtpRingPrevMarker = true
  private rtpRingHasKeyframe = false
  private rtpRingBytes = 0
  /**
   * Index + 90 kHz timestamp of the first packet of every keyframe AU still in
   * {@link rtpRing}, oldest first.
   *
   * Exists because pre-roll needs to start a burst at an EARLIER keyframe and
   * nothing in an RTP header says "keyframe" — keyframe-ness is known only at
   * capture time, from the depacketizer flags. Without these marks the only
   * reachable start is "the whole ring", which is a mid-GOP cut the moment the
   * ring holds more than one GOP: undecodable, and exactly what D57 refuses.
   *
   * Indices are rebased on every head trim, so the last entry is always the
   * newest keyframe AU — the current GOP's start, which is what
   * {@link getRtpPreBuffer} keeps handing WebRTC and the plain RTSP join.
   */
  private rtpRingKeyframeMarks: Array<{ index: number; ts: number }> = []
  /**
   * Media time (ms) of history this broker RETAINS and will hand to a consumer
   * that declared it attaches after the edge it needs to see.
   *
   * ONE number (D381), derived from the ONE prebuffer configuration by
   * `prebufferRetentionMs` and pushed by the manager through
   * {@link setPrebuffer}. It replaced `detectionPreRollMs` and
   * `recordingPreRollMs`, which were two configurations of the same retention
   * that the operator had to keep consistent by hand — and a third,
   * `preBufferSec`, which sized an Annex-B ring that is never fed for an RTP
   * source and therefore retained nothing at all on every warm camera in the
   * fleet.
   *
   * A consumer never sets this and never asks for a number wider than it: a
   * request is capped at read time by {@link capPreRollRequestMs}.
   */
  private prebufferMs = 0

  /**
   * Effective join-burst bound for this stream's RTSP restream — the cluster
   * default, or this camera stream's override. Applies to the RESTREAM
   * consumers only; the WebRTC bootstrap reads the ring directly and is
   * deliberately exempt (see the constructor and D57).
   */
  private joinBurstBound: PrimeBurstBound = DEFAULT_PRIME_BURST_BOUND
  /** Per-message throttle state for {@link reportThrottled}. */
  private readonly throttledReports = new Map<string, { lastMs: number; count: number }>()
  /** Last budget printed by {@link reportPreRollClamp}, so the line fires on a
   *  TRANSITION rather than on every keyframe. */
  private preRollClampLogged = false

  /** Stream stats tracking */
  private totalBytes = 0
  private bytesInWindow = 0
  private packetsInWindow = 0
  private windowStartMs = Date.now()
  private lastKeyframeMs = 0
  private idrIntervalMs = 0
  private bitrateKbps = 0
  private encodedInputFps = 0
  private packetCount = 0
  /**
   * Timestamp of the most recent video packet observed on this broker.
   * Used by the manager-level watchdog to drive `stream.online` /
   * `stream.offline` transitions. `0` until the first packet arrives.
   */
  private lastPacketAt = 0

  /** Default pre-buffer duration in seconds */
  static readonly DEFAULT_PRE_BUFFER_SEC = 10
  /** Maximum allowed pre-buffer duration in seconds */
  static readonly MAX_PRE_BUFFER_SEC = 30
  /**
   * Ceiling for the notification clip ring, in seconds.
   *
   * Separate from `MAX_PRE_BUFFER_SEC` because the two rings live on different
   * cost axes: the pre-buffer holds the MAIN stream (the fleet's 22 warm
   * streams sum 107 Mbps), the clip ring holds the cheapest profile (the same
   * 22 sum 4.3 Mbps — a 25:1 ratio). A minute of the cheap one costs ~32 MB
   * across the whole fleet; a minute of the main one would cost ~800 MB.
   */
  static readonly MAX_CLIP_RETENTION_SEC = 120
  /**
   * What ONE camera's clip ring may cost, whatever profile ends up armed.
   *
   * The same 16 MiB the RTP pre-roll ring already uses, deliberately — one
   * number for "how much native memory one stream's history may hold". It
   * holds a full minute of any realistic cheap stream (up to ~2.2 Mbps) and
   * clamps a rule that arms the MAIN stream to about twelve seconds instead of
   * letting it take 82 MB. A window cut by this says so
   * (`isClampedByBytes`).
   */
  static readonly CLIP_RING_MAX_BYTES = 16 * 1024 * 1024
  constructor(deviceId: string, logger?: IScopedLogger, audioCodecApi?: AudioCodecCapApi | null) {
    this.deviceId = deviceId
    this.numericDeviceId = deviceIdFromBrokerId(deviceId)
    this.audioCodecApi = audioCodecApi ?? null
    this.logger = logger
    this.pipeServer = new StreamPipeServer(logger?.child('pipe-server'))
    this.rtspRestreamer = new RtspRestreamer(deviceId)
    if (logger) this.rtspRestreamer.setLogger(logger.child('rtsp'))
    // Prime joining restream clients (esp. the pull-decoder loopback) with the
    // current-GOP source-RTP burst so they fast-forward to the live edge
    // instead of starting a GOP behind — the fix for the seconds-behind
    // detection/motion overlays. Same ring the WebRTC repacketizer path uses.
    this.rtspRestreamer.setRtpPreBufferSupplier(() => this.getRtpPreBuffer())
    // The D57 join-burst bound, pulled per join so a settings edit applies to
    // the next joiner without touching this long-lived broker. It gates the
    // RESTREAM consumer only — `getRtpPreBuffer` above is shared with the
    // WebRTC bootstrap (`webrtc/broker-webrtc-server.ts` → `rtpBootstrap`) and
    // must stay unbounded, which
    // `__tests__/webrtc-join-burst-exemption.spec.ts` pins.
    this.rtspRestreamer.setPrimeBoundSupplier(() => this.joinBurstBound)
    // Motion-start Stage 2: the window a DETECTION dial may take instead of the
    // current GOP. Separate from the supplier above precisely so this history
    // cannot reach a WebRTC viewer or a re-clocking RTSP leg.
    // ONE window for every declared intent (D381). It used to be two, keyed by
    // intent, because the operator configured detection and recording
    // separately; there is one configuration now, so a recorder and a detector
    // joining the same broker are served the same retained seconds and the
    // restreamer no longer has to decide which of two numbers a session gets.
    this.rtspRestreamer.setPreRollSupplier(() => {
      // The slice is a THUNK: the restreamer reads `preRollMs` on every serve to
      // name the retained window in its log, and cuts the ring only when a
      // session that declared an intent is actually joining.
      return {
        // The AMOUNT comes from the session (D382): the broker answers what it
        // was asked for, capped at what it kept, and no longer decides on the
        // asker's behalf by being handed no question.
        packets: (requestedMs: number) => this.getRtpPreRollBuffer(requestedMs),
        preRollMs: this.prebufferMs,
      }
    })
    this.preBuffer = new EncodedRingBuffer(StreamBroker.DEFAULT_PRE_BUFFER_SEC)
    this.audioChunkPlane = new AudioChunkPlane(logger?.child('audio-chunk-plane'), () =>
      // A reaped subscription is one less reader, and an audio subscription is
      // DEMAND — re-evaluate or the broker keeps dialling the source for a
      // consumer that is gone (D461).
      this.checkDemand(),
    )

    // Wire client-count callbacks so demand tracking reacts to RTSP/pipe changes
    this.rtspRestreamer.onSessionCountChanged(() => this.checkDemand())
    this.pipeServer.onClientCountChanged(() => this.checkDemand())
  }

  get status(): BrokerStatus {
    return this._status
  }

  /**
   * Ms epoch of the most recent video packet observed by the broker.
   * `0` if none yet. Read by the manager-level health watchdog.
   */
  getLastPacketAt(): number {
    return this.lastPacketAt
  }

  /**
   * What this broker holds, for the `[broker-mem]` probe (`broker-mem-probe.ts`).
   * Ring sizes are the rings' own counters (backing-store bytes), so this is
   * O(sessions + subscribers) and allocates only the result.
   */
  getMemSample(now: number): BrokerMemSample {
    const encodedByKind: Record<string, number> = {}
    for (const entry of this.encodedCallbacks.values()) {
      encodedByKind[entry.attribution.kind] = (encodedByKind[entry.attribution.kind] ?? 0) + 1
    }
    for (const entry of this.rtpVideoCallbacks.values()) {
      encodedByKind[entry.attribution.kind] = (encodedByKind[entry.attribution.kind] ?? 0) + 1
    }
    const rtsp = this.rtspRestreamer.getMemProbe()
    return {
      deviceId: this.numericDeviceId,
      brokerId: this.deviceId,
      ingesting:
        this.lastPacketAt > 0 && now - this.lastPacketAt < StreamBroker.INGESTING_WITHIN_MS,
      preBufferBytes: this.preBuffer.getBufferedBytes(),
      clipBytes: this.clipBuffer?.getBufferedBytes() ?? 0,
      rtpRingBytes: this.rtpRingBytes,
      keyframeCacheBytes: rtsp.keyframeCacheBytes,
      rtspSessions: rtsp.sessions,
      writeQueueSumBytes: rtsp.writeQueueSumBytes,
      writeQueueMaxBytes: rtsp.writeQueueMaxBytes,
      encodedByKind,
      audioSubscribers: this.audioChunkPlane.subscriberCount,
      pipeClients: this.pipeServer.getClientCount(),
      annexBPlaneActive: this.annexBPlaneActive,
    }
  }

  /**
   * Whether a LAZY publisher is being built right now.
   *
   * A consumer deciding whether it is worth waiting for this source needs to
   * tell "cold and idle" from "waking up": the first cannot be waited for at
   * all (the dial is the demand that starts the wake), the second can.
   * `getFirstVideoWatchdogStatus` carries the same number and is a TEST SEAM —
   * this is the production read.
   */
  isMaterializing(): boolean {
    return this.materializeRequestedAt > 0
  }

  /** Source type of the active stream (rtsp/push/rtmp/placeholder/error). */
  getActiveSourceType(): string {
    return this.source?.type ?? 'unknown'
  }

  /**
   * Diagnostic snapshot of the active source for log-meta enrichment.
   * Always returns a stable shape so log readers can rely on the keys
   * being present whenever a connect / read error is reported. URL is
   * masked so credentials never reach disk.
   */
  private sourceMetaForLog(): {
    brokerId: string
    sourceType: string
    url: string
  } {
    const src = this.source
    const url =
      src && src.type !== 'placeholder' && src.type !== 'push' && src.type !== 'push-rtp'
        ? maskUrlCredentials(src.url ?? '')
        : ''
    return {
      brokerId: this.deviceId,
      sourceType: src?.type ?? 'unknown',
      url,
    }
  }

  /**
   * Inject where the "ffmpeg parser" ingress ({@link startFfmpegSourceReader})
   * reads the node's pinned ffmpeg: the manager's live config, asked per dial.
   */
  setFfmpegBinaryPathSource(source: () => string | null): void {
    this.ffmpegBinaryPathSource = source
  }

  /** The pinned ffmpeg this broker would spawn right now (`null` = none). */
  getFfmpegBinaryPath(): string | null {
    return this.ffmpegBinaryPathSource()
  }

  /** Told when the ingress was refused for want of the pinned ffmpeg. */
  private ffmpegMissingHandler: (() => void) | null = null

  /** Wire the manager's re-resolve request. */
  setFfmpegMissingHandler(handler: () => void): void {
    this.ffmpegMissingHandler = handler
  }

  /**
   * Inject the addon's child-cost registry. Injected rather than constructed
   * here because the registry is per-ADDON-PROCESS (it is what the addon's
   * `load-contribution` provider reads) while a broker is per-camera.
   */
  setCostRegistry(registry: ChildCostRegistry): void {
    this.costRegistry = registry
  }

  /**
   * Claim one ffmpeg ingest generation for this camera, or nothing when the
   * camera cannot be named. Never a placeholder device id: an unnamed
   * per-camera claim is indistinguishable from a shared cost and would quietly
   * turn one camera's ffmpeg into everybody's.
   */
  private claimIngestCost(pid: number | undefined): ChildCostClaimHandle {
    const deviceId = this.numericDeviceId
    if (this.costRegistry === null || deviceId === undefined) return NO_COST_CLAIM
    return this.costRegistry.claim({
      role: 'streaming',
      deviceId,
      unit: this.deviceId,
      pid,
    })
  }

  /**
   * Inject a manager-owned closure that derives the current
   * `StreamSource` from the live cam-stream registry. Every dial
   * attempt (initial start, scheduled reconnect, demand-driven resume)
   * routes through this resolver so URL changes from a re-publish are
   * picked up transparently. Calling without a provider keeps the
   * legacy "use the source from start()" behaviour for tests.
   */
  setSourceProvider(provider: () => StreamSource | null): void {
    this.sourceProvider = provider
  }

  /**
   * Inject a manager-owned notifier the broker fires when a
   * managed-loopback source (`rfc4571`) dial fails. The notifier
   * asks the publishing addon to republish with a fresh transport;
   * the next reconnect picks it up via `sourceProvider`.
   */
  setRequestSourceRefresh(notify: () => void): void {
    this.requestSourceRefresh = notify
  }

  /**
   * Arm the SENTRY — the fill for the window between "someone asked for this
   * camera" and "the camera is awake".
   *
   * Manager-owned, because everything the fill needs is the manager's: the
   * camera's probed geometry and codec (`planPrestream`), its last cached
   * snapshot, its name, and the ffmpeg binary. The broker contributes the one
   * thing it owns — WHEN the window is open — and nothing else.
   *
   * A broker with no provider behaves exactly as it did before the sentry
   * existed: the lazy branch asks the publisher to materialize and the consumer
   * sees black, which is the outcome every refusal falls back to.
   */
  setPrestreamProvider(provider: SentryProvider): void {
    this.onRealMediaStarted = provider.onRealMediaStarted
    this.sentryPump = new SentryPump({
      prepare: provider.prepare,
      emit: (frame) => {
        const now = Date.now()
        this.pushEncodedPacket({
          type: 'video',
          data: frame.annexB,
          pts: now,
          dts: now,
          // A single-frame encode is always a keyframe, and `-g 1` +
          // repeat-headers make it a complete access unit, so a consumer that
          // attaches mid-sentry decodes within one tick.
          keyframe: true,
          codec: frame.codec,
          // THE flag the containment reads. A sentry frame is a still
          // picture this broker drew: it must not enter the clip buffer or
          // event media.
          isPlaceholder: true,
        })
      },
      ...(this.logger ? { logger: this.logger } : {}),
      ...(this.numericDeviceId === undefined ? {} : { deviceId: this.numericDeviceId }),
    })
  }

  /**
   * Fire `requestSourceRefresh` at most once per ~500 ms. The
   * dial-failure path fans into onError + reader.connect().catch; we
   * only want one round-trip to the publisher per real failure.
   */
  private notifySourceRefresh(): void {
    if (!this.requestSourceRefresh) return
    const now = Date.now()
    if (now - this.lastRefreshRequestAt < 500) return
    this.lastRefreshRequestAt = now
    this.requestSourceRefresh()
  }

  /**
   * Manager-side kick: the publisher just re-published with a fresh
   * URL after a connect-fail / refresh round-trip (e.g. Reolink
   * battery cam finished waking and bound a new rfc4571 port). Cancel
   * any pending exponential-backoff retry, reset the backoff so the
   * next failure starts from `INITIAL_RECONNECT_DELAY_MS` again, and
   * arm a fast retry. No-op when the broker isn't currently waiting
   * for a reconnect (already dialing, idle, or stopped).
   *
   * Without this, on a battery-cam wake-up the broker stays on its
   * exponential schedule (1s → 2s → 4s …) even though the publisher
   * has already published a working URL — wasting up to a full
   * `MAX_RECONNECT_DELAY_MS` window dialing stale loopback ports.
   */
  /**
   * Tear down a HEALTHY reader and dial the source again.
   *
   * `kickReconnect` cannot do this — it only shortens a backoff that is
   * already running, and returns immediately when the broker is happily
   * streaming (`if (!this.reconnectTimer) return`). This is for the opposite
   * situation: the connection is fine and its CONTENT is wrong.
   *
   * That is not hypothetical. Measured live on Hikvision 104 (2026-08-07):
   * muting the camera's microphone restarts its encoder, the RTSP connection
   * drops, and the broker reconnects — *while the mute is still being applied
   * channel by channel*. It negotiates a video-only SDP, the camera comes back
   * with its audio mux restored, and nothing ever asks again: the reader is
   * healthy, `hasDemand()` is satisfied, `scheduleReconnect` never fires. The
   * camera had sound and the hub could not hear it for forty minutes, and the
   * only cure was disabling the whole device long enough for the catalog
   * reconcile to release the brokers.
   *
   * So the writer that restarts an encoder must say so, and this is what it
   * calls. Deliberately routed through `scheduleReconnect` → `start()` so the
   * dial-storm rate limit added on 2026-07-23 still governs the retry.
   */
  redial(reason: string): void {
    if (this.manualStop || this.stopping || !this.source) return
    if (!this.hasLiveIntent()) return
    this.logger?.info('source redial — the camera changed under a live reader', {
      meta: { reason, status: this._status },
    })
    this._status = 'connecting'
    this.destroyNativeClient()
    this.destroyRfc4571Reader()
    this.destroyRtmpReader()
    this.destroyFfmpegSourceReader()
    // A forced redial is an intent, not a failure — start the backoff over so
    // it dials at once rather than inheriting a stale exponential delay.
    this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
    this.nextDialAllowedAt = 0
    this.scheduleReconnect()
  }

  kickReconnect(): void {
    if (this.manualStop || this.stopping || !this.source) return
    if (!this.hasLiveIntent()) return
    if (!this.reconnectTimer) return
    // Throttle. The kick is now fired on EVERY re-publish rather than only on a
    // changed URL, and a publisher in a republish loop would otherwise reset
    // the backoff on every one of them — turning a bounded retreat into a dial
    // at the floor delay, for ever. One kick per floor delay is all the
    // information a republish can carry.
    const nowMs = Date.now()
    if (nowMs - this.lastKickAt < INITIAL_RECONNECT_DELAY_MS) return
    this.lastKickAt = nowMs
    clearTimeout(this.reconnectTimer)
    this.reconnectTimer = undefined
    this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
    this.nextDialAllowedAt = 0
    this.lastRefreshRequestAt = 0
    this.logger?.info('reconnect kicked — publisher refreshed source')
    this.scheduleReconnect()
  }

  /**
   * Ask again for a source the registry did not have yet — bounded.
   *
   * Demand exists and nothing can be dialled, so waiting for the NEXT demand
   * edge is waiting for something that may never come: the consumer is already
   * attached. The retry is what turns "nothing happened" back into either a
   * stream or a stated failure, and the bound is what stops a camera that
   * genuinely publishes nothing from spinning for the life of the process.
   */
  private scheduleResumeRetry(): void {
    if (this.resumeRetryTimer !== undefined) return
    if (this.resumeRetryAttempts >= StreamBroker.RESUME_RETRY_MAX) {
      if (!this.resumeRetryExhausted) {
        this.resumeRetryExhausted = true
        this.logger?.warn(
          'demand is waiting and this broker still has no source — giving up until something changes',
          {
            meta: {
              brokerId: this.deviceId,
              attempts: this.resumeRetryAttempts,
              ...(this.numericDeviceId === null ? {} : { deviceId: this.numericDeviceId }),
            },
          },
        )
      }
      return
    }
    this.resumeRetryAttempts += 1
    this.logger?.warn('demand detected but no source could be resolved — retrying', {
      ...(this.numericDeviceId === null ? {} : { tags: { deviceId: this.numericDeviceId } }),
      meta: {
        brokerId: this.deviceId,
        attempt: this.resumeRetryAttempts,
        ofMax: StreamBroker.RESUME_RETRY_MAX,
      },
    })
    this.resumeRetryTimer = setTimeout(() => {
      this.resumeRetryTimer = undefined
      if (this.manualStop || this.stopping || !this._suspended) return
      if (!this.hasLiveIntent()) return
      this.checkDemand()
    }, StreamBroker.RESUME_RETRY_DELAY_MS)
    this.resumeRetryTimer.unref?.()
  }

  /** A resume that SUCCEEDED clears the episode, counter included. */
  private cancelResumeRetry(): void {
    if (this.resumeRetryTimer !== undefined) {
      clearTimeout(this.resumeRetryTimer)
      this.resumeRetryTimer = undefined
    }
    this.resumeRetryAttempts = 0
    this.resumeRetryExhausted = false
  }

  /**
   * Resolve the source to use for the next dial attempt. Prefers the
   * manager-supplied resolver — re-derives from the cam-stream
   * registry, so a re-publish that updated the URL is honoured on the
   * very next dial. Falls back to the cached `this.source` (set at
   * `start()` time) when no resolver is wired.
   */
  private resolveCurrentSource(): StreamSource | null {
    if (this.sourceProvider) {
      const fresh = this.sourceProvider()
      if (fresh) {
        this.source = fresh
        this.noteLazyUrl(fresh.url)
        return fresh
      }
    }
    return this.source ?? null
  }

  /**
   * Remember a lazy url ANY time one is seen — see {@link lazySourceUrl}.
   *
   * Here and not only in `start()` because a broker that has never dialled is a
   * real and common state: a battery camera nobody has asked for yet, with a
   * sentry consumer attached, has a recipe and no socket. Learning it from
   * the dial alone would leave exactly that broker unable to describe itself.
   */
  private noteLazyUrl(url: string | undefined): void {
    if (typeof url === 'string' && url.startsWith(LAZY_URL_SENTINEL)) {
      this.lazySourceUrl = url
    }
  }

  async start(source: StreamSource): Promise<void> {
    this.source = source
    // Remember the recipe, not just the socket. See `lazySourceUrl`.
    this.noteLazyUrl(source.url)
    this.manualStop = false
    this.stopping = false

    // Seed `detectedCodec` from the source's declared `videoCodec`
    // so consumers (notably `BrokerWebrtcServer.createSession`) see
    // the right codec immediately — without waiting for the reader to
    // parse the SDP track. The race used to manifest on `adaptive`
    // selection: a fresh session created against a still-suspended /
    // connecting rfc4571 broker fell back to `'h264'` from
    // `getStats().codec === undefined`, negotiated an H.264 SDP, then
    // received H.265 packets once the reader got going → black
    // viewport. The SDP `onVideoTrack` callback overwrites this later
    // if it disagrees with the publisher's declaration.
    if (source.videoCodec) {
      this.detectedCodec = source.videoCodec
    }

    this.logger?.info('Broker starting', {
      meta: {
        sourceType: source.type,
        ...(source.type !== 'placeholder' ? { url: maskUrlCredentials(source.url) } : {}),
        ...(this.detectedCodec ? { codec: this.detectedCodec } : {}),
      },
    })

    await this.pipeServer.start()
    this.logger?.debug('Pipe server started', {
      meta: { url: this.pipeServer.getUrl() },
    })

    // Strict on-demand semantics — pull lazy-dial AND derived push. The list
    // and the reasoning live in `lazy-dial-sources.ts`, because keeping it
    // inline here is how `flv` stayed eager for months and dialed a sleeping
    // battery camera ~120 times a day, and how a derived low with no feeder
    // latched `streaming` + `lastPacketAt=0` and notified stream-offline on
    // every restart (NC accepts only `stale-timeout`).
    //
    // `checkDemand()` resumes the source the moment a subscriber
    // arrives or the pre-buffer flips on (both feed `hasDemand`).
    if (shouldDeferBrokerStart(source) && !this.hasLiveIntent()) {
      this._suspended = true
      this._status = 'idle'
      this.logger?.info(
        isDerivedOnDemandSource(source)
          ? 'Broker registered idle — no demand, derived feeder deferred'
          : 'Broker registered idle — no demand, source dial deferred',
      )
      return
    }

    // Dial rate-limit: if the backoff window from the last failed attempt is
    // still open, DON'T dial — arm (or keep) the reconnect timer for the
    // remainder instead. This is the single choke point that makes reconnect
    // backoff hold for EVERY dial channel (start/resume/timer), not just the
    // timer's own path (2026-07-23 unreachable-camera dial storm).
    const dialWaitMs = this.nextDialAllowedAt - Date.now()
    if (dialWaitMs > 0) {
      this._status = 'connecting'
      if (!this.reconnectTimer) {
        this.logger?.info('dial rate-limited — deferring to backoff window', {
          meta: { waitMs: dialWaitMs },
        })
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = undefined
          if (this.manualStop) return
          const src = this.resolveCurrentSource()
          if (src) void this.start(src)
        }, dialWaitMs)
      }
      return
    }
    // Arm the gate for THIS attempt: no re-dial before the current backoff
    // window elapses, whatever path asks. Success resets it (with the delay).
    this.nextDialAllowedAt = Date.now() + this.reconnectDelayMs

    this._status = 'connecting'

    // A SECOND (or later) dial on a broker that already delivered is a source
    // RESTART, and everything attached to it is holding state derived from the
    // connection that just ended — a WebRTC session's werift sender offset most
    // of all. Announce it here, at the one place every dial channel converges,
    // rather than at each reader's first packet: subscribers re-arm on the next
    // packet whenever it arrives, and a dial that never delivers must still be
    // visible as a restart that stalled.
    if (this.dialCount > 0) this.notifySourceRestart()
    this.dialCount += 1

    // Reset the per-dial video-RTP counter. It gates the first-video watchdog
    // (`if (videoRtpSeen > 0) return`) and drives the milestone log. Before this
    // it was a broker-LIFETIME counter, reset only inside the watchdog's own
    // fire path — so on a long-lived broker every re-dial started with
    // `videoRtpSeen > 0` left over from an earlier connection, and the
    // first-video watchdog stood down instantly (and silently) on the fresh
    // dial. Zeroing it here makes the watchdog measure THIS connection.
    this.videoRtpSeen = 0

    // "ffmpeg parser" ingress: the operator chose to route this RTSP/RTMP
    // source THROUGH ffmpeg (`-c copy`) instead of a native TS client. Takes
    // precedence over the per-`source.type` native dispatch below.
    if (source.ffmpegParser) {
      this._status = 'connecting'
      this.startFfmpegSourceReader(source)
      return
    }

    if (source.type === 'rtsp') {
      this.startRtspReader(source)
    } else if (source.type === 'rfc4571') {
      this.startRfc4571Reader(source)
    } else if (source.type === 'placeholder') {
      this.startPlaceholderReader(source)
    } else if (source.type === 'push' || source.type === 'push-rtp') {
      // Push modes: the camera provider addon delivers data via
      // pushEncodedPacket() (and pushVideoRtp() for `push-rtp`).
      // Codec already seeded from `source.videoCodec` at the top of
      // `start()` — the push branch used to repeat that assignment;
      // it's redundant now and removed for clarity.
      this._status = 'streaming'
      this.logger?.info('Broker in push mode — waiting for data', {
        meta: { sourceType: source.type, codec: this.detectedCodec ?? null },
      })
      this.resetPushStallTimer()
    } else if (source.type === 'rtmp') {
      this.startRtmpReader(source)
    } else {
      // Unknown source type — assume external push.
      this._status = 'streaming'
    }
  }

  async stop(): Promise<void> {
    this.logger?.info('Broker stopping')
    this.stopping = true
    this.manualStop = true
    this._status = 'stopped'

    this.destroyNativeClient()
    this.destroyRtmpReader()
    this.destroyFfmpegSourceReader()
    this.stopErrorPlaceholder()
    this.cancelFirstVideoWatchdog()
    this.cancelRtpActivityWatchdog()

    if (this.placeholderTimer) {
      clearInterval(this.placeholderTimer)
      this.placeholderTimer = undefined
    }
    // Not another closing edge — leak hygiene. A stopped broker that left a
    // 1 Hz interval behind would keep pushing into a dead fanout for ever.
    this.sentryPump?.stop('broker stopped')
    this.sentryWindowClosed = false

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }

    if (this.suspendTimer) {
      clearTimeout(this.suspendTimer)
      this.suspendTimer = undefined
    }

    if (this.pushStallTimer) {
      clearTimeout(this.pushStallTimer)
      this.pushStallTimer = undefined
    }

    await this.pipeServer.stop()
    this.rtspRestreamer.destroy()
    this.preBuffer.clear()
    // Across an idle/redial gap the source re-bases its pts (RFC 3550), so
    // retained packets would stitch two epochs into one clip.
    this.clipBuffer?.clear()

    this.annexBAssembler.reset()
    this.encodedCallbacks.clear()
    this.audioChunkPlane.dispose()
    this.resetRtpPreBuffer()
    this.packetPool.dispose()
  }

  // ── Auto-suspend / resume ─────────────────────────────────────────────

  /** Whether the broker is currently suspended (idle, no RTSP connection). */
  get suspended(): boolean {
    return this._suspended
  }

  /**
   * Observe demand transitions. Fires `true` when the broker first gains demand
   * and `false` when it suspends after the idle grace. Used by the manager to
   * spawn/tear down a derived stream's transcode feeder in lock-step with the
   * broker's on-demand lifecycle. Replaces any prior observer; the returned
   * function detaches it.
   */
  onDemandChange(observer: (active: boolean) => void): () => void {
    this.demandObserver = observer
    return () => {
      if (this.demandObserver === observer) this.demandObserver = null
    }
  }

  /**
   * Observe SOURCE RESTARTS — every dial after the first.
   *
   * A `Set` rather than the single-slot `demandObserver` above because there
   * can be many live WebRTC sessions on one broker and each has its own RTP
   * mapping to re-latch. The returned function detaches one subscriber.
   *
   * Fires on the DIAL, not on the first packet: a subscriber's recovery is
   * "re-latch on the next packet, whenever it comes", and a restart that never
   * delivers must still be observable rather than silently indistinguishable
   * from a healthy stream.
   */
  onSourceRestart(observer: (reason: string) => void): () => void {
    this.sourceRestartObservers.add(observer)
    return () => {
      this.sourceRestartObservers.delete(observer)
    }
  }

  private notifySourceRestart(): void {
    if (this.sourceRestartObservers.size === 0) return
    const reason = `dial#${String(this.dialCount + 1)}`
    for (const observer of this.sourceRestartObservers) {
      try {
        observer(reason)
      } catch (err) {
        // One subscriber's failure must not stop the others recovering.
        this.logger?.warn('source-restart observer threw', {
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  // ── Broker-side audio mute (D83) ──────────────────────────────────────

  /**
   * Turn this broker's audio plane off (or back on).
   *
   * Idempotent: setting the value it already holds does nothing at all — in
   * particular it does NOT churn the RTSP sessions, so the manager can call
   * this on every broker creation and every reconcile pass without cost.
   *
   * A real transition closes the restreamer's audio-bearing pull sessions.
   * That is not incidental: the recorder pulls this restreamer with `-map 0`,
   * so its ffmpeg maps whatever the SDP declared at CONNECT time. Dropping the
   * RTP while leaving an `m=audio` in its SDP would leave it waiting on an
   * audio stream that never delivers (the mp4 muxer holds video up to
   * `max_interleave_delta`). Re-pulling is what makes the recording honestly
   * audio-less rather than audio-declared-and-starved. The recorder's
   * `SegmentWriter` respawns on exit with bounded backoff, so the cost is one
   * segment boundary per flip.
   */
  setAudioMuted(muted: boolean): void {
    if (this.audioMuted === muted) return
    this.audioMuted = muted
    this.audioMutedDropped = 0
    this.audioMutedDropLogged = false
    const closedPulls = this.rtspRestreamer.setAudioMuted(muted)
    this.logger?.info(
      muted
        ? 'audio plane MUTED broker-side — live and recording go silent'
        : 'audio plane UNMUTED broker-side — audio distribution resumes',
      {
        tags: { deviceId: this.numericDeviceId },
        meta: {
          brokerId: this.deviceId,
          audioCodec: this.audioCodec,
          hasAudioTrack: this.audioTrackInfo !== null,
          closedPulls,
        },
      },
    )
  }

  /** The broker's own audio-plane policy. `true` = distributing no audio. */
  isAudioMuted(): boolean {
    return this.audioMuted
  }

  /**
   * True when the current connection is muxing audio at all — the OBSERVED
   * half of the D83 audio-plane reconcile. Read off the SDP/track snapshot
   * rather than a packet counter so a camera that negotiated an audio track
   * and has simply been quiet does not read as a missing mux.
   */
  hasAudioTrack(): boolean {
    return this.audioTrackInfo !== null
  }

  /**
   * Account for one audio unit the mute threw away, announcing the FIRST one
   * per dial. Never per-packet: at 50 pps a line each would be its own outage.
   */
  private dropMutedAudio(where: string): void {
    this.audioMutedDropped += 1
    if (this.audioMutedDropLogged) return
    this.audioMutedDropLogged = true
    this.logger?.info('audio muted broker-side — dropping this camera’s audio plane', {
      tags: { deviceId: this.numericDeviceId },
      meta: { brokerId: this.deviceId, where, audioCodec: this.audioCodec },
    })
  }

  /**
   * Open or release the prebuffer HOLD — the session that keeps this stream
   * dialed with no real consumer attached.
   *
   * Opening it is what "prebuffer on" MEANS: there is a holder, it has a name
   * and a start time, and it appears in `listClients()` beside every other
   * holder. Re-arming an already-open hold keeps its `since`, so the operator
   * reads how long this camera has been held warm rather than how long ago the
   * settings were last re-applied.
   */
  setPreBufferEnabled(enabled: boolean): void {
    if (enabled === this._preBufferEnabled) return
    this._preBufferEnabled = enabled
    this.prebufferHold = enabled ? { id: `prebuffer:${this.deviceId}`, since: Date.now() } : null
    this.logger?.info(enabled ? 'prebuffer hold opened' : 'prebuffer hold released', {
      tags: { deviceId: this.numericDeviceId },
      meta: { brokerId: this.deviceId, retentionMs: this.prebufferMs },
    })
    this.checkDemand()
  }

  /** True when at least one consumer needs the stream alive. */
  /**
   * A signal the CAMERA reported about itself.
   *
   * Two terms must hold before anything is dialled, and they are the whole
   * safety of this feature:
   *
   *  - the caller has already checked the signal is ENABLED for this camera
   *    (the broker manager owns that setting), and
   *  - somebody is actually waiting on the sentry. Waking a camera nobody is
   *    watching is the one thing a battery camera must never do, and a signal
   *    arriving with no consumer is exactly that.
   *
   * Returns what it did, so the caller's log line can say it. A hold that is
   * merely EXTENDED does not re-dial: the camera is already up.
   */
  reportWakeSignal(
    code: string,
    holdMs: number,
    at: number,
  ): 'woke' | 'hold-extended' | 'no-consumer' {
    if (this.rtspRestreamer.getPrestreamSessionCount() === 0) return 'no-consumer'
    const wasLive = holdIsLive(this.wakeHold, at)
    const { hold, outcome } = absorbSignal({ current: this.wakeHold, now: at, holdMs })
    this.wakeHold = hold
    this.logger?.info('wake signal from the camera', {
      tags: { deviceId: this.numericDeviceId },
      meta: {
        brokerId: this.deviceId,
        code,
        outcome,
        signals: hold.signals,
        untilMs: Math.max(0, hold.until - at),
        runMs: hold.runStartedAt > 0 ? at - hold.runStartedAt : 0,
      },
    })
    this.armWakeHoldTimer(at)
    if (outcome === 'quarantined') return 'no-consumer'
    if (wasLive) return 'hold-extended'
    // The hold is a term of `hasLiveIntent`, so asking demand again is what
    // actually dials — the same path a play takes.
    this.checkDemand()
    return 'woke'
  }

  /**
   * Look at the hold when it lapses, so the camera actually goes back to sleep
   * instead of waiting for an unrelated edge to notice.
   */
  private armWakeHoldTimer(now: number): void {
    if (this.wakeHoldTimer) clearTimeout(this.wakeHoldTimer)
    const delay = this.wakeHold.until - now
    if (delay <= 0) return
    this.wakeHoldTimer = setTimeout(() => {
      this.wakeHoldTimer = undefined
      this.logger?.info('wake hold lapsed — back to the sentry picture', {
        tags: { deviceId: this.numericDeviceId },
        meta: {
          brokerId: this.deviceId,
          signals: this.wakeHold.signals,
          runMs: this.wakeHold.runStartedAt > 0 ? Date.now() - this.wakeHold.runStartedAt : 0,
        },
      })
      this.checkDemand()
    }, delay)
    this.wakeHoldTimer.unref?.()
  }

  /**
   * Anything that must be FED, sentry sessions included.
   *
   * The only consumer of this is the sentry pump: it says "somebody is
   * watching, keep the picture going", and says nothing about whether the
   * camera may be dialled. {@link hasLiveIntent} answers that, and it is the
   * one every dial path asks.
   */
  private hasAnyConsumer(): boolean {
    if (this.hasLiveIntent()) return true
    if (this.sentryHolds > 0) return true
    return this.rtspRestreamer.getPrestreamSessionCount() > 0
  }

  /**
   * Somebody is DESCRIBING a sentry and has no session yet.
   *
   * The RTSP dispatch reads the SDP before `addSession` runs, so a window that
   * waits for the session is too late: the consumer is handed an empty SDP and
   * quits. Measured against the live hub (2026-09-15 14:47): the window opened
   * on the attach and closed 42 ms later having emitted zero frames, because
   * ffmpeg had already given up.
   *
   * This is the sentry counterpart of `BrokerWarmUp` and its exact opposite
   * in effect: the warm-up subscribes demand, which DIALS; this opens the
   * picture, which never does. A battery camera is not touched.
   */
  openPrestreamWindow(): () => void {
    this.sentryHolds += 1
    this.checkDemand()
    let released = false
    return () => {
      if (released) return
      released = true
      this.sentryHolds = Math.max(0, this.sentryHolds - 1)
      this.checkDemand()
    }
  }

  /** DESCRIBE-window sentry holds: sessions that do not exist yet. */
  private sentryHolds = 0

  /**
   * Consumers that may DIAL. Every term of the former `hasDemand`, with the
   * RTSP session count filtered to exclude sentry dials, plus the wake hold.
   *
   * For a broker with no sentry session attached this is term-for-term what
   * `hasDemand` was, which is why every existing camera, consumer and test
   * behaves identically.
   */
  private hasLiveIntent(): boolean {
    if (this.encodedCallbacks.size > 0) return true
    if (this.rtpVideoCallbacks.size > 0) return true
    // Audio analysis subscribers count as demand. Without this, a
    // camera with audio classification enabled but no decoded-video
    // consumer (motion-wasm off + motion phase idle) suspends the
    // broker between motion bursts; audio chunks stop flowing and
    // `device.state.audioMetrics` stays frozen — the operator sees a
    // stale "X seconds ago" chip in the UI even though the camera is
    // online and audible. Mirrors video demand semantics.
    if (this.audioChunkPlane.subscriberCount > 0) return true
    // SENTRY sessions are fed but are NOT intent. A continuous-pull client
    // holds one open for ever, and counting it here would keep a battery
    // camera awake for ever — the exact thing the battery is for (D173). The
    // restreamer counts them separately for this reason and no other.
    if (this.rtspRestreamer.getLiveIntentSessionCount() > 0) return true
    if (this.pipeServer.getClientCount() > 0) return true
    // `_preBufferEnabled=true` keeps the stream warm even with zero
    // active subscribers. Earlier the gate also required
    // `preBuffer.getDuration() > 0` — meaning the broker could only
    // STAY warm AFTER it had already received its first packets. On
    // `suspend()` the pre-buffer gets cleared (intentional, to drop
    // stale GOPs across the idle gap), so a momentarily empty buffer
    // immediately voided demand again and the broker collapsed back
    // to idle on the very next `checkDemand` poll. The natural read
    // of the flag is "keep the stream alive permanently", so drop the
    // duration gate: a camera that wants always-on stays always-on,
    // and a battery camera never has the hold opened in the first place.
    if (this.prebufferHold !== null) return true
    // A signal the CAMERA reported about itself. The only thing besides a real
    // consumer that may dial a sleeping camera, bounded by its own ceiling and
    // quarantine (`wake-hold.ts`).
    if (holdIsLive(this.wakeHold, Date.now())) return true
    return false
  }

  /**
   * Does a consumer want this stream right now (a viewer, a recording, a
   * detection decode, a camera-reported wake hold)? Sentry sessions and idle
   * prestream do not count. The stream-health sweep reads it to tell a battery
   * camera that slept unasked from one that failed to wake for somebody (D883).
   */
  hasLiveDemand(): boolean {
    return this.hasLiveIntent()
  }

  /**
   * True when at least one consumer needs DECODED audio. The audio-specific
   * subset of {@link hasDemand} — deliberately excludes video-only
   * consumers so a video-only viewer never spins up the AAC/Opus decode
   * chain. `encodedCallbacks` covers WebRTC (its G.711
   * egress needs decoded PCM); `audioChunkPlane` covers the analyzer.
   */
  private hasAudioConsumer(): boolean {
    return this.encodedCallbacks.size > 0 || this.audioChunkPlane.subscriberCount > 0
  }

  /**
   * Register a WebRTC session that negotiated Opus. Turns on the live Opus
   * egress encoder (lazily, on the first decoded PCM chunk). Additive — the
   * PCMU fan-out is untouched, so PCMU-fallback sessions are unaffected.
   */
  acquireOpusEgress(): void {
    this.opusConsumerCount++
  }

  /**
   * Deregister an Opus session. Idles (but keeps) the encoder when the last
   * Opus consumer detaches — the next {@link acquireOpusEgress} + PCM push
   * re-creates the upstream encode session, exactly like the decode client.
   */
  releaseOpusEgress(): void {
    if (this.opusConsumerCount > 0) this.opusConsumerCount--
    if (this.opusConsumerCount === 0 && this.opusEncodeSession) {
      void this.opusEncodeSession.idle().catch((err) => {
        this.logger?.warn('opus-egress: idle failed', {
          meta: { error: errMsg(err) },
        })
      })
    }
  }

  /**
   * Encode ONE canonical 20 ms Opus silence packet for a session's sentry
   * A/V-sync padding (Opus has no fixed silence byte). Returns `null` when the
   * audio-codec cap is unavailable. See {@link encodeOpusSilenceFrame}.
   */
  async makeOpusSilenceFrame(channels: number): Promise<Buffer | null> {
    if (!this.audioCodecApi) return null
    return encodeOpusSilenceFrame(this.audioCodecApi, { channels })
  }

  /**
   * Feed one decoded PCM chunk (f32le, the decode contract) into the live Opus
   * egress encoder when an Opus consumer is attached. Lazily creates the encode
   * session sized to the chunk. No-op without Opus demand or the cap.
   */
  private feedOpusEncoder(chunk: DecodedAudioChunk): void {
    if (this.opusConsumerCount === 0) return
    const api = this.audioCodecApi
    if (!api) return
    if (!this.opusEncodeSession) {
      const targetChannels = Math.min(2, Math.max(1, chunk.channels))
      this.opusEncodeSession = new OpusEncodeSession(
        api,
        {
          sourceSampleRate: chunk.sampleRate,
          sourceChannels: chunk.channels,
          sourceFormat: 'f32le',
          targetSampleRate: 48000,
          targetChannels,
          bitrateKbps: targetChannels >= 2 ? 64 : 48,
          tag: `broker:${this.deviceId}:opus-egress`,
        },
        (frame) => this.emitOpusEncoded(frame),
        this.logger ?? undefined,
      )
    }
    this.opusEncodeSession.pushPcm(chunk)
  }

  /** Fan out one encoded Opus access unit as a `codec:'opus'` EncodedPacket. */
  private emitOpusEncoded(frame: EncodedOpusFrame): void {
    if (this.encodedCallbacks.size === 0) return
    const packet: EncodedPacket = {
      type: 'audio',
      data: frame.data,
      pts: frame.ptsMs,
      dts: frame.ptsMs,
      keyframe: false,
      codec: 'opus',
    }
    this.fanOutEncoded(packet)
  }

  /**
   * Demand-gate the audio-codec decode session lifecycle. Called from
   * every consumer add/remove edge (via {@link checkDemand}). While an
   * audio consumer exists, cancel any pending linger-close. When
   * consumers drop to zero, arm a short linger timer that tears the
   * upstream decode session + 40ms poll loop down (via
   * `AudioCodecSession.idle`) so a momentary gap between consumers
   * doesn't thrash create/destroy. The next gated packet re-arms the
   * session lazily through `ensureSession()`. No-op when no session is
   * armed (native PCMU/PCMA cameras never build one).
   */
  private reconcileAudioConsumer(): void {
    if (!this.audioCodecSession) return
    if (this.hasAudioConsumer()) {
      if (this.audioConsumerLingerTimer) {
        clearTimeout(this.audioConsumerLingerTimer)
        this.audioConsumerLingerTimer = undefined
      }
      return
    }
    if (this.audioConsumerLingerTimer) return
    this.audioConsumerLingerTimer = setTimeout(() => {
      this.audioConsumerLingerTimer = undefined
      if (this.hasAudioConsumer()) return
      const session = this.audioCodecSession
      if (!session) return
      void session.idle().catch((err) => {
        this.logger?.warn('audio-codec: idle teardown failed', {
          meta: { error: errMsg(err) },
        })
      })
    }, AUDIO_CONSUMER_LINGER_MS)
    if (typeof this.audioConsumerLingerTimer.unref === 'function') {
      this.audioConsumerLingerTimer.unref()
    }
  }

  /**
   * Check demand and schedule suspend/resume. Called after every subscriber
   * add/remove and after pre-buffer enable/disable.
   */
  private checkDemand(): void {
    if (this.manualStop || this.stopping) return

    // Reconcile the audio-codec decode-session lifecycle on the same
    // consumer add/remove edges that drive suspend/resume.
    this.reconcileAudioConsumer()

    if (this.hasLiveIntent()) {
      // Signal the demand edge (false→true) before resuming so an external
      // producer (derived feeder) starts spawning immediately. Idempotent —
      // only the transition fires; repeated demanded checks are no-ops.
      if (!this.demandActive) {
        this.demandActive = true
        this.demandObserver?.(true)
      }
      // Cancel pending suspend
      if (this.suspendTimer) {
        clearTimeout(this.suspendTimer)
        this.suspendTimer = undefined
      }
      // Resume if suspended — re-resolve the source from the manager
      // so a re-publish that landed during the idle window (e.g.
      // Reolink rebound the rfc4571 server on a different port) is
      // honoured on the very first dial of the resume.
      //
      // No proactive `notifySourceRefresh` here: forcing a publisher
      // re-publish on every resume would call `ensureApi` ->
      // `buildVideoStreamOptions` -> `ensureRfc4571Server` on the
      // provider side, which wakes battery cameras even when the
      // existing URL is still valid. The dial-failure path
      // (`startRfc4571Reader`'s `.catch`) already triggers a refresh
      // when the cached URL goes stale; that's the only case where
      // we actually need the publisher to wake the cam.
      if (this._suspended) {
        const fresh = this.resolveCurrentSource()
        if (fresh) {
          this.cancelResumeRetry()
          this._suspended = false
          this.logger?.info('demand detected — resuming stream')
          this.start(fresh).catch((err) => {
            this.logger?.error('resume failed', {
              meta: { error: errMsg(err) },
            })
            this._suspended = true
            this._status = 'idle'
          })
        } else {
          // The branch that used to be absent. `resolveCurrentSource` answers
          // null whenever the cam-stream registry has no entry for the pair —
          // a catalog reconcile, a publisher respawn window — and the broker
          // then stayed suspended FOREVER with a live session attached, having
          // decided nothing and said nothing. From outside that is
          // indistinguishable from a quiet camera.
          this.scheduleResumeRetry()
        }
      }
    } else if (!this._suspended) {
      // Schedule suspend after grace period
      if (!this.suspendTimer) {
        this.suspendTimer = setTimeout(() => {
          this.suspendTimer = undefined
          if (!this.hasLiveIntent() && !this.manualStop && !this.stopping) {
            this.suspend()
          }
        }, SUSPEND_GRACE_MS)
      }
    }
    // The sentry pump follows CONSUMERS, not intent — a session that is fed
    // but does not dial still has to be fed. It is the one reader of
    // `hasAnyConsumer`, and it runs whether the camera is up or asleep: the
    // pump stops itself on the first real packet, which is the only edge that
    // means "there is something better to show".
    this.sentryWanted = this.hasAnyConsumer() && !this.hasLiveIntent()
    this.reconcilePrestreamWindow()
  }

  /**
   * Open or close the sentry window to match {@link sentryWanted}.
   *
   * This is the half that was missing. `sentryWanted` has been computed
   * correctly since the feature shipped, but the only thing that ever STARTED
   * the pump was the lazy branch of `start()` — a DIAL, which needs live
   * intent, which a sentry session does not have by construction. So the
   * window opened only when something else had already woken the camera, and
   * `suspend()` closed it for good.
   *
   * Driving it from the consumer edge is what the contract already claimed:
   * the pump follows CONSUMERS, and it neither dials nor wakes nor holds
   * anything open (D173). `start()` is idempotent, so being called on every
   * demand check costs one encode per window and no more.
   */
  private reconcilePrestreamWindow(): void {
    if (!this.sentryPump) return
    if (this.sentryWanted && !this.sentryWindowClosed) {
      // The LAZY url first, and it is not a fallback — it is the more accurate
      // answer here. This branch runs only when nothing holds live intent,
      // which is exactly the state in which the source is a recipe to be
      // dialled rather than a socket that is open. The published url can still
      // name the socket the broker has just closed, and `planPrestream` then
      // refuses `not-lazy` on a camera that is, right now, as lazy as it gets.
      const url = this.lazySourceUrl ?? this.resolveCurrentSource()?.url ?? this.source?.url
      // No source yet means nothing to describe the camera with — the plan
      // gates on the url, so asking without one would only earn a refusal.
      if (url !== undefined) this.sentryPump.start(url)
      return
    }
    if (!this.sentryWanted) this.sentryPump.stop('no sentry consumer')
  }

  /**
   * Whether a sentry picture should be flowing right now: somebody is
   * watching and the camera is not up. Read by the pump.
   */
  private sentryWanted = false

  /** Whether the picture should be flowing — the pump's one question. */
  wantsPrestream(): boolean {
    return this.sentryWanted
  }

  /** Suspend the stream: kill ffmpeg/native client, clear buffers, go idle. Source is preserved for resume. */
  private suspend(): void {
    if (this._suspended) return
    this._suspended = true
    this._status = 'idle'

    // Signal the demand edge (true→false) aligned with the broker's own reader
    // teardown, so an external producer (derived feeder) stops here rather than
    // the instant the last consumer left — matching the idle-grace semantics.
    if (this.demandActive) {
      this.demandActive = false
      this.demandObserver?.(false)
    }

    this.logger?.info('no demand — suspending stream')

    this.destroyNativeClient()
    this.destroyRtmpReader()
    this.destroyFfmpegSourceReader()
    // Strict on-demand: drop the rfc4571 reader too. Holding the
    // loopback TCP connection keeps the lib's upstream Baichuan
    // socket pinned even with zero subscribers — exactly what the
    // user-visible "stream open only on demand" rule rejects. The
    // next demand triggers `start()` → `resolveCurrentSource()` →
    // dial against the (potentially refreshed) loopback URL.
    this.destroyRfc4571Reader()
    // Activity watchdog has no purpose when the broker is intentionally
    // idle — let `start()` re-arm it on the next packet.
    this.cancelRtpActivityWatchdog()

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = undefined
    }
    if (this.placeholderTimer) {
      clearInterval(this.placeholderTimer)
      this.placeholderTimer = undefined
    }
    // Suspension means nobody is watching, so there is no window left to fill.
    // Stop first, so the re-open below starts a FRESH window: the camera has
    // just gone back to sleep and the picture it left is the one to show.
    this.sentryPump?.stop('broker suspended')
    // A `warm()` call lived here, to prepare the NEXT window while the camera
    // was still awake. It never ran: `suspend()` does not fire on this fleet —
    // measured 2026-09-14, ZERO "no demand — suspending stream" lines in an
    // hour, on any camera — so the fix was inert and the wake still paid the
    // full encode. Removed rather than left in place: a leftover that
    // describes the right design reads as verification.
    //
    // The cost is now handled where it is actually spent, in
    // `preparePrestreamFrame`: the last picture is served immediately and the
    // new one encodes behind it.
    this.sentryWindowClosed = false
    // A consumer that never left is still owed a picture. Before this, the
    // suspend was terminal for it: the pump was stopped and only a dial could
    // restart one, and a sentry session never dials. Measured on device 106
    // (2026-09-15): the camera slept again 4 s after the first keyframe and the
    // attached VLC saw black from then on.
    this.reconcilePrestreamWindow()

    this.preBuffer.clear()
    // Across an idle/redial gap the source re-bases its pts (RFC 3550), so
    // retained packets would stitch two epochs into one clip.
    this.clipBuffer?.clear()
    this.annexBAssembler.reset()
    this.rtspRestreamer.resetStreamState()

    // Reset stats
    this.totalBytes = 0
    this.bytesInWindow = 0
    this.packetsInWindow = 0
    this.packetCount = 0
    this.bitrateKbps = 0
    this.encodedInputFps = 0
  }

  /**
   * Declare push-source audio metadata. Push providers (Reolink Baichuan and
   * the like) call this BEFORE pushing the first audio EncodedPacket so
   * the broker can wire the audio-codec capability and emit decoded PCM
   * to audio subscribers + transcode to G.711 µ-law for WebRTC.
   *
   * Pass `null` to retract — broker tears down the audio decode session.
   */
  pushAudioInfo(info: import('@camstack/types').PushAudioInfo | null): void {
    if (this.stopping) return

    if (info === null) {
      if (this.audioCodecSession) {
        const session = this.audioCodecSession
        this.audioCodecSession = null
        void session.close().catch((err) => {
          this.logger?.warn('audio-codec: push session close failed', {
            meta: { error: errMsg(err) },
          })
        })
      }
      this.audioTrackInfo = null
      return
    }

    const codec = info.codec.toLowerCase()
    this.audioCodec = codec.toUpperCase()
    this.audioTrackInfo = {
      codec: this.audioCodec,
      sampleRate: info.sampleRate,
      channels: info.channels,
      supported: true,
    }

    // Native G.711 — no codec cap needed; pushEncodedPacket fans out
    // directly to encodedCallbacks.
    if (codec === 'pcmu' || codec === 'pcma') {
      this.logger?.info('push-audio: native codec — no decoder cap required', {
        meta: { codec, sampleRate: info.sampleRate, channels: info.channels },
      })
      return
    }

    if (!this.audioCodecApi) {
      this.logger?.warn('push-audio: codec needs audio-codec cap but cap is unavailable', {
        meta: { codec, sampleRate: info.sampleRate, channels: info.channels },
      })
      return
    }

    const cfg = this.buildAudioCodecSessionConfigFromPush(info)
    if (!cfg) {
      this.logger?.info('push-audio: codec not handled by cap — audio skipped', {
        meta: { codec, sampleRate: info.sampleRate, channels: info.channels },
      })
      return
    }

    if (this.audioCodecSession) {
      const prior = this.audioCodecSession
      this.audioCodecSession = null
      void prior.close().catch((err) => {
        this.logger?.debug('audio-codec: prior session close failed', {
          meta: { error: errMsg(err) },
        })
      })
    }

    this.audioCodecSession = new AudioCodecSession(
      this.audioCodecApi,
      cfg,
      this.buildAudioCodecEmitCallback(),
      this.logger?.child('audio-codec'),
      () => this.encodedCallbacks.size > 0,
    )
    this.logger?.info('push-audio: decode session armed', {
      meta: {
        codec: cfg.codec,
        sourceSampleRate: cfg.sourceSampleRate,
        sourceChannels: cfg.sourceChannels,
      },
    })
  }

  pushEncodedPacket(packet: EncodedPacket): void {
    if (this.stopping) return

    // THE edge the sentry is defined by: the window it fills is "play
    // pressed" → "media arrives", so the first packet that is NOT one of its
    // own synthetic frames closes it. Deliberately not the status flip, not the
    // first keyframe and not the source refresh — a still picture must stop the
    // instant real bytes exist, and `isPlaceholder` is read STRICTLY so an
    // ordinary packet (which omits the field) always counts as real.
    if (packet.isPlaceholder !== true && !this.sentryWindowClosed) {
      this.sentryWindowClosed = true
      this.sentryPump?.stop('first real packet')
      // The same edge, told to the manager: it owns snapshots and this is the
      // one moment the camera is provably awake with media flowing. Guarded by
      // `sentryWindowClosed`, so it fires once per wake and never on the
      // per-packet path proper. It must not be able to break the media path:
      // a hook that throws here would kill the packet that woke it.
      try {
        this.onRealMediaStarted?.()
      } catch (err) {
        this.logger?.debug('sentry: real-media hook threw', {
          tags: { deviceId: this.numericDeviceId ?? 0 },
          meta: { error: String(err) },
        })
      }
    }

    // Reset push-mode stall timer on every packet
    if (this.source?.type === 'push') {
      this.stopErrorPlaceholder()
      if (this._status === 'error') this._status = 'streaming'
      // Clear suspension if we were waiting on a battery camera to wake.
      if (this._suspended && this.source.allowStall) {
        this._suspended = false
        this.logger?.info('push source resumed after stall — first packet received')
      }
      this.resetPushStallTimer()
    }

    // Broker-side mute (D83) for PUSH sources (Reolink Baichuan).
    // Before the codec session and before the fanout — an AAC frame handed to
    // the decode session would spin up an upstream session + poll loop only to
    // have its output dropped downstream.
    if (packet.type === 'audio' && this.audioMuted) {
      this.dropMutedAudio('push-encoded')
      return
    }

    // Push audio: route non-native codecs (e.g. AAC) through the
    // audio-codec cap session if one was armed via pushAudioInfo. The
    // session emits decoded PCM to audioSubscribers and transcodes to
    // G.711 µ-law for WebRTC via the shared emit callback. Native
    // codecs (PCMU/PCMA) fall through to the encodedCallbacks fanout
    // below — no transcode required.
    if (packet.type === 'audio' && this.source?.type === 'push' && this.audioCodecSession) {
      const codec = packet.codec.toLowerCase()
      if (codec !== 'pcmu' && codec !== 'pcma') {
        // Demand-gate the decode (upstream session + 40ms poll loop):
        // only push the raw AAC/Opus frame when an audio consumer is
        // attached. The `return` still fires unconditionally — a raw
        // codec frame must NOT fall through to the encodedCallbacks
        // fanout below, which expects G.711, not undecoded codec bytes.
        // The next attached consumer re-arms the session lazily.
        if (this.hasAudioConsumer()) {
          this.audioCodecSession.pushRawFrame(packet.data)
        }
        return
      }
    }

    // Track bitrate + IDR interval — unless the native RTP reader is up, in
    // which case ITS packets feed the stats (`onVideoRtp` → `recordVideoStats`).
    // The Annex-B plane is built only while something consumes it, so a stat
    // fed from here would read 0 fps for a camera that is streaming fine.
    if (packet.type === 'video' && this.rtpDepacketizer === null) {
      this.recordVideoStats(packet.data.length, true, packet.keyframe)
    }

    // Buffer encoded video packets for pre-buffer (late-join).
    // ONE pre-buffer per source: RTP sources (RTSP) use the raw source-RTP
    // ring (`captureRtpForPreBuffer` / `getRtpPreBuffer`) for the repacketizer
    // path, so the AnnexB pre-buffer would be a redundant second copy of the
    // same GOP — its video is never flushed for RTP sources (the WebRTC
    // AnnexB flush is gated on push sources) and profile derivation reads SDP
    // first. So only AnnexB/push sources populate this one.
    if (packet.type === 'video' && !this.isRtpSource()) {
      this.preBuffer.push(packet)
    }

    // Clip retention is a SEPARATE ring, not a wider `preBuffer`. The AnnexB
    // pre-buffer is empty for RTP sources by design and the WebRTC join path
    // reads it — starting to fill it there would change what a late-joining
    // viewer is flushed on every RTSP camera, to buy a notification clip. The
    // dedicated ring exists only while retention is on, and only on the one
    // profile clips are cut from.
    // A synthetic frame never enters the clip buffer: an event clip must show
    // what the camera saw, and `prebuffer-clip.ts` already filters placeholders
    // out on the way OUT. Filtering on the way IN as well means the buffer's
    // seconds-of-media accounting is not silently spent on a still image.
    if (packet.type === 'video' && this.clipBuffer && packet.isPlaceholder !== true) {
      this.clipBuffer.push(packet)
    }

    this.fanOutEncoded(packet)

    // Broadcast raw video bytes to TCP pipe clients (restreamers)
    if (packet.type === 'video') {
      this.pipeServer.broadcast(packet.data)

      // Feed RTSP restreamer (Annex-B mode only — in passthrough mode, raw RTP
      // is forwarded directly via pushRtpPassthrough in the onVideoRtp callback)
      if (!this.rtspRestreamer.rtpPassthroughMode) {
        this.rtspRestreamer.pushPacket(packet)
      }
    }
  }

  onEncodedData(
    callback: (packet: EncodedPacket) => void,
    attribution: BrokerConsumerAttribution = UNKNOWN_ATTRIBUTION,
  ): Unsubscribe {
    this.subscriberIdCounter += 1
    const entry: EncodedSubscriberEntry = {
      id: `enc-${this.deviceId}-${this.subscriberIdCounter}`,
      channel: 'annexb',
      attribution,
      subscribedAt: Date.now(),
      packetsDelivered: 0,
    }
    this.encodedCallbacks.set(callback, entry)
    reportConsumerEvent(
      this.logger,
      'attach',
      attribution.kind,
      this.numericDeviceId,
      this.encodedCallbacks.size + this.rtpVideoCallbacks.size,
    )
    if (this.streamingDebug) {
      this.logger?.info('encoded subscriber added', {
        meta: {
          total: this.encodedCallbacks.size,
          subscriberId: entry.id,
          kind: attribution.kind,
          label: attribution.label,
        },
      })
    }

    // Seed the new subscriber with the SDP-derived param sets so
    // WebRTC sessions get VPS/SPS/PPS even when the camera doesn't
    // emit them in-band (Reolink high-profile streams).
    this.emitSdpParamSetsTo(callback)
    this.checkDemand()

    return () => {
      this.encodedCallbacks.delete(callback)
      reportConsumerEvent(
        this.logger,
        'detach',
        attribution.kind,
        this.numericDeviceId,
        this.encodedCallbacks.size + this.rtpVideoCallbacks.size,
      )
      if (this.streamingDebug) {
        this.logger?.info('encoded subscriber removed', {
          meta: { total: this.encodedCallbacks.size, subscriberId: entry.id },
        })
      }
      this.checkDemand()
    }
  }

  /**
   * Emit the cached SDP param sets as a synthetic Annex-B EncodedPacket
   * to a single subscriber. No-op if no param sets are cached or no
   * codec is detected yet.
   */
  private emitSdpParamSetsTo(callback: (packet: EncodedPacket) => void): void {
    if (!this.sdpParameterSets || this.sdpParameterSets.length === 0) return
    const codec = this.detectedCodec
    if (!codec) return
    const startCode = Buffer.from([0x00, 0x00, 0x00, 0x01])
    const annexB = Buffer.concat(this.sdpParameterSets.flatMap((ps) => [startCode, ps]))
    if (this.streamingDebug) {
      this.logger?.info('Emitting SDP param sets to encoded subscriber', {
        meta: {
          codec,
          psCount: this.sdpParameterSets.length,
          psSizes: this.sdpParameterSets.map((p) => p.length).join(','),
          psFirstBytesHex: this.sdpParameterSets
            .map((p) => p.subarray(0, 4).toString('hex'))
            .join('|'),
          annexBLength: annexB.length,
        },
      })
    }
    callback({
      type: 'video',
      data: annexB,
      pts: 0,
      dts: 0,
      keyframe: false,
      codec,
    })
  }

  /** Replay SDP param sets to every existing encoded subscriber. */
  private replaySdpParamSetsToEncodedSubscribers(): void {
    if (!this.sdpParameterSets || this.encodedCallbacks.size === 0) return
    for (const cb of this.encodedCallbacks.keys()) this.emitSdpParamSetsTo(cb)
  }

  /**
   * Subscribers waiting on the SDP-derived VPS/SPS/PPS to land. The
   * H.265 source-RTP path needs to seed its `H265Repacketizer` with
   * these param sets so the AP codec packet can fire ahead of the
   * first IDR — without it Chrome's HEVC decoder never initialises on
   * cameras that only ship parameter sets in the SDP (Reolink high-
   * profile streams). Sessions created while the broker is still
   * dialing rfc4571 (battery-cam wake-up) have null `sdpParameterSets`
   * at create time; this subscription delivers them as soon as
   * `onVideoTrack` fires. Mirrors `replaySdpParamSetsToEncodedSubscribers`
   * for the source-RTP path.
   */
  private readonly sdpParameterSetsCallbacks = new Set<(ps: ReadonlyArray<Buffer>) => void>()

  /**
   * Subscribe to SDP-derived VPS/SPS/PPS deliveries. The callback
   * fires once immediately if the broker already has them (synchronous
   * delivery for late subscribers), and again every time
   * `onVideoTrack` repopulates them on a reader rebuild.
   */
  onSdpParameterSets(callback: (ps: ReadonlyArray<Buffer>) => void): Unsubscribe {
    this.sdpParameterSetsCallbacks.add(callback)
    if (this.sdpParameterSets && this.sdpParameterSets.length > 0) {
      try {
        callback(this.sdpParameterSets)
      } catch (err) {
        this.logger?.warn('sdp param-set subscriber threw on initial delivery', {
          meta: { error: errMsg(err) },
        })
      }
    }
    return () => {
      this.sdpParameterSetsCallbacks.delete(callback)
    }
  }

  /** Fan out the current SDP param sets to every waiting subscriber. */
  private replaySdpParamSetsToRtpSubscribers(): void {
    if (!this.sdpParameterSets || this.sdpParameterSetsCallbacks.size === 0) return
    const ps = this.sdpParameterSets
    for (const cb of this.sdpParameterSetsCallbacks) {
      try {
        cb(ps)
      } catch (err) {
        this.logger?.warn('sdp param-set subscriber threw', {
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  onVideoRtp(
    callback: (rtpData: Buffer) => void,
    attribution: BrokerConsumerAttribution = UNKNOWN_ATTRIBUTION,
  ): Unsubscribe {
    this.subscriberIdCounter += 1
    const entry: EncodedSubscriberEntry = {
      id: `rtp-${this.deviceId}-${this.subscriberIdCounter}`,
      channel: 'rtp',
      attribution,
      subscribedAt: Date.now(),
      packetsDelivered: 0,
    }
    this.rtpVideoCallbacks.set(callback, entry)
    reportConsumerEvent(
      this.logger,
      'attach',
      attribution.kind,
      this.numericDeviceId,
      this.encodedCallbacks.size + this.rtpVideoCallbacks.size,
    )
    // Per-camera setting OR the armed `stream-broker.rtp` window. `CH_RTP.on`
    // is a plain boolean field read after the equally plain `streamingDebug`
    // field, so a disarmed channel adds one load and one branch — and the
    // `extras` object is still built only inside the branch.
    if (this.streamingDebug || CH_RTP.on) {
      this.logger?.info('rtp video subscriber added', {
        meta: {
          total: this.rtpVideoCallbacks.size,
          subscriberId: entry.id,
          kind: attribution.kind,
          label: attribution.label,
        },
      })
    }
    this.checkDemand()
    return () => {
      this.rtpVideoCallbacks.delete(callback)
      reportConsumerEvent(
        this.logger,
        'detach',
        attribution.kind,
        this.numericDeviceId,
        this.encodedCallbacks.size + this.rtpVideoCallbacks.size,
      )
      if (this.streamingDebug || CH_RTP.on) {
        this.logger?.info('rtp video subscriber removed', {
          meta: { total: this.rtpVideoCallbacks.size, subscriberId: entry.id },
        })
      }
      this.checkDemand()
    }
  }

  /**
   * Re-tag every subscriber whose attribution carries `sessionId` with the
   * supplied patch (e.g. a remote address discovered once ICE connects, or a
   * User-Agent resolved at the signaling edge). Both the audio + video rows of
   * a WebRTC session share one `sessionId`, so a single call updates both.
   *
   * The stored attribution is never mutated — the entry's pointer is swapped
   * to a freshly merged object. Returns true when at least one entry matched.
   */
  updateConsumerAttributionBySession(
    sessionId: string,
    patch: Partial<BrokerConsumerAttribution>,
  ): boolean {
    let matched = false
    for (const entry of this.encodedCallbacks.values()) {
      if (entry.attribution.sessionId === sessionId) {
        entry.attribution = { ...entry.attribution, ...patch }
        matched = true
      }
    }
    for (const entry of this.rtpVideoCallbacks.values()) {
      if (entry.attribution.sessionId === sessionId) {
        entry.attribution = { ...entry.attribution, ...patch }
        matched = true
      }
    }
    return matched
  }

  getSdpParameterSets(): ReadonlyArray<Buffer> | null {
    return this.sdpParameterSets
  }

  /**
   * Append a source RTP packet to the pre-buffer ring, trimming it to begin
   * at the most recent keyframe access unit. Access-unit boundaries are
   * detected via the RTP marker bit (set on the last packet of a frame);
   * keyframe-ness comes from the depacketizer flags set just before this
   * call. The ring therefore always holds `[current keyframe AU start .. now]`.
   */
  private captureRtpForPreBuffer(rtpData: Buffer): void {
    // marker bit: RTP header byte 1, bit 7 — last packet of an access unit.
    const marker = rtpData.length > 1 && (rtpData[1]! & 0x80) !== 0
    const auStart = this.rtpRingPrevMarker || this.rtpRing.length === 0
    if (auStart) this.rtpRingCurAuStart = this.rtpRing.length
    // The ring keeps this packet for the life of a GOP, plus the prebuffer
    // window — long enough that a ~1.3 KB packet carved from a shared 8 KiB
    // pool slab pinned the slab and the short-lived traffic beside it. A
    // retained packet owns its backing store (`owned-buffer.ts`). The native
    // readers now cut every packet owned (`copyOwned`), so this is an identity
    // for them and the ring, the restreamer's keyframe cache and the fan-out
    // all share ONE allocation; it still copies for a pooled packet from any
    // other path (push-rtp).
    const owned = this.packetPool.adopt(rtpData)
    holdPacket(owned)
    this.rtpRing.push(owned)
    this.rtpRingBytes += backingStoreBytes(owned)

    // This packet's NAL began/contained keyframe data → the current AU is a
    // keyframe AU. Record it, then trim the ring's head to the oldest keyframe
    // still inside the pre-roll window — which with pre-roll OFF (the default)
    // is this AU itself, i.e. the minimal current GOP a fresh viewer gets today.
    if (this._lastNalParamSet || this._lastNalKeyframe) {
      const auStart = this.rtpRingCurAuStart
      const lastMark = this.rtpRingKeyframeMarks[this.rtpRingKeyframeMarks.length - 1]
      // Every packet of the AU carries the flag; one mark per AU.
      if (!lastMark || lastMark.index !== auStart) {
        const auPacket = this.rtpRing[auStart]
        if (auPacket && auPacket.length >= 8) {
          this.rtpRingKeyframeMarks.push({
            index: auStart,
            ts: auPacket.readUInt32BE(4),
          })
        }
        // Once per keyframe AU, at its mark — not once per flagged packet. The
        // flags are per packet now, so a 4K IDR fragmented into a hundred
        // packets would otherwise re-run the window selection a hundred times
        // for one answer: the trim reads only the marks and the newest
        // timestamp, both unchanged inside the AU.
        this.trimRtpRingToPreRollWindow()
      }
      this.rtpRingHasKeyframe = true
    }

    this.rtpRingPrevMarker = marker

    // Memory ceiling: a GOP longer than the cap drops the bootstrap entirely
    // (late joiners wait for the next keyframe) rather than ballooning memory.
    if (this.rtpRingBytes > RTP_RING_MAX_BYTES) {
      // Silent until 2026-08-06: this discards EVERY joiner's bootstrap for as
      // long as the condition holds, and the only evidence downstream was
      // restream primes mysteriously falling back to `keyframe-only`.
      this.reportThrottled('rtp pre-buffer ring exceeded cap — join bootstrap dropped', {
        bytes: this.rtpRingBytes,
        packets: this.rtpRing.length,
        capBytes: RTP_RING_MAX_BYTES,
      })
      this.resetRtpPreBuffer()
    }
  }

  /**
   * Deliver one encoded packet to every Annex-B subscriber.
   *
   * Guarded exactly like the source-RTP fan-out (`onVideoRtp`): a throwing
   * consumer used to abort the loop, so every consumer AFTER it in Map
   * insertion order silently lost that packet — a decoder feed or a recording
   * leg going dark because an unrelated session threw. The asymmetry between
   * the two fan-outs was the bug; there is one behaviour now, and it is the
   * safe one.
   */
  private fanOutEncoded(packet: EncodedPacket): void {
    // The single point audio LEAVES the broker for a live consumer, and the
    // one that makes "no audio is distributed" a property rather than a
    // probability: the ingress guards stop new audio, but a decode session or
    // the Opus encoder can still emit a unit queued BEFORE the mute landed.
    // One comparison per packet.
    if (packet.type === 'audio' && this.audioMuted) {
      this.dropMutedAudio('encoded-fanout')
      return
    }
    for (const [cb, entry] of this.encodedCallbacks) {
      try {
        cb(packet)
        entry.packetsDelivered += 1
      } catch (err) {
        this.reportThrottled('encoded subscriber threw — packet dropped for that consumer', {
          subscriberId: entry.id,
          kind: entry.attribution.kind,
          packetType: packet.type,
          error: errMsg(err),
        })
      }
    }
  }

  /**
   * Warn about a work-dropping branch at most once per
   * {@link DROP_REPORT_INTERVAL_MS} per message, with the occurrence count
   * since the last report.
   *
   * These branches sit on the packet path: an unthrottled line would be one log
   * per frame on a stream that is already struggling. Aggregated, never
   * per-packet — and always tagged with the device.
   */
  private reportThrottled(message: string, meta: Record<string, unknown>): void {
    const now = Date.now()
    const state = this.throttledReports.get(message) ?? { lastMs: 0, count: 0 }
    state.count += 1
    if (now - state.lastMs < DROP_REPORT_INTERVAL_MS) {
      this.throttledReports.set(message, state)
      return
    }
    this.logger?.warn(message, {
      tags: { deviceId: this.numericDeviceId },
      meta: {
        ...meta,
        occurrences: state.count,
        windowMs: DROP_REPORT_INTERVAL_MS,
      },
    })
    this.throttledReports.set(message, { lastMs: now, count: 0 })
  }

  /**
   * Reset the source-RTP pre-buffer ring to its empty/cold state. Called on
   * every reader teardown (`resetRtpPipeline`) so a stale GOP from a prior
   * session can NEVER leak across an on-demand idle window — and on cap
   * overflow. Without this, a redial that begins mid-GOP (no IDR yet) would
   * replay the previous session's stale `rtpRingHasKeyframe`-true ring to a
   * fresh viewer (the `1 packet, sent=0` cold-start symptom): a degenerate,
   * non-decodable slice instead of waiting for the new dial's first keyframe.
   */
  private resetRtpPreBuffer(): void {
    releasePackets(this.rtpRing)
    this.rtpRing = []
    this.rtpRingBytes = 0
    this.rtpRingCurAuStart = 0
    this.rtpRingPrevMarker = true
    this.rtpRingHasKeyframe = false
    this.rtpRingKeyframeMarks = []
  }

  /**
   * Install THE prebuffer for this stream — the one configuration that decides
   * whether this broker holds the source warm and how much history it keeps.
   *
   * Every ring this broker owns is sized from it, each fed by the source type
   * it belongs to: the source-RTP ring (RTSP cameras, the history a join burst
   * is cut from) and the Annex-B `preBuffer` (push sources).
   * That is the correction this record exists for — the seconds used to size
   * ONLY the Annex-B ring, which is never fed for an RTP source, so on every
   * warm camera in this fleet the configured seconds retained nothing while two
   * other numbers quietly sized the history that did exist.
   */
  setPrebuffer(config: PrebufferConfig): void {
    const next = prebufferRetentionMs(config)
    // The flag and the duration are ONE decision and are applied together: a
    // broker that was told `enabled` but kept a stale duration (or the reverse)
    // is precisely the disagreement D381 retires — `applyPreBufferConfig` and
    // `applyPreRoll` used to write them from two call sites.
    this.setPreBufferEnabled(config.enabled)
    this.setPreBufferDuration(config.seconds)
    this.prebufferMs = next
  }

  /**
   * How far back the ring is kept — the prebuffer, and nothing else.
   *
   * It used to be `max(detectionPreRollMs, recordingPreRollMs)`: a maximum over
   * CONFIGURATIONS, which is what made "how much history does camera 102 hold"
   * a question with two answers and no owner. There is one configuration now,
   * so the retention is it.
   */
  getPreRollRetentionMs(): number {
    return this.prebufferMs
  }

  /**
   * Byte budget for the EXTRA history pre-roll retains, over and above the
   * current GOP — derived from the window in force and this stream's OBSERVED
   * bitrate.
   *
   * Its own budget rather than a share of {@link RTP_RING_MAX_BYTES} because
   * the two failures are different: reaching the ring cap calls
   * `resetRtpPreBuffer`, which drops the join bootstrap of EVERY consumer —
   * WebRTC viewers included — for as long as the condition holds. A pre-roll
   * that pushed a 4K stream into that state would be a knob for one camera's
   * detection quietly degrading everybody else's picture. Over this budget the
   * OLDEST retained GOP is dropped whole (never a tail cut), so the window
   * stays decodable and simply carries less history than asked for.
   *
   * It replaced a FLAT 8 MiB constant, which was a promise this feature could
   * not keep in either direction — see {@link preRollBudgetBytes}.
   */
  getPreRollBudget(): PreRollBudget {
    return preRollBudgetBytes(this.getPreRollRetentionMs(), this.bitrateKbps)
  }

  /** Retained keyframe AUs as ages in ms of media time behind `newestTs`. */
  private rtpPreRollMarks(newestTs: number): readonly PreRollMark[] {
    // Signed-32-bit-safe subtraction: the 90 kHz source clock wraps every
    // ~13.25 h and an RTSP redial re-bases it outright.
    return this.rtpRingKeyframeMarks.map((mark) => ({
      index: mark.index,
      ageMs: ((newestTs - mark.ts) | 0) / 90,
    }))
  }

  /**
   * Trim the RTP ring's head to the oldest keyframe AU still inside the
   * pre-roll window, then to the pre-roll byte budget.
   *
   * With `preRollMs === 0` the selection is the newest keyframe AU, so this is
   * the pre-existing "trim to the current GOP" behaviour with no change in
   * retained bytes. Whole GOPs only, from the head: a tail cut no longer starts
   * at a keyframe (D57).
   */
  private trimRtpRingToPreRollWindow(): void {
    if (this.rtpRingKeyframeMarks.length === 0 || this.rtpRing.length === 0) return
    const newestTs = this.rtpRing[this.rtpRing.length - 1]!.readUInt32BE(4)
    const marks = this.rtpPreRollMarks(newestTs)
    // The RETENTION window, not either consumer's: the ring must still hold
    // what the widest intent will ask for at read time.
    const retentionMs = this.getPreRollRetentionMs()
    const selection = selectPreRollStart(marks, retentionMs)
    let cut = selection.startIndex
    if (cut < 0) return

    // Byte budget for the retained history — drop the oldest GOP until it fits,
    // never the current one (that is `RTP_RING_MAX_BYTES`' job, and its cost
    // falls on every consumer).
    if (retentionMs > 0) {
      const budget = this.getPreRollBudget()
      this.reportPreRollClamp(budget, retentionMs)
      // Measured over the HISTORY only — everything before the current GOP's
      // keyframe. The current GOP is the Stage 0 baseline and is served whatever
      // it weighs; it also keeps growing after this trim, so including it would
      // make the budget hold at keyframes and nowhere else.
      const historyEnd = this.rtpRingKeyframeMarks[this.rtpRingKeyframeMarks.length - 1]!.index
      let retained = 0
      for (let i = cut; i < historyEnd; i++) retained += backingStoreBytes(this.rtpRing[i]!)
      let markIdx = this.rtpRingKeyframeMarks.findIndex((m) => m.index === cut)
      while (
        retained > budget.bytes &&
        markIdx >= 0 &&
        markIdx < this.rtpRingKeyframeMarks.length - 1
      ) {
        const nextCut = this.rtpRingKeyframeMarks[markIdx + 1]!.index
        for (let i = cut; i < nextCut; i++) retained -= backingStoreBytes(this.rtpRing[i]!)
        cut = nextCut
        markIdx++
      }
    }

    if (cut <= 0) return
    const dropped = this.rtpRing.splice(0, cut)
    for (const b of dropped) this.rtpRingBytes -= backingStoreBytes(b)
    releasePackets(dropped)
    this.rtpRingKeyframeMarks = this.rtpRingKeyframeMarks
      .filter((mark) => mark.index >= cut)
      .map((mark) => ({ index: mark.index - cut, ts: mark.ts }))
    this.rtpRingCurAuStart = Math.max(0, this.rtpRingCurAuStart - cut)
  }

  /**
   * Snapshot of the source-RTP pre-buffer (the current GOP from its
   * keyframe) for a late-joining repacketizer-path viewer to replay on
   * connect — instant decoder start. Empty until a keyframe has been seen
   * (or after a cap overflow / reader teardown), in which case the viewer
   * falls back to waiting for the camera's next keyframe.
   */
  getRtpPreBuffer(): readonly Buffer[] {
    if (!this.rtpRingHasKeyframe) return []
    // The CURRENT GOP, explicitly — not "whatever the ring holds". Those were
    // the same thing until pre-roll, and they must not become the same thing
    // again: this snapshot is the WebRTC bootstrap AND the plain RTSP join
    // burst, and widening it would hand every re-clocking consumer the backlog
    // D57 exists to keep away from them.
    const newest = this.rtpRingKeyframeMarks[this.rtpRingKeyframeMarks.length - 1]
    return newest ? this.rtpRing.slice(newest.index) : this.rtpRing.slice()
  }

  /**
   * Snapshot for a DETECTION decode dial: the current GOP plus up to
   * {@link preRollMs} of the history before it, starting at a keyframe AU.
   *
   * Identical to {@link getRtpPreBuffer} while pre-roll is off, and it degrades
   * to it whenever the ring holds no older keyframe — a source that was idle
   * when motion fired retained nothing, and the honest outcome there is the
   * Stage 0 burst rather than a pretend one.
   */
  getRtpPreRollBuffer(requestedMs: number): readonly Buffer[] {
    if (!this.rtpRingHasKeyframe) return []
    // THE cap, and the only one (D381). Every reader of retained history comes
    // through here, so a consumer cannot be served a window wider than this
    // stream retains however it asks. `requestedMs` is REQUIRED (D382): it was
    // optional, and omitting it meant "all of it", which is how detection came
    // to be served the recording window without anybody deciding it should be.
    const windowMs = capPreRollRequestMs(requestedMs, this.prebufferMs)
    if (windowMs <= 0 || this.rtpRing.length === 0) return this.getRtpPreBuffer()
    const newestTs = this.rtpRing[this.rtpRing.length - 1]!.readUInt32BE(4)
    const selection = selectPreRollStart(this.rtpPreRollMarks(newestTs), windowMs)
    return selection.startIndex < 0 ? [] : this.rtpRing.slice(selection.startIndex)
  }

  /**
   * Say it, ONCE per transition, when the absolute ceiling truncates the window
   * the operator configured.
   *
   * A clamp nobody prints is indistinguishable from a camera that was simply
   * not warm long enough, and the two call for opposite actions (buy the RAM
   * back vs wait). The flat 8 MiB cap this replaced clamped SILENTLY, which is
   * how "10 s" could mean 6 s on a 4K stream for as long as it did.
   */
  private reportPreRollClamp(budget: PreRollBudget, retentionMs: number): void {
    if (budget.clamped === this.preRollClampLogged) return
    this.preRollClampLogged = budget.clamped
    if (!budget.clamped) return
    this.logger?.warn('pre-roll budget clamped — the window will carry less than configured', {
      tags: { deviceId: this.numericDeviceId },
      meta: {
        retentionMs,
        prebufferMs: this.prebufferMs,
        bitrateKbps: this.bitrateKbps,
        budgetBytes: budget.bytes,
      },
    })
  }

  getSourceType(): StreamSourceType | null {
    return this.source?.type ?? null
  }

  /**
   * True when the broker emits source RTP packets via `onVideoRtp`.
   * RTSP demuxes incoming RTP directly; rfc4571 (RTP-over-TCP framed
   * per RFC 4571) deserializes into the same wire shape and runs
   * through the same `buildRtpStreamCallbacks.onVideoRtp` path;
   * `push-rtp` sources synthesize it via `pushVideoRtp()`. Bare
   * `push` (AnnexB-only) and `rtmp` (no RTP wire) return false.
   *
   * Crucial for the WebRTC dispatch decision: H.265 sources marked
   * as RTP route through `H265Repacketizer` for source-RTP forwarding
   * (Chrome's HEVC depacketizer requires the original RTP header
   * layout); non-RTP sources fall back to AnnexB → `writeVideoNals`
   * with cached-keyframe-on-PLI. Marking rfc4571 as non-RTP put the
   * Reolink Baichuan H.265 native:main stream on the wrong path —
   * Chrome got stuck in a PLI loop because each cached re-send
   * collided with the live decode state.
   */
  isRtpSource(): boolean {
    const t = this.source?.type
    return t === 'rtsp' || t === 'rfc4571' || t === 'push-rtp'
  }

  /**
   * Push a raw RTP packet from an external `push-rtp` source. Captures into
   * the source-RTP pre-buffer (so a late-joining repacketizer-path viewer
   * can instant-start from the current GOP) and fans out to every
   * `onVideoRtp` subscriber.
   *
   * `push-rtp` providers deliver AnnexB-equivalents separately via
   * `pushEncodedPacket()` (see `IStreamBroker` contract) — so this path
   * does NOT re-emit EncodedPackets; it only classifies each packet for the
   * keyframe/param-set flags the pre-buffer capture needs
   * (`classifyRtpPacket`, no reassembly), keeping the AnnexB consumers
   * (pipe, restreamer) single-fed by the provider.
   *
   * The pre-buffer is captured even with zero subscribers attached — a
   * viewer that connects mid-GOP must be able to replay the GOP that
   * accumulated before it arrived. The fan-out is what no-ops without
   * subscribers, so providers can still fire-and-forget.
   */
  pushVideoRtp(rtpData: Buffer): void {
    if (this.stopping) return

    // Rolling activity watchdog: every source-RTP packet (push-rtp,
    // native RTSP, rfc4571) resets the silence timer. Mirrors the
    // `buildRtpStreamCallbacks.onVideoRtp` arm so a push-rtp source
    // benefits from the same stall detection even though its expiry
    // is informational-only (no reader to tear down).
    this.kickRtpActivityWatchdog()

    // The keyframe/param-set flags the capture reads — what THIS packet
    // carries, read from its payload headers. No depacketizer: push-rtp has no
    // SDP `onVideoTrack`, so the codec comes from the source declaration
    // (`detectedCodec`, seeded in `start()`), and the provider owns the Annex-B
    // plane through `pushEncodedPacket`, so nothing here reassembles a NAL.
    const carried = classifyRtpPacket(this.detectedCodec === 'h265' ? 'h265' : 'h264', rtpData)
    this._lastNalKeyframe = carried?.keyframe ?? false
    this._lastNalParamSet = carried?.parameterSet ?? false

    // Capture into the source-RTP pre-buffer (current GOP) BEFORE fan-out
    // so a subscriber bootstrapping from it sees this packet as the tail —
    // exactly as the native reader does (`buildRtpStreamCallbacks.onVideoRtp`).
    this.captureRtpForPreBuffer(rtpData)

    if (this.rtpVideoCallbacks.size === 0) return
    for (const [cb, entry] of this.rtpVideoCallbacks) {
      try {
        cb(rtpData)
        entry.packetsDelivered += 1
      } catch (err) {
        this.logger?.warn('rtp video subscriber threw', {
          meta: { error: errMsg(err) },
        })
      }
    }
  }

  /** Toggle the per-device streaming debug flag. */
  setStreamingDebug(enabled: boolean): void {
    this.streamingDebug = enabled
  }

  /**
   * Test seam exposing the source-RTP activity watchdog state. Production
   * code MUST NOT read this — it exists so unit tests can assert recovery
   * behavior without inspecting private timer handles (which can't be
   * compared by reference, and tracking them externally would race with
   * arm/cancel paths). Mirrors the `firstVideoWatchdog` behavior but
   * fires on every-packet activity rather than first-packet only.
   */
  getRtpActivityWatchdogStatus(): { armed: boolean; firedCount: number } {
    return {
      armed: this.rtpActivitySweep !== undefined,
      firedCount: this.rtpActivityWatchdogFiredCount,
    }
  }

  /**
   * Test seam exposing the first-video watchdog state and the per-dial video
   * RTP counter. Production code MUST NOT read this — it exists so unit tests
   * can assert the counter resets on every dial (regression: a broker-lifetime
   * counter left the first-video watchdog dead on every re-dial) and that the
   * watchdog stands down once video flows.
   */
  getFirstVideoWatchdogStatus(): {
    armed: boolean
    videoRtpSeen: number
    timeoutMs: number
    materializeRequestedAt: number
  } {
    return {
      armed: this.firstVideoWatchdog !== undefined,
      videoRtpSeen: this.videoRtpSeen,
      timeoutMs: this.firstVideoTimeoutMs(),
      materializeRequestedAt: this.materializeRequestedAt,
    }
  }

  // ── Decoded audio-chunk plane (Phase 5 / D9) ─────────────────────────

  /**
   * Open a decoded audio-chunk subscription — the poll-based, tRPC-reachable
   * replacement for the live-object `onDecodedAudioChunk` callback. The
   * broker registers a per-subscription FIFO queue and returns a
   * `subscriptionId` the consumer drains via `pullAudioChunks`.
   */
  subscribeAudioChunks(options?: AudioSubscribeOptions): SubscribeAudioChunksResult {
    const tag = options?.tag
    if (!tag) {
      this.logger?.warn(`subscribeAudioChunks called without tag — listClients will show 'unknown'`)
    }
    // `accept` is what this consumer can READ. Absent means f32le and only
    // f32le — the plane expands for it, exactly as before D455 — so a
    // consumer deployed from an older bundle is never handed coded bytes.
    const result = this.audioChunkPlane.subscribe({ tag, accept: options?.accept })
    reportConsumerEvent(
      this.logger,
      'attach',
      'audio-chunks',
      this.numericDeviceId,
      this.audioChunkPlane.subscriberCount,
    )
    // Audio counts as demand (see hasDemand). Trigger the same
    // suspend/resume reconcile that video subscribers do — without
    // this, attaching to a suspended broker leaves it suspended and
    // no chunks ever arrive.
    this.checkDemand()
    return result
  }

  /** Drain up to `maxCount` `DecodedAudioChunk`s for an audio-chunk subscription. */
  pullAudioChunks(subscriptionId: string, maxCount: number): readonly DecodedAudioChunk[] {
    return this.audioChunkPlane.pull(subscriptionId, maxCount)
  }

  /** Release an audio-chunk subscription. Returns `true` when it existed. */
  unsubscribeAudioChunks(subscriptionId: string): boolean {
    const released = this.audioChunkPlane.unsubscribe(subscriptionId)
    if (released) {
      reportConsumerEvent(
        this.logger,
        'detach',
        'audio-chunks',
        this.numericDeviceId,
        this.audioChunkPlane.subscriberCount,
      )
      this.checkDemand()
    }
    return released
  }

  getStats(): BrokerStats {
    return {
      status: this._suspended ? 'idle' : this._status,
      inputFps: this.encodedInputFps,
      encodedSubscribers: this.encodedCallbacks.size + this.rtpVideoCallbacks.size,
      uptimeMs: Date.now() - this.startedAt,
      bitrateKbps: this.bitrateKbps,
      idrIntervalMs: this.idrIntervalMs,
      codec: this.detectedCodec ?? this.source?.videoCodec,
      totalBytes: this.totalBytes,
      packetCount: this.packetCount,
      rtspClients: this.rtspRestreamer.getSessionCount(),
      pipeClients: this.pipeServer.getClientCount(),
      preBufferSec: this.preBuffer.getDuration(),
      preBufferMs: this.preBuffer.getBufferedDurationMs(),
      preBufferPackets: this.preBuffer.getPacketCount(),
      audio: this.audioTrackInfo ?? null,
      audioMuted: this.audioMuted,
      audioMutedDropped: this.audioMutedDropped,
    }
  }

  /**
   * Per-broker consumer inventory (Phase 10). Returns the live subscriber
   * list grouped by transport — every RTSP client, encoded subscriber and
   * audio-chunk subscriber. Used by the admin UI's
   * Streams tab and by operators diagnosing "phantom" holders keeping a
   * broker open.
   */
  listClients(): {
    readonly rtsp: readonly {
      readonly sessionId: string
      readonly remoteAddr: string
      readonly userAgent: string | null
      readonly playing: boolean
      readonly muted: boolean
      readonly connectedAt: number
      readonly lastRtpAt: number
      readonly bytesSent: number
    }[]
    readonly audio: readonly {
      readonly tag: string
      readonly subscribedAt: number
      readonly chunksDelivered: number
    }[]
    readonly encoded: readonly BrokerEncodedClient[]
    readonly pipeClients: number
    readonly encodedSubscribers: number
  } {
    const encoded: BrokerEncodedClient[] = []
    for (const entry of this.encodedCallbacks.values()) {
      encoded.push({
        id: entry.id,
        channel: entry.channel,
        attribution: entry.attribution,
        subscribedAt: entry.subscribedAt,
        packetsDelivered: entry.packetsDelivered,
      })
    }
    for (const entry of this.rtpVideoCallbacks.values()) {
      encoded.push({
        id: entry.id,
        channel: entry.channel,
        attribution: entry.attribution,
        subscribedAt: entry.subscribedAt,
        packetsDelivered: entry.packetsDelivered,
      })
    }

    // The prebuffer HOLD, as a session (D381).
    //
    // It used to be a synthetic hint, and it was gated on `encoded.length === 0`
    // — "when a real consumer holds the stream the warmth is already explained".
    // Measured on the live hub on 2026-09-07, that gate made the row a lie in
    // both directions: 102, 101 and 103 each had zero encoded subscribers and
    // ONE real RTSP session, so the view named the prebuffer as the holder of a
    // stream something else was holding, and a camera the prebuffer really was
    // holding alongside an encoded consumer showed no prebuffer row at all.
    //
    // The hold is a real object now ({@link prebufferHold}) with an id, a start
    // time and a lifetime tied to the configuration that created it, and it is
    // listed whenever it exists — beside the other holders, never instead of
    // them. It stays out of `encodedSubscribers`, which is the count of
    // consumers being SENT packets, and it is deliberately not killable: the
    // authority over it is the prebuffer switch (D62), and a kill the next
    // reconcile silently undoes is the second disagreeing knob this record
    // exists to remove.
    const hold = this.prebufferHold
    if (hold) {
      encoded.push({
        id: hold.id,
        channel: 'annexb',
        attribution: { kind: 'warmup', userAgent: 'prebuffer', media: 'video' },
        subscribedAt: hold.since,
        packetsDelivered: 0,
      })
    }

    return {
      rtsp: this.rtspRestreamer.listSessionInfos(),
      audio: this.audioChunkPlane.listSubscribers().map((s) => ({
        tag: s.tag,
        subscribedAt: s.subscribedAt,
        chunksDelivered: s.chunksDelivered,
      })),
      encoded,
      pipeClients: this.pipeServer.getClientCount(),
      encodedSubscribers: this.encodedCallbacks.size + this.rtpVideoCallbacks.size,
    }
  }

  /**
   * Force-disconnect a single consumer. Matches by channel:
   *   - `rtsp`: by `sessionId` (calls `RtspRestreamer.killSession`).
   *   - `audio`: by `tag` — drops every audio subscriber whose tag matches,
   *     then re-evaluates demand.
   * Returns `true` when at least one consumer was dropped.
   */
  killClient(channel: 'rtsp' | 'audio', handle: string): boolean {
    if (channel === 'rtsp') {
      return this.rtspRestreamer.killSession(handle)
    }
    const killed = this.audioChunkPlane.killByTag(handle)
    if (killed === 0) return false
    this.logger?.info('audio subscribers force-disconnected', {
      meta: { handle, killed, remaining: this.audioChunkPlane.subscriberCount },
    })
    this.checkDemand()
    return true
  }

  /**
   * Returns the local TCP URL that restreamers should connect to
   * instead of the camera's RTSP URL. This ensures the broker is
   * the sole reader from the camera.
   */
  getLocalStreamUrl(): string {
    return this.pipeServer.getUrl()
  }

  /**
   * External RTSP restream clients playing on this broker right now — the
   * restream half of the per-camera live-viewer count (`live-viewers.ts`).
   */
  countExternalRestreamViewers(): number {
    return this.rtspRestreamer.countExternalViewers()
  }

  /** Get the RTSP restreamer instance (for RtspListenServer registration) */
  getRtspRestreamer(): RtspRestreamer {
    return this.rtspRestreamer
  }

  /**
   * Set this stream's effective join-burst bound (cluster default merged with
   * the per-camera-stream override). Takes effect on the NEXT join — an
   * in-flight replay is never re-bounded mid-drain, which would punch a hole in
   * the GOP it is delivering.
   */
  setJoinBurstBound(bound: PrimeBurstBound): void {
    this.joinBurstBound = bound
  }

  /** The bound currently in force (diagnostics + tests). */
  getJoinBurstBound(): PrimeBurstBound {
    return this.joinBurstBound
  }

  /** Returns the number of TCP pipe clients currently connected */
  getPipeClientCount(): number {
    return this.pipeServer.getClientCount()
  }

  /**
   * Get the pre-buffer: the most recent N seconds of encoded video packets,
   * starting from the last keyframe. Returns packets in chronological order.
   * Useful for clip creation (get the last N seconds on demand) and
   * late-joining consumers that need to start from a keyframe.
   */
  getPreBuffer(): readonly EncodedPacket[] {
    return this.preBuffer.getPackets()
  }

  /** Set the pre-buffer duration in seconds (clamped to 0..MAX_PRE_BUFFER_SEC). */
  setPreBufferDuration(seconds: number): void {
    const clamped = Math.max(0, Math.min(seconds, StreamBroker.MAX_PRE_BUFFER_SEC))
    this.preBuffer.setDuration(clamped)
    this.logger?.info('Pre-buffer duration set', {
      meta: { seconds: clamped },
    })
  }

  /** Retain `seconds` of AnnexB video for notification clips (0 = stop, frees the ring). */
  setClipRetention(seconds: number): void {
    // NOT `MAX_PRE_BUFFER_SEC`. That ceiling belongs to the RTP pre-buffer on
    // the MAIN stream, where a second is expensive; borrowing it here silently
    // cut a clip retention to 30 s no matter what was asked. The clip ring runs
    // on the cheap profile and is bounded by BYTES
    // ({@link CLIP_RING_MAX_BYTES}), which is the axis its cost actually lives
    // on — so its time limit only has to be past any plausible ask.
    const clamped = Math.max(0, Math.min(seconds, StreamBroker.MAX_CLIP_RETENTION_SEC))
    if (clamped === this.clipRetentionSec) return
    const previous = this.clipRetentionSec
    this.clipRetentionSec = clamped
    // SAID OUT LOUD, because this number decides whether a notification can
    // carry a clip at all — and it was the one buffer in this file that armed
    // itself silently while its sibling `setPreBufferDuration` logged. The
    // operator and I could not settle whether the clip window was 5 s or 25 s
    // from anything the running system said; the answer had to be read out of
    // the source, which is not an answer about a RUNTIME value. `requested` is
    // carried beside the clamp so a value cut down by MAX_PRE_BUFFER_SEC does
    // not look like the one that was asked for.
    // `tags.deviceId` so the line groups with the manager's `clip retention set
    // from the notification rules` (which names the SOURCE of the ask: rules,
    // observed, or the unknown-camera default) — together they say who asked
    // this broker for how many seconds, and what that may cost.
    this.logger?.info(clamped === 0 ? 'Clip retention off' : 'Clip retention set', {
      tags: { deviceId: this.numericDeviceId },
      meta: {
        seconds: clamped,
        requested: seconds,
        previousSeconds: previous,
        capBytes: StreamBroker.CLIP_RING_MAX_BYTES,
      },
    })
    if (clamped === 0) {
      this.clipBuffer = null
      return
    }
    if (this.clipBuffer) this.clipBuffer.setDuration(clamped)
    else this.clipBuffer = new EncodedRingBuffer(clamped, StreamBroker.CLIP_RING_MAX_BYTES)
  }

  /**
   * Seconds this stream's clip ring is currently holding. `0` = no ring.
   *
   * A READ of what was applied, for the manager's own bound (how long a cut may
   * wait for its post-roll) and for the tests that pin the retention a camera's
   * notification rules ask for.
   */
  getClipRetentionSec(): number {
    return this.clipRetentionSec
  }

  /**
   * The retained clip window, oldest first. Empty when retention is off.
   *
   * `getAllPackets`, not `getPackets`: the latter cuts at the most recent
   * keyframe, which is exactly the pre-roll a clip around a past instant needs.
   */
  getClipBuffer(): readonly EncodedPacket[] {
    return this.clipBuffer?.getAllPackets() ?? []
  }

  /** Get the current pre-buffer duration in seconds. */
  getPreBufferDuration(): number {
    return this.preBuffer.getDuration()
  }

  private startRtspReader(source: StreamSource): void {
    this.startNativeRtspReader(source)
  }

  /**
   * Native RTMP reader — pulls media from an RTMP URL, demuxes FLV tags
   * into AnnexB access units, and routes them through `pushEncodedPacket`
   * (same fan-out as Reolink Baichuan push sources).
   *
   * Codec support: H.264 standard FLV + H.265 Enhanced FLV (FOURCC
   * 'hvc1' / 'hev1'). Audio: AAC only — non-AAC tracks are skipped.
   *
   * On terminal error: schedules a reconnect with the same exponential
   * backoff used by the RTSP path.
   */
  private startRtmpReader(source: StreamSource): void {
    this.logger?.info('starting RTMP reader', {
      meta: { url: maskUrlCredentials(source.url) },
    })

    this.destroyRtmpReader()

    const reader = new RtmpReader(source.url, this.logger?.child('rtmp'), {
      onVideoCodec: (codec) => {
        this.detectedCodec = codec
        this.logger?.info('rtmp: video codec detected', { meta: { codec } })
      },
      onEncodedPacket: (packet) => {
        if (this.stopping) return
        this.pushEncodedPacket(packet)
      },
      onAudioInfo: (info) => {
        if (this.stopping) return
        this.pushAudioInfo(info)
      },
      onPlaying: () => {
        this.logger?.info('rtmp: streaming')
        this._status = 'streaming'
        this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
        this.nextDialAllowedAt = 0
        this.stopErrorPlaceholder()
      },
      onError: (error) => {
        if (this.manualStop) return
        this.logger?.warn('rtmp error', { meta: { error: error.message } })
        this.destroyRtmpReader()
        this._status = 'error'
        this.scheduleReconnect()
      },
      onTeardown: () => {
        this.rtmpReader = null
      },
    })

    this.rtmpReader = reader

    reader.connect().catch((err) => {
      if (this.manualStop || this._suspended) return
      this.logger?.warn('rtmp connect failed', {
        meta: { error: errMsg(err), ...this.sourceMetaForLog() },
      })
      this.destroyRtmpReader()
      this._status = 'error'
      this.scheduleReconnect()
    })
  }

  private destroyRtmpReader(): void {
    if (this.rtmpReader) {
      this.rtmpReader.destroy()
      this.rtmpReader = null
    }
  }

  /**
   * "ffmpeg parser" ingress: pull the RTSP/RTMP source THROUGH ffmpeg
   * (`-c copy` → MPEG-TS on stdout) and re-inject the demuxed packets via the
   * broker's push ingress. Mirrors {@link startRtmpReader} — same callback
   * wiring + reconnect/backoff loop — but spawns {@link FfmpegSourceReader}
   * instead of a native TS client. Selected when `source.ffmpegParser` is set.
   */
  private startFfmpegSourceReader(source: StreamSource): void {
    this.logger?.info('starting ffmpeg source reader', {
      meta: {
        url: maskUrlCredentials(source.url),
        transport: source.ffmpegParser?.transport ?? 'tcp',
      },
    })

    this.destroyFfmpegSourceReader()

    const ffmpegPath = this.ffmpegBinaryPathSource()
    if (ffmpegPath === null) {
      // Named, per camera, and terminal for this dial — never a PATH `ffmpeg`
      // in place of the pinned one (D540).
      this.logger?.error('ffmpeg source reader refused — no pinned ffmpeg on this node (D540)', {
        ...(this.numericDeviceId === undefined ? {} : { tags: { deviceId: this.numericDeviceId } }),
        meta: { url: maskUrlCredentials(source.url) },
      })
      this._status = 'error'
      // Ask for the binary again, and retry the dial on the ordinary bounded
      // reconnect backoff: the next attempt reads the manager's live config
      // (`setFfmpegBinaryPathSource`), which a successful re-resolve updates.
      this.ffmpegMissingHandler?.()
      this.scheduleReconnect()
      return
    }

    const parser = source.ffmpegParser
    // HTTP-FLV (`type: 'flv'`) and other http sources take the `http`
    // sourceKind so `buildFfmpegSourceReaderArgs` emits NO `-rtsp_transport`
    // flag — ffmpeg selects the demuxer from the URL scheme instead.
    const sourceKind: 'rtsp' | 'rtmp' | 'http' =
      source.type === 'rtmp'
        ? 'rtmp'
        : source.type === 'flv' || source.type === 'http'
          ? 'http'
          : 'rtsp'
    const args = buildFfmpegSourceReaderArgs({
      sourceUrl: source.url,
      sourceKind,
      transport: parser?.transport ?? 'tcp',
      ...(parser?.inputArgs ? { inputArgs: parser.inputArgs } : {}),
      ...(parser?.outputArgs ? { outputArgs: parser.outputArgs } : {}),
    })

    const reader = new FfmpegSourceReader(
      {
        ffmpegPath,
        args,
        ...(this.logger ? { logger: this.logger.child('ffmpeg-source') } : {}),
        // This ingest pulls ONE camera's source. The broker knows which, so
        // the claim is taken here rather than deduced later. `numericDeviceId`
        // undefined (a broker id that is not `<id>/<stream>`) means the camera
        // cannot be named — no claim, and the process stays unattributed,
        // which is the true statement.
        claimCost: (pid) => this.claimIngestCost(pid),
      },
      {
        onVideoCodec: (codec) => {
          this.detectedCodec = codec
          this.logger?.info('ffmpeg source: video codec detected', {
            meta: { codec },
          })
        },
        onEncodedPacket: (packet) => {
          if (this.stopping) return
          this.pushEncodedPacket(packet)
        },
        onAudioInfo: (info) => {
          if (this.stopping) return
          this.pushAudioInfo(info)
        },
        onPlaying: () => {
          this.logger?.info('ffmpeg source: streaming')
          this._status = 'streaming'
          this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
          this.nextDialAllowedAt = 0
          this.stopErrorPlaceholder()
        },
        onError: (error) => {
          if (this.manualStop) return
          this.logger?.warn('ffmpeg source error', {
            meta: { error: error.message },
          })
          this.destroyFfmpegSourceReader()
          this._status = 'error'
          this.scheduleReconnect()
        },
        onTeardown: () => {
          this.ffmpegSourceReader = null
        },
      },
    )

    this.ffmpegSourceReader = reader
    reader.connect()
  }

  private destroyFfmpegSourceReader(): void {
    if (this.ffmpegSourceReader) {
      this.ffmpegSourceReader.destroy()
      this.ffmpegSourceReader = null
    }
  }

  /**
   * Native RTSP reader: connect directly to the camera, receive raw RTP.
   *
   * - Preserves RTP framing (no Annex-B corruption on low-bitrate streams)
   * - RTP passthrough to RTSP restreamer (zero re-packetization)
   * - No ffprobe needed (codec detected from SDP DESCRIBE)
   * - Lower latency (no ffmpeg buffering/probing)
   * - Native G.711 audio decode (PCMU/PCMA → PCM f32le 16kHz)
   *
   * On error: reconnects with exponential backoff, emits placeholder frames.
   */
  /**
   * Shared RTP-stream callback factory. Used by both the native RTSP
   * reader and the RFC 4571 reader — they ingest RTP from different
   * transports but the broker's downstream pipeline (depacketize →
   * AnnexB → prebuffer / pipe / restream) is identical.
   *
   * `label` is the source-tag we attach to log messages so it's clear
   * which transport surfaced the event. `onTerminate` is the
   * transport-specific cleanup invoked from `onError` (the native client
   * runs `destroyNativeClient`; the RFC 4571 reader closes the TCP
   * socket and clears its handle).
   */
  private buildRtpStreamCallbacks(
    label: string,
    onTerminate: () => void,
    isStale?: () => boolean,
  ): import('../rtsp/rtsp-client.js').RtspClientCallbacks {
    return {
      onVideoTrack: (track, sdpText) => {
        this.detectedCodec = track.codec
        this.logger?.info('native: video track detected', {
          meta: {
            codec: track.codec,
            payloadType: track.payloadType,
            hasSdpParamSets: Boolean(track.codecParams?.parameterSets?.length),
          },
        })

        // Capture codec parameter sets from SDP. Replay these to any
        // already-registered encoded subscribers so WebRTC sessions
        // that connected before the SDP arrived still get the VPS/
        // SPS/PPS they need to initialise the HEVC decoder.
        if (track.codecParams?.parameterSets?.length) {
          this.sdpParameterSets = track.codecParams.parameterSets.map((p) => Buffer.from(p))
          this.replaySdpParamSetsToEncodedSubscribers()
          this.replaySdpParamSetsToRtpSubscribers()
        }

        // Set up RTP depacketizer for Annex-B output (prebuffer, pipe, restream)
        this.rtpDepacketizer = new RtpDepacketizer(track.codec, (depacketized) => {
          this.handleDepacketizedNal(depacketized)
        })

        // Arm the watchdog: TCP is up + SDP parsed, so we now expect
        // RTP. If nothing arrives, force a reconnect from scratch.
        this.armFirstVideoWatchdog()

        // Switch restreamer to RTP passthrough mode
        this.rtspRestreamer.setCameraSdp(sdpText, track.codec, track.codecParams)
      },

      onVideoRtp: (rtpData) => {
        if (this.stopping) return

        this._status = 'streaming'
        this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
        this.nextDialAllowedAt = 0
        this.stopErrorPlaceholder()
        // First RTP packet of this connection cycle — the watchdog
        // can stand down. Cheap to call when already cancelled.
        this.cancelFirstVideoWatchdog()
        // The cold open COMPLETED, so the extended first-video deadline stops
        // applying. It is cleared here and not only in the watchdog's own
        // stand-down branch, because on a healthy open the watchdog is
        // CANCELLED and that branch never runs — a latch that only clears on
        // the unhealthy path would make 20 s the permanent stall budget for
        // every camera behind a lazy publisher.
        this.materializeRequestedAt = 0
        // Rolling activity watchdog: reset on every packet. Wi-Fi
        // packet-loss stalls on the TCP socket (audio+video share
        // the interleaved channel) show up here as the per-packet
        // gap exceeding RTP_ACTIVITY_TIMEOUT_MS; the expiry tears
        // the reader down so scheduleReconnect rebuilds the source.
        this.kickRtpActivityWatchdog()

        // Diagnostic milestones: same cadence as `audio: rtp packet
        // received` so a wake-up cycle that brings audio back but
        // never video is visible side-by-side in the log. Without
        // this, on a battery cam wake-up there's no signal between
        // "rfc4571: streaming" and "decoder push" — we can't tell
        // if the camera is silent or only the consumer pipeline is
        // misconfigured.
        this.videoRtpSeen++
        if (this.videoRtpSeen === 1 || this.videoRtpSeen === 50) {
          this.logger?.info('video: rtp packet received', {
            meta: { seq: this.videoRtpSeen, bytes: rtpData.length },
          })
        }

        // Every packet is CLASSIFIED (what it carries, from its payload headers);
        // NALs are reassembled and access units built only while something
        // consumes the Annex-B plane. With no encoded subscriber, pipe client or
        // clip ring the plane is idle and the source RTP is copied exactly once
        // (into the ring, below) — the NAL copy and the AU concat were the two
        // largest allocation sites of a broker nobody was watching through it.
        const wantPlane = this.needsAnnexBPlane()
        if (!wantPlane && this.annexBPlaneActive) this.idleAnnexBPlane()
        const carried: RtpPacketClass | null = this.annexBPlaneActive
          ? (this.rtpDepacketizer?.processPacket(rtpData) ?? null)
          : (this.rtpDepacketizer?.classifyPacket(rtpData) ?? null)
        this._lastNalKeyframe = carried?.keyframe ?? false
        this._lastNalParamSet = carried?.parameterSet ?? false

        // Flags judged per ACCESS UNIT, not per completed NAL: every fragment of
        // a fragmented IDR, and a prefix SEI inside the picture, is "part of the
        // keyframe AU" — which is what the restreamer's keyframe cache collects
        // and what a backlog-latched session resumes on.
        const auFlags = carried ? this.rtpAuTracker.classify(carried) : null
        if (wantPlane && !this.annexBPlaneActive && auFlags?.keyframeAuStart === true) {
          // A consumer attached mid-GOP: start building at the keyframe access
          // unit THIS packet opens, so the first EncodedPacket it sees decodes.
          this.armAnnexBPlane()
          this.rtpDepacketizer?.processPacket(rtpData)
        }
        if (auFlags) {
          this.recordVideoStats(rtpData.length, auFlags.pictureStart, auFlags.keyframeAu)
        }

        // Forward raw RTP to RTSP restreamer (zero re-packetization).
        this.rtspRestreamer.pushRtpPassthrough(
          rtpData,
          auFlags?.keyframeAu ?? false,
          auFlags?.parameterSet ?? false,
        )

        // Capture into the source-RTP pre-buffer (current GOP) BEFORE the
        // fan-out, so a subscriber that bootstraps from it sees the current
        // packet as the ring's tail. Keyframe flags were set by the
        // depacketizer above.
        this.captureRtpForPreBuffer(rtpData)

        // Fan out source RTP to direct-RTP subscribers (WebRTC
        // H.265 path uses this to feed a packet-level repacketizer).
        if (this.rtpVideoCallbacks.size > 0) {
          for (const [cb, entry] of this.rtpVideoCallbacks) {
            try {
              cb(rtpData)
              entry.packetsDelivered += 1
            } catch (err) {
              this.reportThrottled(
                'rtp video subscriber threw — packet dropped for that consumer',
                {
                  subscriberId: entry.id,
                  kind: entry.attribution.kind,
                  error: errMsg(err),
                },
              )
            }
          }
        }
      },

      onAudioTrack: (audioTrack) => {
        const codecUpper = audioTrack.codec.toUpperCase()
        this.audioCodec = codecUpper
        const supportedNative = codecUpper === 'PCMU' || codecUpper === 'PCMA'

        // Diagnostic: surface SDP fmtp keys + audio-codec cap availability
        // so we can tell at a glance why the broker did or didn't pick the
        // cap path for this camera.
        // `tags.deviceId`: "which cameras speak PCMU and which PCMA" is asked
        // per-camera and cannot be answered from a line that omits it — and
        // after D459 it is the input to re-calibrating that camera's absolute
        // dBFS thresholds, so it stopped being a curiosity.
        this.logger?.info('audio: track detected', {
          tags: { deviceId: this.numericDeviceId },
          meta: {
            codec: audioTrack.codec,
            codecUpper,
            clockRate: audioTrack.clockRate,
            channels: audioTrack.channels,
            fmtpKeys: Object.keys(audioTrack.fmtp),
            hasConfigHex: 'config' in audioTrack.fmtp || 'CONFIG' in audioTrack.fmtp,
            audioCodecApiAvailable: this.audioCodecApi !== null,
            supportedNative,
          },
        })

        // Remember the shape so a SENTRY dialed while this camera is ASLEEP can
        // still be handed an audio track to fill (D525). This is the only place
        // the camera's own SDP is parsed, and a sleeping camera has none — so
        // if it is not captured here it is not captured at all. `null` for a
        // codec whose silence cannot be generated exactly; the restreamer says
        // so, per camera, rather than guessing at G.711.
        const sentryTrack = g711TrackFor(codecUpper)
        this.rtspRestreamer.retainSentryAudioTrack(sentryTrack)
        if (sentryTrack === null) {
          this.logger?.info('sentry audio: codec cannot be filled — a sentry gets no audio', {
            tags: { deviceId: this.numericDeviceId },
            meta: { codec: codecUpper },
          })
        }

        let supported = supportedNative
        let effectiveSampleRate = audioTrack.clockRate
        let effectiveChannels = audioTrack.channels

        if (supportedNative) {
          this.audioRtpDecoder = new AudioRtpDecoder(codecUpper as AudioCodec, (chunk) => {
            this.audioChunkPlane.fanout(chunk)
          })
          // The plane carries the SOURCE rate (D450) AND the SOURCE bytes
          // (D455): 8 kHz, one G.711 byte per sample. The line says so, so a
          // consumer that expected 16 kHz f32le can be answered from the log
          // rather than guessed at. What each SUBSCRIPTION is actually served
          // is a different line, on the plane itself (`audio-chunk
          // subscription serving`), because it depends on what that consumer
          // declared it can read.
          this.logger?.info('native: audio decoder initialized', {
            tags: { deviceId: this.numericDeviceId },
            meta: {
              codec: codecUpper,
              sampleRate: audioTrack.clockRate,
              channels: audioTrack.channels,
              planeSampleRate: G711_SAMPLE_RATE,
              planeFormat: codecUpper === 'PCMA' ? 'pcma' : 'pcmu',
              // The amplitude this camera's levels used to be LOW by, before
              // D459 corrected the decode tables. It is stated here rather
              // than inferred later because this is the only line in the
              // system that knows which of the two G.711 laws this camera
              // speaks — the chunk plane does not carry the codec.
              preD459LevelDeficitDb:
                Math.round(
                  G711_SCALE_CORRECTION_DB[codecUpper === 'PCMA' ? 'PCMA' : 'PCMU'] * 100,
                ) / 100,
            },
          })
        } else if (this.audioCodecApi) {
          const capCfg = this.buildAudioCodecSessionConfig(audioTrack)
          if (capCfg) {
            effectiveSampleRate = capCfg.sourceSampleRate
            effectiveChannels = capCfg.sourceChannels
            supported = true
            // Tear down any prior session before replacing — without
            // this an RTSP reconnect leaks the previous AudioCodecSession
            // (its poll timer keeps ticking and its upstream cap session
            // lingers until idle reap).
            if (this.audioCodecSession) {
              const prior = this.audioCodecSession
              this.audioCodecSession = null
              void prior.close().catch((err) => {
                this.logger?.debug('audio-codec: prior RTSP session close failed', {
                  meta: { error: errMsg(err) },
                })
              })
            }
            this.audioCodecSession = new AudioCodecSession(
              this.audioCodecApi,
              capCfg,
              this.buildAudioCodecEmitCallback(),
              this.logger?.child('audio-codec'),
              () => this.encodedCallbacks.size > 0,
            )
            this.logger?.info('audio-codec: decode session armed', {
              meta: {
                codec: capCfg.codec,
                sourceSampleRate: capCfg.sourceSampleRate,
                sourceChannels: capCfg.sourceChannels,
                rfc3640: capCfg.rfc3640 ? 'aac-hbr' : 'one-frame',
              },
            })
          } else {
            this.logger?.info('audio-codec: codec not handled by cap — audio skipped', {
              meta: {
                codec: audioTrack.codec,
                sampleRate: audioTrack.clockRate,
                channels: audioTrack.channels,
              },
            })
          }
        } else {
          this.logger?.info('native: audio codec not supported natively — audio skipped', {
            meta: {
              codec: audioTrack.codec,
              sampleRate: audioTrack.clockRate,
              channels: audioTrack.channels,
            },
          })
        }

        this.audioTrackInfo = {
          codec: codecUpper,
          sampleRate: effectiveSampleRate,
          channels: effectiveChannels,
          supported,
        }
      },

      onAudioRtp: (rtpData) => {
        if (this.stopping) return
        // Audio shares the same TCP interleaved socket as video — an
        // audio packet is equally good proof the source is alive, so
        // it also resets the rolling activity watchdog.
        this.kickRtpActivityWatchdog()
        // Broker-side mute (D83). The CHEAPEST possible point: before the
        // native depacketizer, before the AAC/Opus decode session, before the
        // µ-law→PCM conversion the Opus egress needs. Nothing is decoded to be
        // discarded. The watchdog kick above stays ABOVE this line — a muted
        // audio plane must not make a live source look dead.
        if (this.audioMuted) {
          this.dropMutedAudio('rtsp-audio-rtp')
          return
        }
        this.audioRtpSeen++
        if (this.audioRtpSeen === 1 || this.audioRtpSeen === 50) {
          this.logger?.info('audio: rtp packet received', {
            meta: {
              seq: this.audioRtpSeen,
              bytes: rtpData.length,
              hasNativeDecoder: this.audioRtpDecoder !== null,
              hasCodecSession: this.audioCodecSession !== null,
            },
          })
        }
        this.audioRtpDecoder?.processPacket(rtpData)
        // Demand-gate the AAC/Opus decode: only feed the audio-codec
        // session (which lazily spins up an upstream decode session +
        // 40ms poll loop + ~50 push / ~25 pull RPCs/s) when an audio
        // consumer is attached. Native PCMU/PCMA still flows via
        // `audioRtpDecoder` above and the `encodedCallbacks` fanout
        // below — both already gated on their own consumer counts.
        if (this.hasAudioConsumer()) {
          this.audioCodecSession?.processPacket(rtpData)
        }

        // Emit raw G.711 audio payload as EncodedPacket so WebRTC and
        // other onEncodedData consumers can forward it without transcoding.
        // ONLY for native codecs (PCMU/PCMA) — AAC/Opus raw RTP payloads
        // are NOT G.711 and must go through audio-codec decode first.
        const isNativeAudioCodec = this.audioCodec === 'PCMU' || this.audioCodec === 'PCMA'
        if (isNativeAudioCodec && this.encodedCallbacks.size > 0 && rtpData.length > 12) {
          // A copy: the EncodedPacket is retained by rings and queues downstream.
          const payload = Buffer.from(rtpData.subarray(12))
          if (payload.length > 0) {
            // Extract RTP timestamp (bytes 4-7, big-endian) for PTS
            const rtpTimestamp = rtpData.readUInt32BE(4)
            const pts = Math.floor(rtpTimestamp / 8) // 8kHz → ms
            const packet: EncodedPacket = {
              type: 'audio',
              data: payload,
              pts,
              dts: pts,
              keyframe: false,
              codec: this.audioCodec?.toLowerCase() ?? 'pcmu',
            }
            this.fanOutEncoded(packet)

            // Live Opus egress for native G.711 sources: decode µ-law/A-law to
            // PCM (f32le) and feed the Opus encoder for Opus-negotiated WebRTC
            // sessions. Additive — the G.711 packet above is untouched. No-op
            // without Opus demand or the audio-codec cap.
            if (this.opusConsumerCount > 0 && this.audioCodecApi) {
              const pcm16 = this.audioCodec === 'PCMA' ? alawToPcm(payload) : mulawToPcm(payload)
              const f32 = new Float32Array(pcm16.length)
              for (let i = 0; i < pcm16.length; i++) f32[i] = pcm16[i]! / 0x8000
              this.feedOpusEncoder({
                data: Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength),
                sampleRate: 8000,
                channels: 1,
                timestamp: pts,
              })
            }
          }
        }

        // Forward raw audio RTP to RTSP restreamer for audio passthrough
        this.rtspRestreamer.pushAudioRtpPassthrough(rtpData)
      },

      onPlaying: () => {
        this.logger?.info(`${label}: streaming`)
        this._status = 'streaming'
      },

      onError: (error) => {
        if (this.manualStop) return
        this.logger?.warn(`${label} error`, {
          meta: {
            error: error.message,
            ...this.sourceMetaForLog(),
          },
        })
        onTerminate()
        this._status = 'error'
        // rfc4571 sources are loopback to a publisher-owned TCP
        // server. A read error after the lib's idle teardown means
        // the cached URL is stale — ask the publisher to republish
        // before the next reconnect tick.
        if (this.source?.type === 'rfc4571') {
          this.notifySourceRefresh()
        }
        this.scheduleReconnect()
      },

      onTeardown: () => {
        // A source-side close (clean FIN from a rebooting camera, or the lib's
        // loopback server going away) is a FAILURE EDGE — not a benign event.
        // Before this the close routed through `onTerminate` and returned
        // WITHOUT touching `_status` / `scheduleReconnect` / `notifySourceRefresh`,
        // so the broker latched `status:'streaming'` forever (a phantom state:
        // `onPlaying` sets 'streaming' the instant the loopback TCP opens, not
        // when media flows). This wedge survived every live operator poke.
        //
        // GUARDED by manualStop/stopping: `NativeRtspClient.teardown()` shares
        // this callback and fires on a deliberate stop, which must NOT
        // self-trigger a reconnect.
        if (this.manualStop || this.stopping) return
        // Reader-identity guard: a late close from a SUPERSEDED reader must not
        // tear down the CURRENT one. `onTerminate` → `destroyRfc4571Reader()`
        // destroys whatever reader is current, so without this a stale socket's
        // close would kill the live reader that replaced it.
        if (isStale?.()) return
        onTerminate()
        this._status = 'error'
        this.logger?.warn(`${label}: source closed — treating as failure edge`, {
          tags: { deviceId: this.numericDeviceId },
          meta: { ...this.sourceMetaForLog() },
        })
        // rfc4571 sources are loopback to a publisher-owned TCP server; the lib
        // may have idle-torn-down and rebound on a fresh port, so ask the
        // publisher to re-materialize before the next dial resolves a stale URL,
        // then redial. The native RTSP client only reaches this callback via a
        // deliberate `teardown()` (guarded above), so scheduling a reconnect is
        // scoped to the loopback source that actually needs it.
        if (this.source?.type === 'rfc4571') {
          this.notifySourceRefresh()
          this.scheduleReconnect()
        }
      },
    }
  }

  private startNativeRtspReader(source: StreamSource): void {
    this.logger?.info('starting native RTSP reader')

    const client: NativeRtspClient = new NativeRtspClient(
      {
        url: source.url,
        logger: this.logger?.child('rtsp-native'),
        packetAllocator: this.packetAllocator,
      },
      this.buildRtpStreamCallbacks(
        'native RTSP',
        () => this.destroyNativeClient(),
        () => this.nativeClient !== client,
      ),
    )

    this.nativeClient = client

    client.connect().catch((err) => {
      if (this.manualStop || this._suspended) return
      this.logger?.warn('native RTSP connect failed', {
        meta: { error: errMsg(err), ...this.sourceMetaForLog() },
      })
      this.destroyNativeClient()
      this._status = 'error'
      this.scheduleReconnect()
    })

    // Arm the rolling activity watchdog at DIAL time, not at the first received
    // packet: a connection that opens the loopback TCP but never delivers media
    // (the rebooted-camera wedge) is otherwise invisible — `onPlaying` latches
    // 'streaming' the instant the socket connects. Armed here, an 8s silence
    // forces a teardown + redial. Kicked forward on every subsequent RTP packet.
    this.kickRtpActivityWatchdog()
  }

  /**
   * Handle a complete NAL from the RTP depacketizer.
   * Converts to EncodedPacket and feeds all Annex-B consumers
   * (prebuffer, pipe server, restreamers).
   *
   * Called synchronously from processPacket — sets _lastNalKeyframe and
   * _lastNalParamSet so the onVideoRtp callback can forward them to the
   * RTSP restreamer's pushRtpPassthrough.
   */
  /**
   * Groups the depacketizer's NALs into access units — ONE `EncodedPacket`
   * per picture, parameter sets welded onto the keyframe picture they
   * precede. See `access-unit-assembler.ts` for the boundary rule and the
   * per-NAL emit it replaced.
   */
  private readonly annexBAssembler = new AccessUnitAssembler((accessUnit) =>
    this.emitAccessUnit(accessUnit),
  )

  /** Access-unit membership of the source RTP packets, for the restreamer's flags. */
  private readonly rtpAuTracker = new RtpAccessUnitTracker()

  /**
   * handleDepacketizedNal receives individual NALs from the RTP depacketizer
   * and hands them to the access-unit assembler, which emits one
   * `EncodedPacket` per PICTURE (`emitAccessUnit`) — never per NAL. A
   * multi-slice IDR, its parameter sets and its prefix SEI are one keyframe
   * packet; three P slices are one P packet.
   *
   * The RTSP restreamer forwards source RTP separately (`onVideoRtp`) and is
   * not fed from here.
   */
  private handleDepacketizedNal(depacketized: DepacketizedNal): void {
    this.annexBAssembler.push(depacketized)
  }

  /**
   * Does anything consume the Annex-B plane right now? An encoded subscriber
   * (WebRTC Annex-B, fragments, a decode session), a pipe client, a clip ring
   * (it retains access units continuously, so it needs them built even with
   * nobody attached), or a restreamer still in Annex-B mode (no camera SDP yet).
   * The RTSP restream and the WebRTC RTP path are served from the source RTP
   * and never count. Cheap — four field reads — because it runs per packet.
   */
  private needsAnnexBPlane(): boolean {
    return (
      this.encodedCallbacks.size > 0 ||
      this.clipBuffer !== null ||
      this.pipeServer.getClientCount() > 0 ||
      !this.rtspRestreamer.rtpPassthroughMode
    )
  }

  /** The consumers that want the plane, for the arm/idle lines. */
  private annexBPlaneConsumers(): Record<string, number | boolean> {
    return {
      encodedSubscribers: this.encodedCallbacks.size,
      clipRing: this.clipBuffer !== null,
      pipeClients: this.pipeServer.getClientCount(),
      restreamerAnnexB: !this.rtspRestreamer.rtpPassthroughMode,
    }
  }

  /**
   * Start building access units from the keyframe AU the current packet opens.
   * The depacketizer and the assembler are clean here (reset when the plane
   * went idle, or never used), so nothing stale precedes that keyframe.
   */
  private armAnnexBPlane(): void {
    this.annexBPlaneActive = true
    this.logger?.info('annex-b plane armed at a keyframe access unit', {
      tags: { deviceId: this.numericDeviceId },
      meta: this.annexBPlaneConsumers(),
    })
  }

  /**
   * Stop building access units: the last consumer left. The picture in
   * progress is dropped, not flushed — there is nobody to hand it to, and a
   * partial picture must never reach the next consumer's clean start. Logged,
   * once per transition: a plane that is idle on purpose must not read as a
   * stream that stopped.
   */
  private idleAnnexBPlane(): void {
    this.annexBPlaneActive = false
    this.rtpDepacketizer?.reset()
    this.annexBAssembler.reset()
    this.logger?.info('annex-b plane idle — no consumer, NAL reassembly skipped', {
      tags: { deviceId: this.numericDeviceId },
    })
  }

  /**
   * One place for the input stats, fed from whichever path owns the pictures:
   * the source RTP packets while the native reader is up (`onVideoRtp`), the
   * `EncodedPacket`s otherwise (`pushEncodedPacket`). `bytes` accumulate per
   * call; `inputFps`, `packetCount` and the IDR interval advance once per
   * picture — the window is closed on a picture start so a window of N frames
   * reads N, exactly as it did when every call was one access unit.
   */
  private recordVideoStats(bytes: number, pictureStart: boolean, keyframe: boolean): void {
    this.totalBytes += bytes
    this.bytesInWindow += bytes
    if (!pictureStart) return
    this.packetCount++
    this.packetsInWindow++
    const now = Date.now()
    this.lastPacketAt = now

    const windowMs = now - this.windowStartMs
    if (windowMs >= 2000) {
      this.bitrateKbps = Math.round((this.bytesInWindow * 8) / windowMs)
      this.encodedInputFps = (this.packetsInWindow / windowMs) * 1000
      this.bytesInWindow = 0
      this.packetsInWindow = 0
      this.windowStartMs = now
    }

    if (keyframe) {
      if (this.lastKeyframeMs > 0) {
        this.idrIntervalMs = now - this.lastKeyframeMs
      }
      this.lastKeyframeMs = now
    }
  }

  /**
   * One assembled access unit → one `EncodedPacket` for every Annex-B
   * consumer (prebuffer, clip ring, pipe, WebRTC). A keyframe packet is
   * self-contained (VPS/SPS/PPS + every IDR slice), which is what a decoder
   * initialises from and what a clip or a pre-roll window may start at.
   */
  private emitAccessUnit(accessUnit: AssembledAccessUnit): void {
    const codec = this.detectedCodec ?? 'h264'
    const pts = Math.floor(accessUnit.timestamp / 90) // 90kHz → ms

    const packet: EncodedPacket = {
      type: 'video',
      data: accessUnit.annexB,
      pts,
      dts: pts,
      keyframe: accessUnit.keyframe,
      codec,
    }

    this.pushEncodedPacket(packet)
  }

  /**
   * Start emitting a pre-encoded H.264 keyframe at 1fps for an
   * explicit `placeholder`-typed source (i.e. disabled / not-yet-
   * configured cameras). The default reason is `'disabled'` because
   * the only path that reaches this is "operator turned the device
   * off" or "device was created without credentials"; callers who
   * arrive here via a different upstream state can adjust reason via
   * `setPlaceholderReason()` before calling.
   *
   * Frame is re-resolved on every tick from `placeholderReason` so
   * upstream state transitions (`disabled` → `offline`, etc.) propagate
   * within one second.
   */
  private startPlaceholderReader(_source: StreamSource): void {
    this.logger?.debug('Starting placeholder')

    if (this.placeholderReason === 'reconnecting') {
      // Default the reason to `'disabled'` for the explicit placeholder
      // source, but only if the caller hasn't already set something
      // more specific.
      this.placeholderReason = 'disabled'
    }
    this._status = 'streaming'

    // Emit immediately
    this.emitPlaceholderFrame()

    // Re-emit at 1fps so consumers see an active stream
    this.placeholderTimer = setInterval(() => {
      if (this.manualStop || this.stopping) {
        if (this.placeholderTimer) {
          clearInterval(this.placeholderTimer)
          this.placeholderTimer = undefined
        }
        return
      }
      this.emitPlaceholderFrame()
    }, 1000)
  }

  /**
   * Resolve the codec the placeholder frame should be encoded as.
   * Picks the broker's currently-detected codec when a reader has
   * already parsed the camera's SDP, otherwise falls back to the
   * source's published codec, otherwise H.264. The choice MUST match
   * the negotiated WebRTC session codec — sending an H.264 placeholder
   * over an H.265 RTP track corrupts the decoder state on Chrome and
   * leaves the viewer frozen on the last placeholder until the
   * session is recreated. Mirroring the broker codec keeps the
   * placeholder feed bit-stream-compatible across the same path the
   * live camera uses.
   */
  private placeholderCodec(): PlaceholderCodec {
    const codec = (this.detectedCodec ?? this.source?.videoCodec ?? '').toLowerCase()
    if (codec === 'h265' || codec === 'hevc') return 'h265'
    return 'h264'
  }

  /**
   * Push the current placeholder frame (selected by `placeholderReason`
   * + `placeholderCodec()`) to all encoded subscribers. No-op-safe to
   * call from any timer.
   */
  private emitPlaceholderFrame(): void {
    const codec: PlaceholderCodec = this.placeholderCodec()
    const packet: EncodedPacket = {
      type: 'video',
      data: getPlaceholderFrame(this.placeholderReason, codec),
      pts: Date.now(),
      dts: Date.now(),
      keyframe: true, // single-frame encode is always a keyframe
      codec,
      // Tag so consumers (notably the WebRTC encoded-data subscriber,
      // which keeps a sticky SPS/PPS to prepend to keyframes lacking
      // inline param sets) can drop the packet's parameter sets from
      // any per-stream cache they maintain. Without this tag, a
      // 1280×720 placeholder SPS gets prepended to the camera's real
      // (different resolution) IDR and Chrome's decoder freezes on
      // the last placeholder frame until the user manually restarts.
      isPlaceholder: true,
    }
    this.pushEncodedPacket(packet)
  }

  // ── First-video watchdog ──────────────────────────────────────────

  /**
   * Arm the first-video watchdog. Called when the rfc4571 reader
   * reports a working SDP (`onVideoTrack`), at which point the broker
   * has a live TCP connection to the lib's loopback server and is
   * waiting for the upstream Baichuan dedicated session to start
   * pushing RTP. No-op when already armed (so duplicate `onVideoTrack`
   * fires don't reset the timer).
   */
  private armFirstVideoWatchdog(): void {
    if (this.firstVideoWatchdog) return
    if (this.manualStop || this.stopping) return
    const timeoutMs = this.firstVideoTimeoutMs()
    this.firstVideoWatchdog = setTimeout(() => {
      this.firstVideoWatchdog = undefined
      if (this.manualStop || this.stopping) return
      // Race-safe check: a packet may have arrived between the timer
      // firing and this callback running. Be permissive — but SAY SO. A
      // silent return reads as "never fired", and with the per-dial reset
      // of `videoRtpSeen` this branch now means "video really did flow on
      // THIS connection", which is a stand-down worth a log line.
      if (this.videoRtpSeen > 0) {
        // The cold open completed. Clear the latch so the NEXT stall on this
        // stream is judged by the ordinary deadline: a materialize is a
        // one-shot event, and a latch that never clears would turn a permanent
        // 20 s into the stall-detection budget for a healthy camera.
        this.materializeRequestedAt = 0
        this.logger?.info('first-video watchdog: video flowing — standing down', {
          tags: { deviceId: this.numericDeviceId },
          meta: {
            videoRtpSeen: this.videoRtpSeen,
            ...this.sourceMetaForLog(),
          },
        })
        return
      }
      this.logger?.warn(
        'first-video watchdog: no video RTP after source connect — forcing reconnect',
        {
          tags: { deviceId: this.numericDeviceId },
          meta: {
            timeoutMs,
            ...this.sourceMetaForLog(),
          },
        },
      )
      // Tear down the reader → lib detects TCP close → releases its
      // dedicated session → next dial triggers a fresh session. This
      // mirrors the user's "click restart" workaround.
      this.destroyRfc4571Reader()
      this._status = 'error'
      // Treat this as a fresh recovery cycle rather than a continuation
      // of an exponential-backoff sequence — the user noticed the
      // stuck state after wake-up, the manual restart resets backoff,
      // and we're emulating that.
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
      this.nextDialAllowedAt = 0
      this.lastRefreshRequestAt = 0
      // Provider refresh is a LOOPBACK concern only: the misleading
      // `rfc4571`-in-the-message log used to fire (and this refresh used to
      // round-trip) even for a native RTSP broker, which has no publisher to
      // republish. Siblings (`onError`, the activity-watchdog expiry) already
      // gate this on the source type; match them.
      if (this.source?.type === 'rfc4571') {
        this.notifySourceRefresh()
      }
      this.scheduleReconnect()
    }, timeoutMs)
  }

  /**
   * The first-video deadline for the dial being armed.
   *
   * Extended for a dial that FOLLOWED a lazy materialize we asked for — see
   * {@link LAZY_MATERIALIZE_FIRST_VIDEO_TIMEOUT_MS}. It reads the SAME fact the
   * dial loop uses (`materializeRequestedAt`), so a cold open cannot be "in
   * progress" for one and "not happening" for the other.
   */
  private firstVideoTimeoutMs(): number {
    if (this.materializeRequestedAt === 0) return StreamBroker.FIRST_VIDEO_TIMEOUT_MS
    const sinceMs = Date.now() - this.materializeRequestedAt
    return sinceMs < StreamBroker.MATERIALIZE_RECENT_MS
      ? StreamBroker.LAZY_MATERIALIZE_FIRST_VIDEO_TIMEOUT_MS
      : StreamBroker.FIRST_VIDEO_TIMEOUT_MS
  }

  /** Cancel the first-video watchdog. Idempotent. */
  private cancelFirstVideoWatchdog(): void {
    if (!this.firstVideoWatchdog) return
    clearTimeout(this.firstVideoWatchdog)
    this.firstVideoWatchdog = undefined
  }

  // ── Rolling RTP activity watchdog ─────────────────────────────────

  /**
   * Kick the rolling source-RTP activity watchdog: cancel any prior arm
   * and schedule a fresh expiry. Called per RTP packet from the native
   * RTSP reader, the RFC 4571 reader, AND `pushVideoRtp` so push-rtp
   * sources stay covered by the same arm/cancel lifecycle (the expiry
   * path is reader-aware — it does nothing when no reader is alive).
   *
   * ALLOCATION-FREE per packet: it stamps {@link lastRtpActivityAt} and
   * arms ONE {@link StreamBroker.RTP_ACTIVITY_SWEEP_MS} interval the first
   * time. Do not turn this back into a per-packet `clearTimeout` +
   * `setTimeout` — that is a `Timeout` allocation and two libuv timer-heap
   * operations on the highest-frequency path in the busiest process.
   */
  private kickRtpActivityWatchdog(): void {
    if (this.manualStop || this.stopping || this._suspended) {
      // Packets are arriving at a broker that believes it is suspended, so the
      // stall watchdog is never armed for them: this source can go silent
      // afterwards and nothing will notice. Said ONCE per episode — this is the
      // per-packet path and a line here would be a line per packet — and reset
      // by the next real arm.
      if (this._suspended && !this.suspendedActivityNoted) {
        this.suspendedActivityNoted = true
        this.logger?.warn(
          'source RTP is arriving while this broker is suspended — the stall watchdog is NOT armed for it',
          {
            ...(this.numericDeviceId === null ? {} : { tags: { deviceId: this.numericDeviceId } }),
            meta: { brokerId: this.deviceId, status: this._status },
          },
        )
      }
      return
    }
    this.suspendedActivityNoted = false
    this.lastRtpActivityAt = Date.now()
    if (this.rtpActivitySweep !== undefined) return
    this.rtpActivitySweep = setInterval(() => {
      this.sweepRtpActivity()
    }, StreamBroker.RTP_ACTIVITY_SWEEP_MS)
    this.rtpActivitySweep.unref?.()
  }

  /**
   * One sweep: declare the stall only once the full
   * {@link StreamBroker.RTP_ACTIVITY_TIMEOUT_MS} of silence has actually
   * elapsed since the last packet.
   */
  private sweepRtpActivity(): void {
    if (this.lastRtpActivityAt === 0) return
    if (Date.now() - this.lastRtpActivityAt < StreamBroker.RTP_ACTIVITY_TIMEOUT_MS) return
    this.cancelRtpActivityWatchdog()
    this.onRtpActivityWatchdogExpired()
  }

  /** Cancel the rolling RTP activity watchdog. Idempotent. */
  private cancelRtpActivityWatchdog(): void {
    this.lastRtpActivityAt = 0
    if (this.rtpActivitySweep === undefined) return
    clearInterval(this.rtpActivitySweep)
    this.rtpActivitySweep = undefined
  }

  /**
   * Activity watchdog expiry: source RTP went silent for longer than
   * `RTP_ACTIVITY_TIMEOUT_MS`. The TCP socket is still open as far as
   * the OS knows but no data has arrived — typical Wi-Fi packet-loss
   * stall. Tear the reader down ("activity watchdog fired: stream
   * inactivity") so `scheduleReconnect()` rebuilds the source.
   *
   * Only fires for sources that actually have a reader to tear down:
   * native RTSP and RFC 4571. push / push-rtp / RTMP sources are
   * provider-driven and don't go through this lifecycle — they have
   * their own `PUSH_STALL_TIMEOUT_MS` path.
   */
  private onRtpActivityWatchdogExpired(): void {
    // The sweep already disarmed (`cancelRtpActivityWatchdog`) before calling
    // us — this handler never clears the timer itself.
    this.rtpActivityWatchdogFiredCount++
    if (this.manualStop || this.stopping || this._suspended) {
      // The watchdog FIRED and is now disarmed, and this branch then does
      // nothing: no teardown, no reconnect, and — until now — no line. A
      // deliberate stop is not worth a word, but a SUSPENDED broker whose
      // source went silent is exactly the state that looks like a dead stream
      // from the outside, so it says so.
      if (this._suspended) {
        this.logger?.warn(
          'source RTP went silent on a suspended broker — the watchdog is disarmed and nothing will reconnect it',
          {
            ...(this.numericDeviceId === null ? {} : { tags: { deviceId: this.numericDeviceId } }),
            meta: {
              brokerId: this.deviceId,
              timeoutMs: StreamBroker.RTP_ACTIVITY_TIMEOUT_MS,
              firedCount: this.rtpActivityWatchdogFiredCount,
            },
          },
        )
      }
      return
    }

    const meta = {
      timeoutMs: StreamBroker.RTP_ACTIVITY_TIMEOUT_MS,
      ...this.sourceMetaForLog(),
    }
    this.logger?.warn(
      'source-RTP activity watchdog: no packets within window — forcing reconnect',
      { meta },
    )

    if (this.nativeClient) {
      if (this.streamingDebug) {
        this.logger?.info('activity watchdog: destroying native RTSP reader', {
          meta,
        })
      }
      this.destroyNativeClient()
      this._status = 'error'
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
      this.nextDialAllowedAt = 0
      this.scheduleReconnect()
      return
    }

    if (this.rfc4571Reader) {
      if (this.streamingDebug) {
        this.logger?.info('activity watchdog: destroying rfc4571 reader', {
          meta,
        })
      }
      this.destroyRfc4571Reader()
      this._status = 'error'
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
      this.nextDialAllowedAt = 0
      // The lib's loopback may have idle-rotated — ask the publisher to
      // refresh before the next dial picks up a stale URL.
      this.notifySourceRefresh()
      this.scheduleReconnect()
      return
    }

    // No reader to tear down (push / push-rtp / RTMP) — log only.
    // The provider owns the lifecycle on those paths.
    if (this.streamingDebug) {
      this.logger?.info('activity watchdog: no reader to tear down (push/RTMP source) — log only', {
        meta,
      })
    }
  }

  // ── Error/idle placeholder ────────────────────────────────────────

  /** Timer emitting error placeholder at 1fps while reconnecting. */
  private errorPlaceholderTimer: ReturnType<typeof setInterval> | undefined

  /**
   * Reason currently displayed by the placeholder image. Drives
   * `getPlaceholderFrame()` lookups so a sleeping cam shows
   * "SLEEPING", an offline cam shows "OFFLINE", and so on. Default
   * `'reconnecting'` matches the legacy single-frame behaviour.
   *
   * Mutated via `setPlaceholderReason()` from upstream surfaces (the
   * Reolink provider transitions on sleep events; the broker manager
   * may surface explicit disabled/offline states); the running
   * `errorPlaceholderTimer` re-reads it on every tick so transitions
   * appear within ~1 frame of the upstream signal.
   */
  private placeholderReason: PlaceholderKind = 'reconnecting'

  /**
   * Update the reason shown by the placeholder image. Idempotent —
   * a no-op when the reason hasn't changed. Safe to call from
   * upstream callers regardless of whether the placeholder timer is
   * currently active; the next tick (or next `startErrorPlaceholder`
   * invocation) picks up the new reason.
   */
  setPlaceholderReason(reason: PlaceholderKind): void {
    if (this.placeholderReason === reason) return
    this.placeholderReason = reason
    // If the placeholder is actively emitting, push a fresh frame so
    // the operator sees the new label immediately rather than waiting
    // for the next 1Hz tick. Cheap (~5-9KB per emit) and matches user
    // expectation when toggling state from the admin UI.
    if (this.errorPlaceholderTimer) {
      this.emitPlaceholderFrame()
    }
  }

  private stopErrorPlaceholder(): void {
    if (this.errorPlaceholderTimer) {
      clearInterval(this.errorPlaceholderTimer)
      this.errorPlaceholderTimer = undefined
    }
  }

  private scheduleReconnect(): void {
    if (this.manualStop || !this.source) {
      return
    }
    // Hard rule: a broker never holds an open dial loop when no client
    // is consuming the stream. Without demand, suspend instead of
    // re-arming the reconnect timer; the next subscriber triggers
    // `checkDemand()` → `start(this.source)` to dial again.
    if (!this.hasLiveIntent()) {
      this._suspended = true
      this._status = 'idle'
      this.stopErrorPlaceholder()
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer)
        this.reconnectTimer = undefined
      }
      this.logger?.info('Reconnect skipped — no demand, broker suspended')
      return
    }

    // Dedup: a single connect failure fans out into two notifications
    // (`socket.on('error')` → `onError` callback AND the rejected
    // `client.connect()` promise → `.catch`). Both end up here. When a
    // reconnect timer is already armed for the same failure window, do
    // nothing — otherwise every doubled call doubles the live timers,
    // and a few generations later one connect failure expands into
    // hundreds of scheduled retries firing in the same tick.
    if (this.reconnectTimer) {
      return
    }

    // Placeholder pump is intentionally NOT started during reconnect.
    // We tried both H.264 and H.265 cross-codec injection paths and
    // they confused Chrome's HEVC decoder on the H.265 RTP path
    // (placeholder SPS conflicting with the repacketizer's seeded
    // camera SPS). Reconnect/wake-up windows now leave the existing
    // last-frame on screen — the WebRTC viewer's UI overlay is the
    // surface for reconnect feedback. Placeholders remain only for
    // the explicit `placeholder` source type (disabled cameras),
    // handled by `startPlaceholderReader`.

    this.logger?.info('Reconnecting RTSP reader', {
      meta: { delayMs: this.reconnectDelayMs },
    })

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined
      if (this.manualStop) return
      // Re-resolve the source on every reconnect so an URL change
      // landed while we were waiting (e.g. Reolink republished after
      // an `ensureRfc4571Server` recreate) is observed. Routed through
      // `start()` so the dial rate-limit gate applies on this path too
      // (single choke point — 2026-07-23 dial-storm fix).
      const src = this.resolveCurrentSource()
      if (!src) return
      void this.start(src)
    }, this.reconnectDelayMs)

    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
  }

  /**
   * Reset the push-mode stall detection timer.
   * If no packet arrives within PUSH_STALL_TIMEOUT_MS, switch to error
   * state and emit placeholder frames so RTSP clients don't freeze.
   *
   * Sources flagged `allowStall: true` (battery cameras that
   * intentionally go silent between motion events) bypass the error
   * placeholder — the broker logs at debug, marks the broker
   * `suspended`, and waits silently for the next packet. The next
   * `pushEncodedPacket` clears the suspension and resumes streaming.
   */
  private resetPushStallTimer(): void {
    if (this.pushStallTimer) {
      clearTimeout(this.pushStallTimer)
    }
    this.pushStallTimer = setTimeout(() => {
      this.pushStallTimer = undefined
      if (this.stopping || this.manualStop) return
      if (this.source?.type !== 'push') return

      if (this.source?.allowStall) {
        this.logger?.debug('push source stall (allowStall=true) — suspending until next packet', {
          meta: { timeoutMs: PUSH_STALL_TIMEOUT_MS },
        })
        this._suspended = true
        return
      }

      this.logger?.warn('push source stalled — no data received', {
        meta: { timeoutMs: PUSH_STALL_TIMEOUT_MS },
      })
      this._status = 'error'
      // Placeholder intentionally not emitted — see scheduleReconnect
      // for the rationale (cross-codec issues on H.265 RTP path).
      // `_status='error'` is enough for stats consumers; UI overlay
      // handles operator-facing feedback.
    }, PUSH_STALL_TIMEOUT_MS)
  }

  private destroyNativeClient(): void {
    if (this.nativeClient) {
      this.nativeClient.destroy()
      this.nativeClient = null
    }
    this.resetRtpPipeline()
    // Reader is gone — stop the rolling activity watchdog so it can't
    // fire against a destroyed client. The next reconnect re-arms it
    // on the first RTP packet of the fresh stream.
    this.cancelRtpActivityWatchdog()
  }

  /**
   * RFC 4571 reader — pulls framed RTP from a local TCP server (e.g. the
   * Reolink lib's `createRfc4571TcpServer`). Same downstream pipeline as
   * the native RTSP reader: SDP arrives out-of-band on the StreamSource,
   * RTP packets feed the same depacketizer, AnnexB output goes through
   * the same prebuffer / pipe / restream paths.
   *
   * `source.metadata.sdp` is required and must describe the video
   * (and optionally audio) track the publisher is multiplexing on the
   * single TCP connection.
   */
  private startRfc4571Reader(source: StreamSource): void {
    this.logger?.info('starting RFC 4571 reader')

    // Lazy publish — when the URL carries the `lazy:rfc4571:` sentinel
    // the publisher hasn't materialized the upstream socket yet (it's
    // deferred to first-consumer demand). Trigger a refresh; the
    // publisher's `StreamBrokerOnRequestStreamSourceRefresh` listener
    // is responsible for opening the real rfc4571 server and
    // re-publishing with a real `tcp://...` URL — the reconnect tick
    // resolves the fresh source via `sourceProvider`.
    if (typeof source.url === 'string' && source.url.startsWith('lazy:rfc4571:')) {
      const nowMs = Date.now()
      if (this.materializeRequestedAt === 0) this.materializeRequestedAt = nowMs
      const waitedMs = nowMs - this.materializeRequestedAt
      // A materialize is a source being BUILT, not one that is failing, and the
      // exponential backoff is the wrong shape for it: the wyze publisher
      // answers in ~12 s and 1-2-4-8-16 s means the broker only notices at 16.
      // Poll flat while the deadline holds; past it this is a failure and the
      // backoff is right again.
      const withinDeadline = waitedMs < StreamBroker.MATERIALIZE_WAIT_MS
      if (withinDeadline) this.reconnectDelayMs = StreamBroker.MATERIALIZE_POLL_MS
      this.logger?.info('rfc4571: lazy URL — requesting publisher to materialize upstream', {
        tags: { deviceId: this.numericDeviceId },
        meta: {
          url: source.url,
          waitedMs,
          // Which schedule this dial is on. Without it a cold open that took
          // 16 s of backoff and one that took 12 s of publisher print the same.
          schedule: withinDeadline ? 'materialize-poll' : 'backoff',
          nextDelayMs: this.reconnectDelayMs,
        },
      })
      this._status = 'error'
      this.notifySourceRefresh()
      // ALONGSIDE the publisher request, never instead of it. The sentry has
      // no source, no socket and no demand: it neither dials nor wakes nor
      // holds anything open. All it does is stop the consumer seeing black for
      // the 2.2-12.4 s the publisher takes to build the stream — which is also
      // what lets an Alexa session answer inside Amazon's six seconds.
      // Idempotent: this branch is re-entered on every materialize poll tick
      // and only the first call prepares a picture.
      if (!this.sentryWindowClosed) this.sentryPump?.start(source.url)
      this.scheduleReconnect()
      return
    }
    // A real URL: the materialize (if any) landed. The deadline stops applying
    // here rather than on the first packet, because what it bounds is the WAIT
    // for a URL — the wait for media after it is the first-video watchdog's.
    const materializedRecently = this.materializeRequestedAt > 0
    if (materializedRecently) {
      this.logger?.info('rfc4571: publisher materialized — dialling the real upstream', {
        tags: { deviceId: this.numericDeviceId },
        meta: { materializeMs: Date.now() - this.materializeRequestedAt },
      })
    }

    const sdp =
      typeof source.metadata?.['sdp'] === 'string' ? (source.metadata['sdp'] as string) : null
    if (!sdp) {
      // No SDP is the same situation as a stale lazy URL — the
      // publisher needs to repopulate. Mirror the lazy-URL path: emit
      // `notifySourceRefresh` so the publisher gets a chance to
      // materialize, instead of failing silently.
      this.logger?.warn('rfc4571: source missing metadata.sdp — requesting publisher refresh')
      this._status = 'error'
      this.notifySourceRefresh()
      this.scheduleReconnect()
      return
    }

    const reader: Rfc4571Reader = new Rfc4571Reader(
      {
        url: source.url,
        sdp,
        ...(this.logger ? { logger: this.logger.child('rfc4571') } : {}),
        packetAllocator: this.packetAllocator,
      },
      this.buildRtpStreamCallbacks(
        'rfc4571',
        () => this.destroyRfc4571Reader(),
        () => this.rfc4571Reader !== reader,
      ),
    )

    this.rfc4571Reader = reader

    reader.connect().catch((err) => {
      if (this.manualStop || this._suspended) return
      this.logger?.warn('rfc4571 connect failed', {
        meta: { error: errMsg(err), ...this.sourceMetaForLog() },
      })
      this.destroyRfc4571Reader()
      this._status = 'error'
      // Ask the publisher to refresh its loopback transport. The lib's
      // RFC 4571 TCP server idle-tears-down after ~15s with no
      // clients and may rebind to a different port on recreate, so a
      // cached URL goes stale. The publisher's response (re-running
      // `ensureRfc4571Server` + `publishCameraStream`) updates the
      // cam-stream registry; the next reconnect picks the fresh URL
      // up via `resolveCurrentSource()`. Deduped against the parallel
      // onError emit by `notifySourceRefresh`.
      this.notifySourceRefresh()
      this.scheduleReconnect()
    })

    // Arm the rolling activity watchdog at DIAL time, not at the first received
    // packet. The rebooted-Reolink wedge: the loopback TCP opens (onPlaying →
    // 'streaming') but the lib's dedicated session never pushes video, so no
    // packet ever arms it and the stall is invisible. Armed here, an 8s silence
    // forces a teardown + publisher refresh + redial — the code-level recovery
    // the live operator pokes could not reach. Kicked forward per RTP packet.
    this.kickRtpActivityWatchdog()
  }

  private destroyRfc4571Reader(): void {
    if (this.rfc4571Reader) {
      this.rfc4571Reader.destroy()
      this.rfc4571Reader = null
    }
    this.resetRtpPipeline()
    // The watchdog only makes sense while a reader is alive — drop it
    // here so a teardown initiated outside `armFirstVideoWatchdog`'s
    // own fire path doesn't leave a stale timer that would force a
    // useless reconnect later.
    this.cancelFirstVideoWatchdog()
    // Same reasoning for the rolling activity watchdog: reader gone,
    // no source to monitor. The next reconnect re-arms on first RTP.
    this.cancelRtpActivityWatchdog()
  }

  /** Tear down the shared RTP/audio pipeline state used by both readers. */
  private resetRtpPipeline(): void {
    if (this.rtpDepacketizer) {
      this.rtpDepacketizer.reset()
      this.rtpDepacketizer = null
    }
    // The picture a marker-less camera closes only with the next timestamp
    // is complete when the reader goes: hand it down before the redial
    // re-bases the clock (RFC 3550), then start clean.
    this.annexBAssembler.flush()
    this.annexBAssembler.reset()
    this.rtpAuTracker.reset()
    // The next dial re-arms at its first keyframe AU if a consumer is still there.
    this.annexBPlaneActive = false
    // Drop the source-RTP pre-buffer with the reader — the GOP it holds
    // belongs to the connection being torn down. Keeping it across an
    // on-demand idle/redial leaks a stale GOP into the next session's
    // instant-start replay (root cause of the device-97 cold-start stutter).
    this.resetRtpPreBuffer()
    if (this.audioRtpDecoder) {
      this.audioRtpDecoder.flush()
      this.audioRtpDecoder = null
    }
    if (this.audioConsumerLingerTimer) {
      clearTimeout(this.audioConsumerLingerTimer)
      this.audioConsumerLingerTimer = undefined
    }
    if (this.audioCodecSession) {
      const session = this.audioCodecSession
      this.audioCodecSession = null
      void session.close().catch((err) => {
        this.logger?.warn('audio-codec: session close failed', {
          meta: { error: errMsg(err) },
        })
      })
    }
    if (this.opusEncodeSession) {
      const opus = this.opusEncodeSession
      this.opusEncodeSession = null
      void opus.close().catch((err) => {
        this.logger?.warn('opus-egress: session close failed', {
          meta: { error: errMsg(err) },
        })
      })
    }
  }

  /**
   * Map an SDP audio track to an `AudioCodecSession` config the
   * audio-codec cap can consume. Returns `null` when the codec is
   * outside the cap's catalogue (broker logs and skips audio in that
   * case). Pure — relies only on parsed SDP fields.
   */
  /**
   * Shared emit callback for `AudioCodecSession`. Decoded PCM is fanned
   * out to audio subscribers and re-encoded as G.711 µ-law for WebRTC
   * consumers. Used by both the RTSP onAudioTrack path and the push
   * `pushAudioInfo` path.
   */
  private buildAudioCodecEmitCallback(): (
    chunk: import('@camstack/types').DecodedAudioChunk,
  ) => void {
    return (chunk) => {
      // The analyzer pipeline relies on the AudioCodecSession's ~500ms
      // window to give the sound classifier a stable input length, so
      // we hand the big chunk over to the audio-chunk plane unchanged.
      this.audioChunkPlane.fanout(chunk)
      if (this.encodedCallbacks.size > 0) {
        const f32 = new Float32Array(
          chunk.data.buffer,
          chunk.data.byteOffset,
          chunk.data.byteLength / 4,
        )
        const pcm16 = new Int16Array(f32.length)
        for (let i = 0; i < f32.length; i++) {
          const s = Math.max(-1, Math.min(1, f32[i]!))
          pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        const ulaw = pcmToMulaw(pcm16)
        const ratio = Math.max(1, Math.round(chunk.sampleRate / 8000))
        const resampled = ratio > 1 ? downsampleUlaw(ulaw, ratio) : ulaw

        // Split the 500ms-window mu-law buffer into RFC 3551-canonical
        // 20ms RTP packets (160 bytes @ 8kHz µ-law). The analyzer
        // pipeline can stomach the long window because it integrates
        // over half-second classifier frames, but WebRTC senders
        // can't: a single 4000-byte payload exceeds typical UDP MTU
        // (frags drop on any single-fragment loss) AND arrives at the
        // browser in 500ms-bursts the audio jitter buffer can't
        // smooth out — net effect is "no audio output on the player".
        // 20ms per packet is what every Reolink-style RTSP/rfc4571
        // restream produces on the wire, so the WebRTC sender now
        // looks identical to a passthrough G.711 source.
        const PCMU_BYTES_PER_PACKET = 160 // 8kHz × 20ms × 1 byte/sample
        const baseTs = chunk.timestamp
        let offsetBytes = 0
        // Stamp each sub-packet's `pts` with a monotonically advancing
        // ms timestamp (20ms per slice). The WebRTC session uses its
        // own RTP timestamp counter (`audioTimestampBase` in
        // `session.ts:1032`), so this value mostly drives metadata —
        // but keeping it monotonic lets any future RTP-aware consumer
        // reconstruct the original timing without surprises.
        let chunkOffsetMs = 0
        while (offsetBytes < resampled.length) {
          const end = Math.min(offsetBytes + PCMU_BYTES_PER_PACKET, resampled.length)
          const slice = resampled.subarray(offsetBytes, end)
          const packet: EncodedPacket = {
            type: 'audio',
            data: Buffer.from(slice),
            pts: baseTs + chunkOffsetMs,
            dts: baseTs + chunkOffsetMs,
            keyframe: false,
            codec: 'pcmu',
          }
          this.fanOutEncoded(packet)
          offsetBytes = end
          chunkOffsetMs += 20
        }

        // Live Opus egress: encode the SAME decoded PCM into 48 kHz Opus for
        // any WebRTC session that negotiated Opus. Additive — the PCMU packets
        // above are already fanned out and untouched. No-op without Opus demand.
        this.feedOpusEncoder(chunk)
      }
    }
  }

  /**
   * Build an `AudioCodecSessionConfig` from `PushAudioInfo` declared by
   * a push-source provider. Mirrors `buildAudioCodecSessionConfig`
   * (which builds from an SDP audio track) for sources that don't
   * carry SDP — Reolink Baichuan, etc.
   *
   * Push sources don't carry rfc3640 framing — they emit one complete
   * codec frame per packet — so the session is configured without
   * `rfc3640` and the broker calls `pushRawFrame` instead of
   * `processPacket`.
   */
  private buildAudioCodecSessionConfigFromPush(
    info: import('@camstack/types').PushAudioInfo,
  ): import('./audio-codec-session.js').AudioCodecSessionConfig | null {
    const codec = info.codec.toLowerCase()
    const tag = `broker:${this.deviceId}`
    if (codec === 'aac') {
      return {
        codec: 'aac',
        sourceSampleRate: info.sampleRate,
        sourceChannels: info.channels,
        ...(info.extraData ? { extraData: info.extraData } : {}),
        targetSampleRate: 16000,
        targetChannels: 1,
        tag,
      }
    }
    if (codec === 'opus') {
      return {
        codec: 'opus',
        sourceSampleRate: info.sampleRate,
        sourceChannels: info.channels,
        targetSampleRate: 16000,
        targetChannels: 1,
        tag,
      }
    }
    return null
  }

  private buildAudioCodecSessionConfig(
    audioTrack: import('../rtsp/sdp-parser.js').SdpAudioTrack,
  ): import('./audio-codec-session.js').AudioCodecSessionConfig | null {
    const codecUpper = audioTrack.codec.toUpperCase()
    const fmtp = audioTrack.fmtp
    const tag = `broker:${this.deviceId}`

    if (codecUpper === 'MPEG4-GENERIC' || codecUpper === 'AAC') {
      let extraData: Uint8Array | undefined
      let sourceSampleRate = audioTrack.clockRate
      let sourceChannels = audioTrack.channels
      const configHex = fmtp['config'] ?? fmtp['CONFIG']
      if (configHex) {
        try {
          const asc = parseAudioSpecificConfig(configHex)
          sourceSampleRate = asc.sampleRate
          sourceChannels = asc.channelConfig > 0 ? asc.channelConfig : sourceChannels
          extraData = hexToBytes(configHex)
        } catch (err) {
          this.logger?.warn('audio-codec: AudioSpecificConfig parse failed', {
            meta: { configHex, error: errMsg(err) },
          })
        }
      }
      const sizeLength = parseFmtpInt(fmtp, 'sizelength', 13)
      const indexLength = parseFmtpInt(fmtp, 'indexlength', 3)
      const indexDeltaLength = parseFmtpInt(fmtp, 'indexdeltalength', indexLength)
      return {
        codec: 'aac',
        sourceSampleRate,
        sourceChannels,
        ...(extraData ? { extraData } : {}),
        targetSampleRate: 16000,
        targetChannels: 1,
        tag,
        rfc3640: { sizeLength, indexLength, indexDeltaLength },
      }
    }

    if (codecUpper === 'OPUS') {
      return {
        codec: 'opus',
        sourceSampleRate: audioTrack.clockRate,
        sourceChannels: audioTrack.channels,
        targetSampleRate: 16000,
        targetChannels: 1,
        tag,
      }
    }

    return null
  }
}

function parseFmtpInt(
  fmtp: Readonly<Record<string, string>>,
  key: string,
  fallback: number,
): number {
  const raw = fmtp[key] ?? fmtp[key.toLowerCase()] ?? fmtp[key.toUpperCase()]
  if (raw === undefined) return fallback
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function hexToBytes(hex: string): Uint8Array {
  const trimmed = hex.replace(/\s+/g, '')
  if (trimmed.length % 2 !== 0) {
    throw new Error(`audio-codec: hex string has odd length (${trimmed.length})`)
  }
  const out = new Uint8Array(trimmed.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(trimmed.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error(`audio-codec: invalid hex at offset ${i * 2}`)
    }
    out[i] = byte
  }
  return out
}
