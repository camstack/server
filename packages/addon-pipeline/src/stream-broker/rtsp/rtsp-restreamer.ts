import type { EncodedPacket, IScopedLogger } from '@camstack/types'
import { PacedRtpReplay } from '../paced-rtp-replay.js'
import { preRollSpanBound } from '../pre-roll.js'
import { AnnexBDeframer } from './annexb-deframer.js'
import { deviceIdFromBrokerId } from './broker-device-id.js'
import { g711AudioMediaBlock, type G711AudioTrack } from './audio/g711-silence.js'
import { SentryAudioSilence } from './audio/sentry-audio-silence.js'
import { appendAudioMediaBlock } from './egress-audio-sdp.js'
import { admitJoinBurst } from './join-burst-admission.js'
import { isExternalRestreamClient } from '../live-viewers.js'
import type { RestreamIntent, RestreamSdpVariant } from './restream-intent.js'
import { RtpPacketizer } from './rtp-packetizer.js'
import { reportConsumerEvent } from '../stream-broker/broker-mem-probe.js'
import { detachFromPool } from '../stream-broker/owned-buffer.js'
import { holdPacket, isSlabView, releasePacket } from '../stream-broker/slab-pool.js'
import { type RtpWriteOutcome, RtspSession } from './rtsp-session.js'
import type { CodecParams, RtpPacket } from './rtsp-types.js'
import { buildSdp } from './sdp-builder.js'

/**
 * Max age (ms) of a prime burst a MUTED (local-decoder loopback) session will
 * accept. A muted decoder must anchor at the LIVE edge — a full-GOP catch-up
 * burst (2-3s old) makes libav base its pts 2-3s in the past and, with ~zero
 * decode headroom, it never drains that backlog. So a muted session only joins
 * off a burst already near live (span ≤ this); otherwise it is left pending to
 * begin at the next live keyframe.
 */
const LIVE_EDGE_MAX_SPAN_MS = 500

/**
 * Max media-time span (ms) of a join burst replayed to a NON-muted session.
 *
 * The burst exists to hand a joining decoder a complete GOP so it renders at
 * once instead of waiting for the camera's next IDR. Its cost is that the
 * consumer receives that whole span of media timestamps in one instant, and
 * every downstream consumer that re-emits on a real-time clock forwards the
 * compression to its own peer. Measured: a HomeKit session whose leg is an
 * ffmpeg copy of this restream reported `maxJitter` 272324 @90 kHz = 3030 ms
 * against a burst logged at `spanMs` 2996 for that same session start — the
 * jitter the controller measured IS the burst span.
 *
 * 2000 ms sits above the observed p50 (1800 ms) and below that confirmed-harmful
 * 2996 ms, so a normal short-GOP camera still gets its instant picture while the
 * distribution's tail — p90 3954 ms, p99 28312 ms, max 61535 ms / 17065 packets
 * in one day — is cut off. Over the bound the burst is not trimmed but
 * WITHHELD: a window from the ring's tail no longer starts at a keyframe, so it
 * cannot be decoded, and the session instead joins clean at the next live
 * keyframe AU (bounded by the same IDR interval that produced the long span).
 */
export const PRIME_MAX_SPAN_MS = 2000

/**
 * The `a=control:trackID=` the sentry's grafted audio block is given.
 *
 * The same id the transcode egress grafts its own audio onto
 * (`extractAudioMediaBlock`'s default) and the same one `sendAudioRtp` writes
 * to (`tracks[1]`), because the video track is always trackID=0.
 */
const SENTRY_AUDIO_TRACK_ID = 1

/**
 * Defensive packet ceiling on a join burst, independent of {@link
 * PRIME_MAX_SPAN_MS}. The ring is trimmed to one GOP by RTP timestamp, so a
 * burst this large means the timestamps stopped describing the stream (wrap,
 * a source that repeats a timestamp, an all-intra latch that never closed).
 * 2000 packets ≈ 2.8 MB of MTU-sized RTP — already past a socket's 2 MB
 * `MAX_WRITE_BUFFER` tolerance.
 */
export const PRIME_MAX_PACKETS = 2000

/**
 * The effective join-burst bound for one restream.
 *
 * Both halves are operator-tunable (cluster default + per-camera-stream
 * override, owned by the stream-broker addon) rather than module constants,
 * because the bound's REACHABILITY is a property of the camera, not of the
 * cluster. The ring holds `[most recent keyframe AU .. now]`, so a burst's span
 * at join time is the elapsed time since the last IDR — uniform in
 * `[0, idrIntervalMs]`. Under a fixed 2 000 ms bound a 1.8 s-GOP camera is
 * never withheld and a 4 s-GOP camera is withheld on roughly half its joins,
 * and no single value is right for both.
 *
 * Raising it is not free: above ~2 500 ms it re-admits exactly the burst span
 * that a real-time re-emitter (an ffmpeg copy of this restream) forwards to its
 * own peer as jitter — the confirmed HomeKit failure at 2 996 ms. The usual
 * correct fix for a long-GOP camera is to shorten the camera's IDR interval.
 */
export interface PrimeBurstBound {
  /** Max media-time span (ms) of a replayed burst. */
  readonly maxSpanMs: number
  /** Defensive packet ceiling, independent of the span. */
  readonly maxPackets: number
}

/**
 * The D57 bound, applied whenever no supplier is wired. Chosen against a
 * measured distribution — p50 1 800 ms survives, the confirmed-harmful
 * 2 996 ms does not — so it is the value every unconfigured stream gets.
 */
export const DEFAULT_PRIME_BURST_BOUND: PrimeBurstBound = {
  maxSpanMs: PRIME_MAX_SPAN_MS,
  maxPackets: PRIME_MAX_PACKETS,
}

/**
 * The pre-roll window a broker currently holds, plus the pre-roll it was
 * configured with.
 *
 * Both halves travel together because the join needs both and they must agree:
 * `packets` is what would be sent, `preRollMs` is what the operator asked for
 * and therefore the span this session's bound is widened to. Reading the second
 * from anywhere else would let a stale configuration admit a window nobody
 * asked for.
 *
 * `packets` is a THUNK because the two halves are asked for at different
 * moments and at very different prices. The configured number is read on EVERY
 * serve so the log can name what each intent is set to; slicing the ring costs
 * a copy of up to a full window and is paid only when a session of that intent
 * is actually joining. Measured live on 2026-08-20: without this the prime line
 * printed `recordingPreRollMs=0` for "no recorder joined this burst" and for
 * "the operator turned it off" identically, on the same camera minutes apart.
 */
/**
 * One intent's resolved join burst for this call — the packets, whether they
 * amount to a window at all, and whether that window is over its own bound.
 *
 * Built at most once per intent per call and shared by every session of that
 * intent, so N recorders joining the same keyframe map the ring once.
 */
interface PreRollPlan {
  readonly packets: readonly RtpPacket[]
  readonly active: boolean
  /** What the RING retains for this stream (ms) — the prebuffer. */
  readonly retainedMs: number
  /** What this session ASKED for (ms). `0` = it asked for none. */
  readonly requestedMs: number
  /** What the ring could actually DELIVER (ms of media). */
  readonly spanMs: number
  readonly overBound: boolean
}

export interface PreRollBurst {
  /**
   * Keyframe-aligned window for a request of `requestedMs`, oldest first.
   * Empty = no history retained.
   *
   * Takes the amount because the amount is now the CONSUMER's (D382): two
   * sessions joining the same keyframe may legitimately be served different
   * windows, and a supplier that ignored the request would be the omission this
   * record removes, one layer down.
   */
  readonly packets: (requestedMs: number) => readonly Buffer[]
  /** What this stream RETAINS (ms) — the prebuffer. `0` = off. */
  readonly preRollMs: number
}

/**
 * What one session's join cost it, decided at serve time and printed when its
 * burst has actually drained.
 *
 * Carried from the serve loop to the replay's completion callback instead of
 * being re-derived there, because by then the plan is gone and the ring has
 * moved on: the numbers a reader needs ("what did this session ASK for, what
 * did it GET, how much of that was history") are only true as of the decision.
 */
interface AttachAccounting {
  readonly intent: RestreamIntent | null
  /** Ms of history the dial asked for. `0` = it asked for none. */
  readonly requestedMs: number
  /** Ms of history the stream retained at that moment (the prebuffer). */
  readonly retainedMs: number
  /** Media ms delivered BEYOND the ordinary current-GOP burst. `0` for a plain join. */
  readonly preRollSpanMs: number
  /** Media ms in the whole burst this session was handed. */
  readonly burstSpanMs: number
  /** Media ms the current-GOP burst alone spanned — the no-history baseline. */
  readonly gopSpanMs: number
}

/** Drop/withhold accounting is aggregated and reported at most this often. */
const DROP_REPORT_INTERVAL_MS = 30_000

/**
 * How often a HISTORY-FREE attach is reported per stream.
 *
 * The baseline population is large and uninteresting one line at a time — a
 * WebRTC bootstrap, a HomeKit leg, an ffprobe — but it is the control group the
 * pre-roll cost is measured against, so it cannot be silent either. Throttled
 * here and NOT throttled for an attach that carried history: that population is
 * rare (17 of ~130 agganci in the 2026-09-07 census) and it is the one the
 * question is about, so a rate limit sized for the common case would drop
 * exactly the samples nobody has.
 */
const PLAIN_ATTACH_REPORT_INTERVAL_MS = 10_000

/**
 * Defensive hard bound on the per-keyframe RTP/NAL cache (both the passthrough
 * `lastKeyframeRtpPackets` and the Annex-B `lastKeyframeNals`). A single
 * keyframe GOP is at most a few large NALs — well under a megabyte or two even
 * for 4K/8MP IDRs. Anything past this cap means the collection latch never
 * closed (an all-intra stream, or a stall right after an IDR before the first
 * P-frame), so the cache would otherwise grow without bound. That is the exact
 * structure that reached ~1.5 GB and OOM-killed the hub stream-broker runner
 * (heap snapshot: 1567 MB retained by `RtspRestreamer.lastKeyframeRtpPackets`).
 * On overflow we drop the partial cache and stop collecting until the next
 * clean GOP boundary; the live edge is unaffected — only the late-joiner
 * keyframe burst is skipped meanwhile.
 */
const MAX_KEYFRAME_CACHE_BYTES = 16 * 1024 * 1024
const CACHE_CAP_WARN_INTERVAL_MS = 30_000

/**
 * One item of a paced join replay.
 *
 * A replay carries two kinds of packet and must keep them distinguishable: the
 * catch-up burst itself (`prime`), and LIVE packets that arrived while the
 * burst was still draining and were appended behind its tail. Sending a live
 * packet with `prime: true` would hand it the burst's latch-clearing semantics;
 * it keeps the live path's own flags instead.
 */
interface PrimeReplayItem {
  readonly packet: RtpPacket
  /** True for a catch-up packet; false for a live packet enqueued mid-replay. */
  readonly prime: boolean
  /** Live packets only: this packet begins a keyframe access unit. */
  readonly keyframeAuStart: boolean
}

/**
 * Per-broker RTSP restreamer.
 *
 * Operates in two modes:
 *
 * **Annex-B mode** (legacy, ffmpeg-based):
 *   Receives raw Annex-B chunks via pushPacket(), deframes into NALs,
 *   RTP-packetizes, and broadcasts to RTSP sessions.
 *
 * **RTP passthrough mode** (native RTSP client):
 *   Receives the camera's SDP via setCameraSdp() and raw RTP packets
 *   via pushRtpPassthrough(). Forwards RTP directly to clients — zero
 *   re-packetization, preserving the camera's original framing.
 */
export class RtspRestreamer {
  private readonly sessions = new Map<string, RtspSession>()
  /** Sessions that need a keyframe before receiving regular frames. */
  private readonly pendingKeyframe = new Set<string>()
  private packetizer: RtpPacketizer | null = null
  private codecParams: CodecParams | null = null
  private sdp: string | null = null
  private mutedSdp: string | null = null
  private deframer: AnnexBDeframer | null = null
  private detectedCodec: 'h264' | 'h265' | null = null
  /**
   * Grafted audio `m=audio` block for transcode-egress audio (set by the
   * egress from ffmpeg's `-sdp_file`). Appended to the push-mode video SDP as
   * trackID=1. Muted sessions still get the video-only SDP.
   */
  private egressAudioBlock: string | null = null
  /**
   * BROKER-SIDE AUDIO MUTE (D83) — device policy, set by `StreamBroker`.
   *
   * Distinct from a session's own `isMuted()`, which is a PULLER's choice
   * (the `/muted` URL a local decoder asks for). This one overrides every
   * puller: while true, `getSdp()` serves the video-only SDP to everyone, so
   * a client that connects during the mute never declares an audio stream it
   * will not receive.
   *
   * NOT cleared by {@link resetStreamState}. That method resets what belongs
   * to one CONNECTION (keyframe caches, codec params, SDP); an operator's
   * mute belongs to the device and must survive a suspend/resume — otherwise
   * a broker going idle overnight would wake up distributing audio again.
   */
  private deviceAudioMuted = false

  /**
   * The camera's audio shape, remembered so a SENTRY can be handed a track to
   * fill while the camera is asleep.
   *
   * NOT cleared by {@link resetStreamState}, for exactly the reason
   * {@link deviceAudioMuted} is not: that method resets what belongs to one
   * CONNECTION, and this describes the CAMERA. A sleeping camera has no SDP to
   * read — it is the whole premise of the sentry — so if this did not survive
   * the suspend there would never be an audio track to announce at the moment
   * one is needed.
   *
   * `null` means nothing has ever described this camera's audio to us (a cold
   * hub whose battery camera has not been awake since boot), or its codec is
   * one whose silence cannot be generated exactly. Both are logged; neither is
   * guessed at.
   */
  private sentryAudioTrack: G711AudioTrack | null = null

  /** Fills a sentry's audio track while the camera sleeps. Built on demand. */
  private sentryAudioSilence: SentryAudioSilence | null = null

  /** One-shot guard for "a sentry attached and there is no track to fill". */
  private sentryAudioGapLogged = false

  /** Cached last keyframe NALs (SPS/PPS + IDR) for late-joining clients. */
  private lastKeyframeNals: Buffer[] = []
  private lastKeyframeNalBytes = 0
  private lastKeyframeTimestamp = 0
  /** True if we're currently accumulating a keyframe's NALs. */
  private collectingKeyframe = false

  /** Current RTP timestamp for the batch of NALs being processed. */
  private currentTimestamp = 0

  /** RTP passthrough: cached last keyframe RTP packets for late-joining clients. */
  private lastKeyframeRtpPackets: RtpPacket[] = []
  private lastKeyframeRtpBytes = 0
  /** Throttle for the defensive keyframe-cache overflow warning. */
  private cacheCapWarnMs = 0
  /** True when in RTP passthrough mode (setCameraSdp was called). */
  private _rtpPassthroughMode = false
  /** Accumulating keyframe RTP packets in passthrough mode. */
  private collectingKeyframeRtp = false

  private logger: IScopedLogger | null = null
  private _onSessionCountChanged: (() => void) | null = null

  /**
   * Supplies the broker's current-GOP source-RTP snapshot (keyframe..now) so a
   * joining decoder is primed with the WHOLE recent GOP as a burst and
   * fast-forwards to the live edge — instead of a lone keyframe up to a GOP old
   * followed by reference-broken live packets. Returns [] until a keyframe
   * is seen (falls back to
   * the single cached keyframe AU).
   */
  private rtpPreBufferSupplier: (() => readonly Buffer[]) | null = null

  /**
   * Supplies the effective join-burst bound, read fresh on EVERY join.
   *
   * A PULL, not a value pushed in at construction, for the same reason
   * {@link rtpPreBufferSupplier} is: a restreamer is created on the broker's
   * first dial and reused for the whole life of the stream, so a bound latched
   * at construction would apply whatever was configured when the camera was
   * first published and ignore every later edit. That failure is invisible —
   * the only symptom is a burst that is or is not withheld — and it would also
   * mean every settings mutation site had to remember to push the new value
   * down to each broker.
   */
  private primeBoundSupplier: (() => PrimeBurstBound) | null = null

  /**
   * Supplies the PRE-ROLL window — the current GOP plus up to `preRollMs` of
   * the history before it, keyframe-aligned (motion-start Stage 2).
   *
   * A second supplier and not a widening of {@link rtpPreBufferSupplier},
   * because the two feed different populations: that one is also the WebRTC
   * bootstrap and every ordinary RTSP join, and handing them history is the
   * D57 failure. Only a session that DECLARED an intent on its dial path is
   * served from this one.
   *
   * Takes the intent, because the two windows are two numbers (D193): a
   * detection dial drains its backlog frame by frame and a recorder copies it
   * to disk, so the operator sets them apart. One supplier keyed by intent, and
   * not two suppliers, so a third intent cannot arrive with its own wiring.
   *
   * Pulled per join for the same reason as the bound: a broker outlives the
   * setting.
   */
  private preRollSupplier: (() => PreRollBurst) | null = null

  /**
   * In-flight paced join replays, keyed by session id. A session with an entry
   * here has been removed from {@link pendingKeyframe} but is NOT yet on the
   * live feed: live packets are appended to its replay tail via `enqueue`, so
   * total order stays burst-then-live exactly as the old synchronous loop
   * guaranteed implicitly.
   */
  private readonly activeReplays = new Map<string, PacedRtpReplay<PrimeReplayItem>>()

  /** Throttled drop/withhold accounting — see {@link reportDrops}. */
  private dropsWithheldSpan = 0
  private dropsWithheldPackets = 0
  /**
   * Muted (local-decoder loopback) joins refused the ring burst because it was
   * not near-live — see {@link LIVE_EDGE_MAX_SPAN_MS}. Its own counter: this is
   * a different rule from the span/packet bound, it fires on a DIFFERENT
   * population (only decode sessions), and conflating it with
   * {@link dropsWithheldSpan} would hide that a camera's decoder starts blind
   * on nearly every dial while its viewers are served normally.
   *
   * Counts withhold DECISIONS, not joins — `servePendingSessionsRtp` runs per
   * packet, so one session withheld for a whole GOP contributes many. Same
   * semantics as {@link dropsWithheldSpan}; the signal to read is "nonzero on
   * THIS camera while its viewers are being served".
   */
  private dropsWithheldMutedLiveEdge = 0
  private dropsPrimeBacklog = 0
  private dropsLiveLatched = 0
  private dropsLiveClosed = 0
  private dropReportMs = 0
  /** Last history-free attach reported — see {@link PLAIN_ATTACH_REPORT_INTERVAL_MS}. */
  private plainAttachReportMs = 0

  /** Numeric device id parsed once from the brokerId, for `tags.deviceId`. */
  private readonly deviceId: number | undefined

  constructor(private readonly streamName: string) {
    this.deviceId = deviceIdFromBrokerId(streamName)
  }

  /** Wire the broker's current-GOP RTP snapshot supplier (see field doc). */
  setRtpPreBufferSupplier(supplier: () => readonly Buffer[]): void {
    this.rtpPreBufferSupplier = supplier
  }

  /** Wire the effective join-burst bound accessor (see field doc). */
  setPrimeBoundSupplier(supplier: () => PrimeBurstBound): void {
    this.primeBoundSupplier = supplier
  }

  /** Wire the pre-roll window accessor (see field doc). */
  setPreRollSupplier(supplier: () => PreRollBurst): void {
    this.preRollSupplier = supplier
  }

  /** The bound in force right now; {@link DEFAULT_PRIME_BURST_BOUND} unwired. */
  private currentPrimeBound(): PrimeBurstBound {
    return this.primeBoundSupplier?.() ?? DEFAULT_PRIME_BURST_BOUND
  }

  /** True when using RTP passthrough (native client) instead of Annex-B re-packetization. */
  get rtpPassthroughMode(): boolean {
    return this._rtpPassthroughMode
  }

  /** Register a callback invoked when RTSP client count changes. */
  onSessionCountChanged(cb: () => void): void {
    this._onSessionCountChanged = cb
  }

  setLogger(logger: IScopedLogger): void {
    this.logger = logger
  }

  /**
   * Reset all stream-session state. Called on broker suspend so stale
   * keyframe caches / codec params from the previous session don't leak
   * into the next one after resume.
   */
  resetStreamState(): void {
    // A join replay drawn from the OLD stream must never continue into the new
    // one — its packets reference a GOP that no longer exists.
    this.abortAllReplays()
    this.lastKeyframeNals = []
    this.lastKeyframeNalBytes = 0
    this.lastKeyframeTimestamp = 0
    this.collectingKeyframe = false
    this.currentTimestamp = 0
    this.packetizer = null
    this.codecParams = null
    this.sdp = null
    this.mutedSdp = null
    this.deframer = null
    this.detectedCodec = null
    this.dropKeyframeRtpCache()
    this._rtpPassthroughMode = false
    this.collectingKeyframeRtp = false
    this.egressAudioBlock = null
    // `sentryAudioTrack` is deliberately NOT cleared — see its field doc. A
    // suspend is exactly the state in which the sentry needs it.
  }

  /**
   * Enforce the defensive per-keyframe cache byte cap. Returns true when the
   * cap was exceeded (caller must have already reset the cache + collecting
   * flag). Warns at most once per {@link CACHE_CAP_WARN_INTERVAL_MS}.
   */
  private warnCacheCapExceeded(kind: 'rtp' | 'nal', bytes: number, packets: number): void {
    const now = Date.now()
    if (now - this.cacheCapWarnMs < CACHE_CAP_WARN_INTERVAL_MS) return
    this.cacheCapWarnMs = now
    this.logger?.warn('keyframe cache exceeded defensive cap — dropping partial GOP', {
      tags: { deviceId: this.deviceId },
      meta: {
        streamName: this.streamName,
        kind,
        bytes,
        packets,
        capBytes: MAX_KEYFRAME_CACHE_BYTES,
      },
    })
  }

  /**
   * Graft (or clear) a transcode-egress audio track onto the push-mode SDP.
   * Safe to call before or after the video codec params are detected — the SDP
   * is recomposed whenever both are available.
   */
  setEgressAudioBlock(block: string | null): void {
    this.egressAudioBlock = block
    if (this.codecParams) this.rebuildSdp()
  }

  /** Recompose the push-mode SDP from current codec params + egress audio block. */
  private rebuildSdp(): void {
    if (!this.codecParams) return
    const { codec, parameterSets } = this.codecParams
    const videoSdp = buildSdp({
      codec,
      parameterSets,
      streamName: this.streamName,
    })
    this.sdp = this.egressAudioBlock
      ? appendAudioMediaBlock(videoSdp, this.egressAudioBlock)
      : videoSdp
    // Muted sessions remain video-only.
    this.mutedSdp = buildSdp({
      codec,
      parameterSets,
      streamName: `${this.streamName} (muted)`,
    })
  }

  /** True when codec params are detected and SDP is available — safe to accept PLAY. */
  isReady(): boolean {
    return this.codecParams !== null && this.packetizer !== null
  }

  getCodecParams(): CodecParams | null {
    return this.codecParams
  }
  getSdp(): string | null {
    // While the DEVICE is muted every puller gets the video-only SDP, whether
    // it asked for the muted variant or not. Serving an `m=audio` we have
    // already decided never to fill is what makes a recorder's ffmpeg wait on
    // a stream that will not arrive.
    if (this.deviceAudioMuted) return this.getMutedSdp()
    return this.sdp
  }
  getMutedSdp(): string | null {
    return this.mutedSdp ?? this.sdp
  }

  /**
   * The SDP a SENTRY dial is answered with: the picture it is being served,
   * plus the audio track that picture will be accompanied by.
   *
   * Three cases, in this order and no other:
   *
   *  1. The operator muted this camera broker-side (D83). That mute IS a device
   *     policy and outranks everything here — the sentry is answered video-only,
   *     exactly as every other consumer is.
   *  2. The current connection already describes audio (the camera is up and we
   *     are serving its own SDP). It is served verbatim: grafting on top would
   *     announce the track twice, and the camera's own description is by
   *     definition the one its RTP will match.
   *  3. Otherwise — the sleeping case, where the SDP is built from the
   *     placeholder frame and has no audio at all — the retained shape is
   *     grafted on as trackID=1.
   *
   * Without a retained shape this degrades to the video-only SDP, which is what
   * the whole path used to serve unconditionally. That is a REFUSAL, reported
   * by {@link reconcileSentryAudio}: a sentry with no audio is a sentry that
   * will never have any, and the operator has to be able to see it rather than
   * infer it from a silent stream.
   */
  getSentrySdp(): string | null {
    if (this.deviceAudioMuted) return this.getMutedSdp()
    const full = this.sdp
    if (full !== null && /^m=audio/m.test(full)) return full
    const videoOnly = this.getMutedSdp()
    const track = this.sentryAudioTrack
    if (track === null || videoOnly === null) return videoOnly
    return appendAudioMediaBlock(videoOnly, g711AudioMediaBlock(track, SENTRY_AUDIO_TRACK_ID))
  }

  /**
   * The SDP for a parsed dial's variant.
   *
   * One switch and not three call sites: the listen server reads the SDP twice
   * (once to wait for it, once to answer with it), and those two reads
   * disagreeing about which variant a dial gets is a class of bug that costs a
   * consumer an empty DESCRIBE.
   */
  getSdpFor(variant: RestreamSdpVariant): string | null {
    if (variant === 'sentry') return this.getSentrySdp()
    if (variant === 'muted') return this.getMutedSdp()
    return this.getSdp()
  }

  /**
   * Remember (or forget) the camera's audio shape for the sentry.
   *
   * Called from the broker's `onAudioTrack`, which is the only place the
   * camera's own SDP is parsed. `null` forgets it — a camera whose audio was
   * turned off, or whose codec this system cannot fill exactly.
   */
  retainSentryAudioTrack(track: G711AudioTrack | null): void {
    const prior = this.sentryAudioTrack
    if (prior?.codec === track?.codec && prior?.payloadType === track?.payloadType) return
    this.sentryAudioTrack = track
    this.sentryAudioSilence?.release('audio shape changed')
    this.sentryAudioSilence = null
    this.sentryAudioGapLogged = false
    this.logger?.info('sentry audio: track shape retained', {
      tags: { deviceId: this.deviceId },
      meta: { streamName: this.streamName, codec: track?.codec ?? null },
    })
    this.reconcileSentryAudio()
  }

  /** The retained audio shape, or `null`. Survives a suspend by design. */
  getSentryAudioTrack(): G711AudioTrack | null {
    return this.sentryAudioTrack
  }

  /**
   * Whether generated silence is being produced for this stream right now.
   *
   * Exposed because "is the filler still running" is not answerable from the
   * wire: a run whose last sentry has left writes to nobody, so a socket that
   * sees nothing looks exactly like a timer that was released and exactly like
   * one that was leaked. That ambiguity survived a deliberate sabotage of
   * {@link removeSession}'s reconcile with the whole suite green.
   */
  isSentryAudioFilling(): boolean {
    return this.sentryAudioSilence?.running === true
  }

  /**
   * Start or stop filling the sentry audio track to match who is attached.
   *
   * Called on every edge that can change the answer — a session arriving or
   * leaving, the operator's mute, a new audio shape — and never on a per-packet
   * path. Idempotent in both directions.
   */
  private reconcileSentryAudio(): void {
    const wanted = this.getPrestreamSessionCount() > 0 && !this.deviceAudioMuted
    if (!wanted) {
      this.sentryAudioSilence?.release('no sentry session')
      return
    }
    const track = this.sentryAudioTrack
    if (track === null) {
      // A branch that accepts a consumer and gives it nothing. It says so, once
      // per shape, because a sentry that is silent because nothing described
      // this camera's audio looks exactly like one whose camera is quiet.
      if (!this.sentryAudioGapLogged) {
        this.sentryAudioGapLogged = true
        this.logger?.info('sentry audio: no track to fill — this dial gets no audio', {
          tags: { deviceId: this.deviceId },
          meta: {
            streamName: this.streamName,
            // The two reasons, and they need different fixes: nothing has
            // described this camera's audio since boot, or its codec is not one
            // whose silence can be generated exactly (only G.711 is).
            reason: 'no retained g711 audio shape',
          },
        })
      }
      return
    }
    if (this.sentryAudioSilence === null) {
      this.sentryAudioSilence = new SentryAudioSilence({
        track,
        emit: (rtp) => this.sendSilenceToSentrySessions(rtp),
        ...(this.logger ? { logger: this.logger } : {}),
        ...(this.deviceId === undefined ? {} : { deviceId: this.deviceId }),
      })
    }
    this.sentryAudioSilence.want()
  }

  /**
   * Hand one generated packet to every sentry session that can take it.
   *
   * Gated on PLAY, on the sentry intent and on the session's own mute — and
   * deliberately NOT on `pendingKeyframe`, which is the one gate the real audio
   * path applies and this one must not.
   *
   * That gate exists to keep live audio behind a video join REPLAY, so a
   * session's two tracks are not handed media from two different moments.
   * Generated silence belongs to no replay and to no GOP. Worse, waiting for
   * the video would reproduce the defect: the placeholder picture arrives at
   * 1 fps at best and not at all when the sentry refuses (unknown geometry, no
   * cached snapshot), so the track a consumer's ffmpeg is waiting on would stay
   * empty for exactly as long as the picture did — which is the stall the
   * announced-but-unfilled `m=audio` was feared for in the first place.
   *
   * Returns how many took it, so a run that delivers to nobody is visible.
   */
  private sendSilenceToSentrySessions(rtp: Buffer): number {
    const packet: RtpPacket = { data: rtp, marker: (rtp[1]! & 0x80) !== 0 }
    let served = 0
    for (const session of this.sessions.values()) {
      if (!session.isPrestreamIntent()) continue
      if (session.isMuted()) continue
      if (!session.isPlaying()) continue
      if (session.sendAudioRtp(packet) === 'written') served += 1
    }
    return served
  }

  /**
   * Apply the broker-side audio mute. Returns how many audio-bearing pull
   * sessions were closed so they re-`DESCRIBE` against the new SDP.
   *
   * Idempotent — the same value twice closes nothing. Sessions that pulled the
   * `/muted` URL are left alone: they never had an audio track to gain or
   * lose, and killing a local decoder's feed to change nothing would be a
   * decode gap for free.
   */
  setAudioMuted(muted: boolean): number {
    if (this.deviceAudioMuted === muted) return 0
    this.deviceAudioMuted = muted
    // The operator's mute outranks the sentry fill: while it is on, this
    // camera distributes no audio of any kind, generated included.
    this.reconcileSentryAudio()
    const audioBearing = [...this.sessions.values()].filter((s) => !s.isMuted())
    for (const session of audioBearing) {
      this.killSession(session.getSessionId())
    }
    if (audioBearing.length > 0) {
      this.logger?.info(
        'audio mute changed — closing audio-bearing RTSP pulls so they re-DESCRIBE',
        {
          tags: { deviceId: this.deviceId },
          meta: {
            streamName: this.streamName,
            muted,
            closed: audioBearing.length,
          },
        },
      )
    }
    return audioBearing.length
  }

  /** The broker-side audio mute currently in force for this restreamer. */
  isDeviceAudioMuted(): boolean {
    return this.deviceAudioMuted
  }
  getSessionCount(): number {
    return this.sessions.size
  }

  /**
   * RTSP clients from OUTSIDE that are playing right now — people with a player
   * open on the restream, not our recorder, decoder or agents (see
   * `live-viewers.ts`). Read straight off the live session map and each
   * session's own `playing && !closed`, so a client that vanished without a
   * TEARDOWN stops counting the moment its socket closes or errors.
   */
  countExternalViewers(): number {
    let n = 0
    for (const session of this.sessions.values()) {
      if (isExternalRestreamClient(session.getViewerFacts())) n += 1
    }
    return n
  }

  /**
   * Sessions that count as LIVE INTENT — everything except a sentry dial.
   *
   * The split exists so a continuous-pull client can hold a session open for ever
   * against a battery camera without keeping it awake (D173). For a broker with
   * no sentry session this equals {@link getSessionCount} exactly, which is
   * why nothing else changed behaviour.
   */
  getLiveIntentSessionCount(): number {
    let n = 0
    for (const session of this.sessions.values()) {
      if (!session.isPrestreamIntent()) n += 1
    }
    return n
  }

  /** Sessions asking only for the picture. Drives the sentry pump, nothing
   *  else — it must never reach a dial decision. */
  getPrestreamSessionCount(): number {
    let n = 0
    for (const session of this.sessions.values()) {
      if (session.isPrestreamIntent()) n += 1
    }
    return n
  }

  /**
   * What this restreamer holds, for the `[broker-mem]` probe: live sessions,
   * their socket write queues (sum and max) and the keyframe caches. One pass
   * over the sessions, no allocation beyond the result.
   */
  getMemProbe(): {
    readonly sessions: number
    readonly writeQueueSumBytes: number
    readonly writeQueueMaxBytes: number
    readonly keyframeCacheBytes: number
  } {
    let sum = 0
    let max = 0
    for (const s of this.sessions.values()) {
      const q = s.getWriteQueueBytes()
      sum += q
      if (q > max) max = q
    }
    return {
      sessions: this.sessions.size,
      writeQueueSumBytes: sum,
      writeQueueMaxBytes: max,
      keyframeCacheBytes: this.lastKeyframeNalBytes + this.lastKeyframeRtpBytes,
    }
  }

  /** Per-session diagnostic snapshots consumed by `StreamBroker.listClients`. */
  listSessionInfos(): readonly ReturnType<RtspSession['getInfo']>[] {
    return [...this.sessions.values()].map((s) => s.getInfo())
  }

  addSession(session: RtspSession): void {
    this.sessions.set(session.getSessionId(), session)
    this.pendingKeyframe.add(session.getSessionId())
    this.logger?.info('RTSP client connected', {
      meta: { streamName: this.streamName, total: this.sessions.size },
    })
    reportConsumerEvent(this.logger, 'attach', 'rtsp', this.deviceId, this.sessions.size)
    this._onSessionCountChanged?.()
    // A sentry arriving is the edge that opens the audio window (D525).
    this.reconcileSentryAudio()

    if (this._rtpPassthroughMode) {
      // RTP passthrough: prime late-joining clients with the current-GOP burst
      // (ring supplier) or the cached keyframe. servePendingSessionsRtp no-ops
      // until the session reaches PLAY / a prime source exists.
      setTimeout(() => this.servePendingSessionsRtp(), 0)
    } else {
      // Annex-B mode: serve cached keyframe NALs via packetizer
      if (this.lastKeyframeNals.length > 0 && this.packetizer) {
        setTimeout(() => this.servePendingSessions(), 0)
      }
    }
  }

  // ── RTP Passthrough Mode ──────────��───────────────────────────────

  /**
   * Set the camera's SDP directly (from DESCRIBE response).
   * Switches the restreamer to RTP passthrough mode — subsequent calls
   * should use pushRtpPassthrough() instead of pushPacket().
   */
  setCameraSdp(sdpText: string, codec: 'h264' | 'h265', codecParams: CodecParams | null): void {
    this._rtpPassthroughMode = true
    this.detectedCodec = codec
    this.codecParams = codecParams
    this.sdp = sdpText
    // Build a video-only SDP for muted sessions (strip all m=audio sections)
    this.mutedSdp = stripAudioFromSdp(sdpText)
    this.logger?.info('RTP passthrough mode — SDP set', {
      meta: { streamName: this.streamName, codec },
    })
  }

  /**
   * Push a raw RTP packet from the native RTSP client.
   * Forwarded directly to all connected RTSP sessions — zero re-packetization.
   *
   * @param rtpData Complete RTP packet (header + payload)
   * @param isKeyframe True if this packet is part of a keyframe ACCESS UNIT —
   *   judged per picture by the broker's `RtpAccessUnitTracker`: every
   *   fragment of a fragmented IDR and a prefix SEI inside the picture carry
   *   it, not only the packet that completed an IRAP NAL. The keyframe cache
   *   below collects exactly that run, and the transition into it is the
   *   once-per-picture `keyframeAuStart` the sessions resume and count on.
   * @param isParameterSet True if this packet contains SPS/PPS/VPS
   */
  pushRtpPassthrough(rtpData: Buffer, isKeyframe: boolean, isParameterSet: boolean): void {
    // No early `sessions.size === 0` return here: the keyframe-cache latch below
    // is closed by the first non-keyframe, non-parameter-set packet of the GOP.
    // Dropping those packets while client-less would strand `collectingKeyframeRtp`
    // permanently true, so every later keyframe/parameter-set packet appends to
    // `lastKeyframeRtpPackets` forever and the per-GOP reset never fires. The
    // guard belongs below the cache block, exactly as in the Annex-B twin
    // `handleNal()`.
    const rtpPacket: RtpPacket = {
      data: rtpData,
      marker: (rtpData[1]! & 0x80) !== 0,
    }

    // Detect the START of a keyframe access unit — the transition INTO
    // collecting — captured BEFORE the cache block flips `collectingKeyframeRtp`.
    // This is the clean live GOP boundary at which a MUTED (local-decoder)
    // session, deliberately withheld from the full-GOP burst by
    // servePendingSessionsRtp, joins the live edge.
    const keyframeAuStart = (isKeyframe || isParameterSet) && !this.collectingKeyframeRtp

    // Cache keyframe RTP packets for late-joining clients
    if (isKeyframe || isParameterSet) {
      if (!this.collectingKeyframeRtp) {
        this.collectingKeyframeRtp = true
        this.dropKeyframeRtpCache()
      }
    }

    if (this.collectingKeyframeRtp && !isKeyframe && !isParameterSet) {
      // The first packet of the NEXT picture closes the cache and is not part
      // of it: with access-unit flags that packet is a fragment of a P slice,
      // and a late joiner primed from the cache would decode a truncated NAL.
      this.collectingKeyframeRtp = false
    }

    if (this.collectingKeyframeRtp) {
      // A REFERENCE to the source packet, never a copy. The broker hands a
      // packet that already owns its backing store (the readers cut it so, and
      // the pre-buffer ring retains the same object), so `detachFromPool` is an
      // identity here and the keyframe AU costs one allocation shared by the
      // ring, this cache and every session's write queue. It copies only for a
      // caller that hands a pooled view — a cached entry must never pin a slab
      // (`owned-buffer.ts`). `Buffer.from(rtpData)` here used to copy every
      // keyframe packet of every camera and hold the copies for a GOP.
      const cached = isSlabView(rtpData) ? rtpData : detachFromPool(rtpData)
      // A slab view: the slab outlives this GOP's cache, not the other way
      // round (`slab-pool.ts`). Released in `dropKeyframeRtpCache`.
      holdPacket(cached)
      this.lastKeyframeRtpPackets.push({
        data: cached,
        marker: rtpPacket.marker,
      })
      this.lastKeyframeRtpBytes += rtpData.length
      if (this.lastKeyframeRtpBytes > MAX_KEYFRAME_CACHE_BYTES) {
        // Latch never closed (all-intra / post-IDR stall) — hard-bound the
        // cache so it can never grow toward the ~1.5 GB that OOM'd the runner.
        this.warnCacheCapExceeded(
          'rtp',
          this.lastKeyframeRtpBytes,
          this.lastKeyframeRtpPackets.length,
        )
        this.dropKeyframeRtpCache()
        this.collectingKeyframeRtp = false
      }
    }

    if (this.sessions.size === 0) return

    // Serve pending sessions (late joiners waiting for keyframe)
    this.servePendingSessionsRtp()

    // At a live keyframe-AU start, unlatch EVERY playing session still pending:
    // servePendingSessionsRtp withholds a burst that would start the session in
    // the past — always for a muted (local-decoder) session, and for any session
    // whose burst is wider than PRIME_MAX_SPAN_MS. This packet is the clean live
    // GOP boundary they were waiting for. Removing them from pendingKeyframe
    // BEFORE the broadcast loop lets this exact packet reach them below (their
    // first frame = now, with zero backlog).
    if (keyframeAuStart) {
      for (const session of this.sessions.values()) {
        if (!session.isPlaying()) continue
        this.pendingKeyframe.delete(session.getSessionId())
      }
    }

    // Broadcast to all active sessions. Pass whether this packet BEGINS a
    // keyframe access unit — the parameter-set packet that opens it, once per
    // picture. That is the clean resume point for a backlog-latched session
    // and the beat its missed-keyframe count runs on: `MAX_MISSED_KEYFRAMES`
    // means GOPs, so handing every packet of the keyframe AU as "a keyframe"
    // closed a backlogged client within ONE picture of a 3-slice camera
    // instead of three GOPs.
    for (const session of this.sessions.values()) {
      const sessionId = session.getSessionId()
      // A session still draining its join burst takes this packet at the TAIL
      // of that burst, never ahead of it.
      const replay = this.activeReplays.get(sessionId)
      if (
        replay?.enqueue({
          packet: rtpPacket,
          prime: false,
          keyframeAuStart,
        })
      ) {
        continue
      }
      if (this.pendingKeyframe.has(sessionId)) continue
      if (!session.isPlaying()) continue
      this.recordLiveOutcome(session.sendRtp(rtpPacket, false, keyframeAuStart))
    }
  }

  /**
   * Send the join burst to sessions that transitioned to PLAY.
   *
   * The burst is BOUNDED (see {@link PRIME_MAX_SPAN_MS} /
   * {@link PRIME_MAX_PACKETS}) and PACED (see {@link PacedRtpReplay}). Both
   * were absent: this replayed the entire retained ring in one synchronous
   * nested loop, measured at 9.9 Mbps instantaneous against a 485 kbps steady
   * stream (20×) on 101/mid and 40.7 Mbps on 101/high, with a population p99 of
   * 28.3 s of history and a same-day max of 61.5 s / 17065 packets.
   */
  private servePendingSessionsRtp(): void {
    if (this.pendingKeyframe.size === 0) return

    // WHO IS READY IS ASKED FIRST, and it is asked without touching the ring.
    //
    // This block used to sit BELOW the `primePackets` mapping. A session sits in
    // `pendingKeyframe` between SETUP and PLAY, so for that whole window every
    // incoming packet ran `ringPackets.map(...)` over the entire retained ring
    // (~1 800 entries, up to `RTP_RING_MAX_BYTES`) into fresh packet objects and
    // then discovered nobody was ready and returned. A detection dial does that
    // on every motion event — 823 attach/detach cycles in 6 h across 20 cameras
    // (D282) — inside the process already measured at 68 % GC.
    //
    // The hoist is exact, not approximate: `ready` reads `pendingKeyframe`,
    // `activeReplays` and `sessions` and nothing else, so it cannot depend on
    // the ring, and both this and the `primePackets.length === 0` return below
    // are pure early exits that do no work of their own.
    const ready: string[] = []
    for (const sessionId of this.pendingKeyframe) {
      if (this.activeReplays.has(sessionId)) continue
      const session = this.sessions.get(sessionId)
      if (session?.isPlaying()) ready.push(sessionId)
    }

    if (ready.length === 0) return

    // Prime with the broker's CURRENT-GOP burst (keyframe..now) so the decoder
    // fast-forwards to the live edge in one shot. Fall back to the single
    // cached keyframe AU only when the ring is cold (no keyframe seen since the
    // last teardown).
    const ringPackets = this.rtpPreBufferSupplier?.() ?? []
    const fromRing = ringPackets.length > 0
    const primePackets: readonly RtpPacket[] = fromRing
      ? ringPackets.map((data) => ({ data, marker: (data[1]! & 0x80) !== 0 }))
      : this.lastKeyframeRtpPackets
    if (primePackets.length === 0) return

    // Burst span in ms from the RTP timestamps (90kHz) of the first & last prime
    // packets. Signed-32-bit-safe subtraction (`| 0`) tolerates the wrap. Gates
    // whether a MUTED session may join off this burst (see LIVE_EDGE_MAX_SPAN_MS).
    const firstTs = primePackets[0]!.data.readUInt32BE(4)
    const lastTs = primePackets[primePackets.length - 1]!.data.readUInt32BE(4)
    const spanMs = ((lastTs - firstTs) | 0) / 90

    // PRE-ROLL (motion-start Stage 2). A DETECTION dial attaches AFTER the
    // motion edge, so its first frame is at best the live edge — after the
    // event. When the broker retained history for this stream, that session is
    // served a wider, still keyframe-aligned window instead, so the first
    // analysed frames predate the trigger. Only a session that declared the
    // intent sees it; `primePackets` (the current GOP) remains what everyone
    // else is offered, unchanged.
    // ONE plan per declared intent, built at most once per call and only when a
    // session of that intent is actually ready — the supplier slices the ring.
    // A holder rather than a `let`: the plan is assigned inside `planFor`, and
    // narrowing a closed-over `let` back to `null` at the read sites is how TS
    // reads it otherwise.
    // Keyed by the amount ASKED for (D382), because that is now a property of
    // the session and not of the stream: N recorders asking for the same
    // seconds still map the ring once, and a detector asking for less is not
    // handed the recorder's window because it happened to join first.
    const preRollPlans = new Map<number, PreRollPlan>()

    // A MUTED (local-decoder loopback) session must start at the live edge, so it
    // is served the burst ONLY when it is already near-live (a ring burst whose
    // span ≤ LIVE_EDGE_MAX_SPAN_MS). A full-GOP burst, or the degenerate
    // keyframe-only fallback (a lone, possibly stale AU — `!fromRing`), is
    // withheld.
    //
    // A NON-muted session (viewer / recorder / export leg) gets the burst too,
    // but bounded: over this stream's effective {@link PrimeBurstBound} —
    // `maxSpanMs` of media time, or `maxPackets` — it is withheld as well. The
    // bound is read HERE, per join, never captured. Either way a withheld session
    // stays pending and joins at the next live keyframe AU start (see
    // pushRtpPassthrough) — which costs at most one IDR interval and starts it
    // clean at the live edge.
    // A DETECTION decode is exempt from the SPAN half of that bound and not
    // from the packet half — it drains the burst instead of re-emitting it, so
    // there is no peer to jitter, while the packet ceiling still has to catch a
    // stream whose timestamps stopped describing it. The whole decision lives
    // in `admitJoinBurst`; nothing here pre-computes half of it.
    const bound = this.currentPrimeBound()
    /**
     * Resolve (and memoize) the plan for one intent.
     *
     * The bound a PRE-ROLL burst is held to is D57's, widened to the pre-roll
     * the operator configured FOR THAT INTENT, with the packet ceiling scaled
     * by the same factor so the defensive backstop stays a rate. A window WIDER
     * than that is still withheld — the selector cannot produce one, but a long
     * current GOP or a supplier bug can, and D57's remedy (join clean at the
     * next live keyframe) is the right one for a burst nobody asked for.
     */
    const planFor = (requestedMs: number): PreRollPlan => {
      const memo = preRollPlans.get(requestedMs)
      if (memo) return memo
      const burst = this.preRollSupplier?.()
      const window =
        fromRing && burst && burst.preRollMs > 0 && requestedMs > 0
          ? burst.packets(requestedMs)
          : []
      const packets: readonly RtpPacket[] =
        window.length > primePackets.length
          ? window.map((data) => ({
              data,
              marker: (data[1]! & 0x80) !== 0,
            }))
          : []
      const windowSpanMs =
        packets.length > 0
          ? ((packets[packets.length - 1]!.data.readUInt32BE(4) -
              packets[0]!.data.readUInt32BE(4)) |
              0) /
            90
          : 0
      // The bound is widened to what this session could actually be SERVED —
      // the smaller of its request and the retention — not to the retention
      // alone. Widening it past the ask would admit, for a session that asked
      // for 2 s, a burst as wide as a 15 s prebuffer.
      const servableMs = Math.min(requestedMs, burst?.preRollMs ?? 0)
      const windowBound = packets.length > 0 ? preRollSpanBound(bound, servableMs) : bound
      const plan: PreRollPlan = {
        packets,
        active: packets.length > 0,
        retainedMs: burst?.preRollMs ?? 0,
        requestedMs,
        spanMs: windowSpanMs,
        overBound:
          packets.length > 0 &&
          (windowSpanMs > windowBound.maxSpanMs || packets.length > windowBound.maxPackets),
      }
      preRollPlans.set(requestedMs, plan)
      return plan
    }
    const served: string[] = []
    const servedPreRoll = new Map<string, RestreamIntent>()
    /** The plan each pre-roll session was actually served, for its attach line. */
    const servedPlan = new Map<string, PreRollPlan>()
    let withheld = 0
    let detectionIntentServed = 0
    for (const sessionId of ready) {
      const session = this.sessions.get(sessionId)
      if (!session) continue
      // A DETECTION decode session is muted but is NOT the population the
      // live-edge rule was measured for. That rule assumes a consumer that
      // re-clocks the media on a real-time clock with ~zero decode headroom, so
      // a 2-3 s backlog is never drained. A per-session detection decode
      // decodes at source rate and publishes throttled by its FrameSlot — the
      // burst is drained, not accumulated — while the withhold costs it a full
      // IDR interval of BLIND start (~3 dials in 4 on a 2 s-GOP camera), which
      // lands squarely inside the motion→first-inference ramp.
      //
      // It is exempted only when it SAID SO on its dial path
      // (`DETECTION_MUTED_PATH_SUFFIX`), never on `isMuted()` alone: the
      // WebRTC/HomeKit muted legs never dial that path and keep today's
      // behaviour byte-for-byte. Falling through to the `else if` below is
      // deliberate — the exemption removes the live-edge rule, not the D57
      // join-burst bound, which still applies to this session.
      const detectionIntent = session.isDetectionIntent()
      // A dial that DECLARED it needs the history — detection or recording —
      // is bounded by the pre-roll bound instead of D57's, and by nothing else.
      // For detection the live-edge rule below never applied (Stage 0); for a
      // RECORDING dial it never applied either (it is not muted), and the span
      // it carries is the span the operator asked this stream for. A recorder
      // handed this window writes a first segment that PREDATES its trigger,
      // which is the whole point: its writer is spawned at the trigger and
      // ffmpeg's first frame is otherwise at best the live edge.
      const preRollIntent = session.preRollIntent()
      // THE ASK, and it is this session's (D382). An intent alone buys nothing
      // here: a dial that named no amount falls through to the ordinary
      // current-GOP burst below, keeping whatever else its intent buys — for
      // detection, the live-edge exemption it dialed the path for.
      const requestedMs = session.preRollRequestMs()
      if (preRollIntent !== null && requestedMs > 0) {
        const plan = planFor(requestedMs)
        if (plan.active) {
          if (plan.overBound) {
            this.dropsWithheldSpan++
            withheld++
            continue
          }
          // NOT counted here. This branch serves BOTH declared intents, and
          // incrementing a counter called `detectionIntentServed` for a
          // recorder made the line report `detectionIntentServed=1` on a burst
          // where the only pre-roll consumer was ffmpeg — measured live
          // 2026-08-20, on the same lines that had just been fixed for the same
          // class of lie. `preRollServed` already counts this population.
          servedPreRoll.set(sessionId, preRollIntent)
          servedPlan.set(sessionId, plan)
          served.push(sessionId)
          // THE CORRELATION LINE. `restream prime` below reports the window as
          // a per-stream aggregate; this one names the CONSUMER that took it.
          // Without it the only identity on the broker side is a `sessionId`
          // minted in `RtspSession` — a value that appears in no recorder log
          // and in no file name, so a served 9.4 s window and a segment written
          // without one were indistinguishable for as long as both existed
          // (measured 2026-08-20: `recordingPreRollSpanMs=9421` on one line,
          // `ffprobe` finding no burst on the other, no way to know they were
          // the same attach).
          this.logger?.info('restream pre-roll served', {
            tags: { deviceId: this.deviceId },
            meta: {
              streamName: this.streamName,
              sessionId,
              intent: preRollIntent,
              // The recorder puts `recorder/<deviceId>/<profile>/<attach>` here
              // (`buildPassthroughArgs`). `unknown` means the dial declared an
              // intent but no `User-Agent` — correlatable by nothing, which is
              // itself the finding.
              consumer: session.getUserAgent() ?? 'unknown',
              requestedMs: plan.requestedMs,
              retainedMs: plan.retainedMs,
              spanMs: Math.round(plan.spanMs),
              packets: plan.packets.length,
            },
          })
          continue
        }
      }
      // WHO may take this burst — a property of the CONSUMER, decided by one
      // pure function (`join-burst-admission.ts`). A withheld join is DROPPED
      // WORK: that session starts blind and waits for the next live keyframe
      // AU, up to one full IDR interval. It used to increment nothing and log
      // nothing on the muted branch (`withheld` counted only the non-muted one,
      // so `reportDrops` was never called, and the `restream prime` info line
      // returns early when nothing was served), which is exactly why device
      // 618's blind starts were unattributable — and why the first pass at
      // measuring this read `withheld: 0` fleet-wide and believed it.
      const withhold = admitJoinBurst({
        // NOT `isMuted()`. That answered two questions, and since the sentry
        // gained audio (D525) they no longer coincide — see
        // `isLiveEdgeOnlyDial`. Every older population's verdict is unchanged.
        liveEdgeOnly: session.isLiveEdgeOnly(),
        detectionIntent,
        fromRing,
        spanMs,
        packets: primePackets.length,
        bound,
        liveEdgeMaxSpanMs: LIVE_EDGE_MAX_SPAN_MS,
      })
      if (withhold !== 'none') {
        // Three counters, not one: each names a different rule on a different
        // population, and reading them apart is how "this camera's decoder
        // starts blind while its viewers are served" becomes sayable.
        if (withhold === 'live-edge') this.dropsWithheldMutedLiveEdge++
        else if (withhold === 'span') this.dropsWithheldSpan++
        else this.dropsWithheldPackets++
        withheld++
        continue
      }
      if (detectionIntent) detectionIntentServed++
      served.push(sessionId)
    }

    if (withheld > 0) this.reportDrops(false)
    if (served.length === 0) return

    /**
     * Media actually delivered — the WIDEST window any session took, or `-1`
     * when nobody asked for history at all.
     *
     * A max and not a single plan's span since D382: two sessions on the same
     * keyframe can be served different windows, and the number this aggregate
     * line owes its reader is the largest burst this stream let out. The
     * per-attach truth is on `restream attach live-edge`, one line per session.
     */
    const servedSpanMs =
      preRollPlans.size === 0
        ? -1
        : Math.round(Math.max(...[...preRollPlans.values()].map((p) => p.spanMs)))
    /** Which declared intents joined this burst — `0` is "none", not "off". */
    const intentsServed = new Set(servedPreRoll.values())

    this.logger?.info('restream prime (lat-probe)', {
      tags: { deviceId: this.deviceId },
      meta: {
        streamName: this.streamName,
        source: fromRing ? 'gop-burst' : 'keyframe-only',
        packets: primePackets.length,
        spanMs: Math.round(spanMs),
        clients: served.length,
        // The bound in force for this stream. Without it a withheld join and a
        // served one are indistinguishable in the log unless you already know
        // which value the camera was configured with.
        boundSpanMs: bound.maxSpanMs,
        boundPackets: bound.maxPackets,
        withheld,
        // How many of `clients` were detection decode sessions served ONLY
        // because they declared the intent. Without it, "101 started fast" and
        // "101 happened to join at a live keyframe" read identically.
        detectionIntentServed,
        // ONE window (D381). `prebufferMs` is what this stream RETAINS and
        // `preRollSpanMs` is what the ring could actually deliver: the two
        // differ whenever the source had not been warm long enough, which is
        // the difference between "the prebuffer is off" and "it is on and the
        // history was not there" — otherwise indistinguishable in a log.
        //
        // It used to be four keys, two per intent, because the operator
        // configured detection and recording separately and one number could
        // not answer both questions. There is one number now; what stays
        // per-intent is WHO joined, which is the other half of "did the
        // recorder get its seconds".
        prebufferMs: this.preRollSupplier?.().preRollMs ?? 0,
        preRollSpanMs: servedSpanMs,
        recordingIntentServed: intentsServed.has('recording'),
        detectionPreRollServed: intentsServed.has('detection'),
        preRollServed: servedPreRoll.size,
      },
    })

    // One immutable item list shared by every served session — each replay
    // copies it into its own queue. Detection sessions with pre-roll get their
    // own, wider list; it is built once and only when somebody takes it.
    const items: readonly PrimeReplayItem[] = primePackets.map((packet) => ({
      packet,
      prime: true,
      keyframeAuStart: false,
    }))
    // One item list per DISTINCT window served, built once and only when
    // somebody took it — sessions that asked for the same amount share theirs.
    const preRollItems = new Map<number, readonly PrimeReplayItem[]>()
    const itemsFor = (plan: PreRollPlan): readonly PrimeReplayItem[] => {
      const memo = preRollItems.get(plan.requestedMs)
      if (memo) return memo
      const built: readonly PrimeReplayItem[] = plan.packets.map((packet) => ({
        packet,
        prime: true,
        keyframeAuStart: false,
      }))
      preRollItems.set(plan.requestedMs, built)
      return built
    }
    for (const sessionId of served) {
      this.pendingKeyframe.delete(sessionId)
      const intent = servedPreRoll.get(sessionId) ?? null
      const plan = servedPlan.get(sessionId) ?? null
      this.startPrimeReplay(sessionId, plan ? itemsFor(plan) : items, intent, {
        intent,
        requestedMs: plan?.requestedMs ?? 0,
        retainedMs: plan?.retainedMs ?? this.preRollSupplier?.().preRollMs ?? 0,
        // The history this session got BEYOND the ordinary join burst. Zero for
        // every session that took the current GOP, which is what makes the two
        // populations comparable on one line.
        preRollSpanMs: plan ? Math.round(plan.spanMs - spanMs) : 0,
        burstSpanMs: Math.round(plan ? plan.spanMs : spanMs),
        gopSpanMs: Math.round(spanMs),
      })
    }
  }

  /**
   * Drain one session's join burst on the shared pacer instead of a synchronous
   * loop. The first chunk goes out synchronously (the bootstrap still begins on
   * the triggering packet); the rest drain on 5 ms ticks sized to finish within
   * ~300 ms. Same bytes, same order, spread over time.
   *
   * A write the session refuses — a socket already over `MAX_WRITE_BUFFER`, or a
   * session that went away — aborts the whole replay rather than punching holes
   * in the GOP: the session is left latched and rejoins at the next keyframe AU.
   */
  private startPrimeReplay(
    sessionId: string,
    items: readonly PrimeReplayItem[],
    preRollIntent: RestreamIntent | null,
    attach: AttachAccounting,
  ): void {
    const replay: PacedRtpReplay<PrimeReplayItem> = new PacedRtpReplay<PrimeReplayItem>(
      (item) => {
        const session = this.sessions.get(sessionId)
        if (!session) {
          replay.abort()
          return false
        }
        const outcome = session.sendRtp(item.packet, item.prime, item.keyframeAuStart)
        if (outcome === 'written') return true
        if (outcome === 'dropped-backlog') this.dropsPrimeBacklog++
        else if (outcome === 'closed-backlog') this.dropsLiveClosed++
        replay.abort()
        this.reportDrops(outcome === 'closed-backlog')
        return false
      },
      (stats) => {
        this.activeReplays.delete(sessionId)
        // SERVED IS NOT DELIVERED. The decision to hand a session the pre-roll
        // window is taken above; this is the only place that knows whether the
        // bytes reached the socket. A replay that hits `MAX_WRITE_BUFFER`
        // aborts (never punches holes in a GOP) and the session rejoins at the
        // next live keyframe — from the consumer's side that is byte-for-byte a
        // window that was never served, and from the log's side it was
        // `preRollServed=1`. At `info` for a declared intent only: this fires
        // once per attach, not at frame rate.
        if (preRollIntent !== null) {
          this.logger?.info('restream pre-roll replay done', {
            tags: { deviceId: this.deviceId },
            meta: {
              streamName: this.streamName,
              sessionId,
              intent: preRollIntent,
              consumer: this.sessions.get(sessionId)?.getUserAgent() ?? 'unknown',
              packets: stats.packets,
              sent: stats.sent,
              aborted: stats.aborted,
              enqueuedLive: stats.enqueuedLive,
              durationMs: stats.durationMs,
            },
          })
        }
        this.reportAttach(sessionId, attach, stats)
        this.logger?.debug('restream prime drained', {
          tags: { deviceId: this.deviceId },
          meta: {
            streamName: this.streamName,
            sessionId,
            packets: stats.packets,
            sent: stats.sent,
            chunks: stats.chunks,
            chunkSize: stats.chunkSize,
            durationMs: stats.durationMs,
            enqueuedLive: stats.enqueuedLive,
            aborted: stats.aborted,
          },
        })
      },
    )
    this.activeReplays.set(sessionId, replay)
    replay.start(items)
  }

  /**
   * ONE LINE PER ATTACH: what this session asked for, what it was handed, and
   * how long it took to reach the live edge.
   *
   * The question this exists to answer is "does the pre-roll delay the first
   * inference, and by how much" — and it could not be answered before. The only
   * measurement in reach was `pipeline stats`, a 10 s window whose averages
   * dissolve a 4 s transient by construction, and the broker's own lines were
   * per-STREAM aggregates that named a window without naming a session or a
   * duration. Seventeen served bursts inside ninety minutes of ten-second
   * averages is not a measurement, it is a hope.
   *
   * `liveEdgeMs` is measured from PLAY, the first instant the restreamer owes
   * this session bytes, to the moment its burst has drained and it is on the
   * live feed. It therefore contains the wait for a keyframe AND the paced
   * drain — the two things a burst can cost a joiner on this side of the
   * socket. What it deliberately does NOT contain is the consumer's own decode
   * of that burst: that is measured where it happens, on
   * `session-decode: detection first frame`, and the two lines are joined by
   * `deviceId` plus the per-attach `consumer` tag.
   *
   * `aborted` is on the line because a burst that never reached the socket is
   * not a burst this session paid for, and averaging those in would understate
   * the cost of the ones that did.
   */
  private reportAttach(
    sessionId: string,
    attach: AttachAccounting,
    stats: { readonly sent: number; readonly aborted: boolean; readonly durationMs: number },
  ): void {
    const session = this.sessions.get(sessionId)
    const playAt = session?.getPlayAt() ?? 0
    const carriedHistory = attach.preRollSpanMs > 0
    if (!carriedHistory) {
      const now = Date.now()
      if (now - this.plainAttachReportMs < PLAIN_ATTACH_REPORT_INTERVAL_MS) return
      this.plainAttachReportMs = now
    }
    this.logger?.info('restream attach live-edge', {
      tags: { deviceId: this.deviceId },
      meta: {
        streamName: this.streamName,
        sessionId,
        consumer: session?.getUserAgent() ?? 'unknown',
        intent: attach.intent ?? 'none',
        requestedMs: attach.requestedMs,
        retainedMs: attach.retainedMs,
        preRollSpanMs: attach.preRollSpanMs,
        burstSpanMs: attach.burstSpanMs,
        gopSpanMs: attach.gopSpanMs,
        // `-1` when PLAY was never stamped (a session torn down mid-replay):
        // an unknown duration must not be printed as a fast one.
        liveEdgeMs: playAt > 0 ? Date.now() - playAt : -1,
        drainMs: Math.round(stats.durationMs),
        packets: stats.sent,
        aborted: stats.aborted,
      },
    })
  }

  /** Cancel a session's in-flight join replay (teardown / stream reset). */
  private abortReplay(sessionId: string): void {
    const replay = this.activeReplays.get(sessionId)
    if (!replay) return
    this.activeReplays.delete(sessionId)
    replay.abort()
  }

  /** Cancel every in-flight join replay (destroy / stream reset). */
  private abortAllReplays(): void {
    // Deleting the current entry while iterating a Map is well-defined; the
    // delete must precede `abort()` because its `onDone` deletes too.
    for (const [sessionId, replay] of this.activeReplays) {
      this.activeReplays.delete(sessionId)
      replay.abort()
    }
  }

  /** Count a live-path write outcome; drops are reported, never swallowed. */
  private recordLiveOutcome(outcome: RtpWriteOutcome): void {
    if (outcome === 'written' || outcome === 'not-playing') return
    if (outcome === 'closed-backlog') {
      this.dropsLiveClosed++
      // Terminal for that client — report immediately, not on the next window.
      this.reportDrops(true)
      return
    }
    this.dropsLiveLatched++
    this.reportDrops(false)
  }

  /**
   * Emit the accumulated drop/withhold counters and reset them.
   *
   * Aggregated, never per-packet: these branches fire at frame rate when a
   * consumer is behind. Throttled to {@link DROP_REPORT_INTERVAL_MS}, so the
   * FIRST drop after a quiet window is always reported.
   */
  private reportDrops(force: boolean): void {
    const now = Date.now()
    if (!force && now - this.dropReportMs < DROP_REPORT_INTERVAL_MS) return
    this.dropReportMs = now
    const bound = this.currentPrimeBound()
    this.logger?.warn('restream dropped packets', {
      tags: { deviceId: this.deviceId },
      meta: {
        streamName: this.streamName,
        // This warn is the ONLY line a fully-withheld join produces (the info
        // line above returns early when nothing was served), so the bound that
        // caused the withhold has to be readable from it.
        boundSpanMs: bound.maxSpanMs,
        boundPackets: bound.maxPackets,
        primeWithheldSpanMs: this.dropsWithheldSpan,
        primeWithheldPackets: this.dropsWithheldPackets,
        // Decode sessions that started BLIND and must now wait for the camera's
        // next IDR. Nonzero on nearly every dial of a long-GOP camera.
        primeWithheldMutedLiveEdge: this.dropsWithheldMutedLiveEdge,
        liveEdgeMaxSpanMs: LIVE_EDGE_MAX_SPAN_MS,
        primeAbortedOnBacklog: this.dropsPrimeBacklog,
        liveDroppedUntilKeyframe: this.dropsLiveLatched,
        clientsClosedOnBacklog: this.dropsLiveClosed,
        windowMs: DROP_REPORT_INTERVAL_MS,
      },
    })
    this.dropsWithheldSpan = 0
    this.dropsWithheldPackets = 0
    this.dropsWithheldMutedLiveEdge = 0
    this.dropsPrimeBacklog = 0
    this.dropsLiveLatched = 0
    this.dropsLiveClosed = 0
  }

  /**
   * Push a raw audio RTP packet from the native RTSP client.
   * Forwarded to all non-muted sessions. Muted sessions receive no audio.
   *
   * Audio is NOT held behind a video join replay: it rides its own interleaved
   * channel, the consumer aligns the tracks by RTP timestamp, and holding it
   * would mean dropping ~300 ms of audio at every join.
   */
  pushAudioRtpPassthrough(rtpData: Buffer): void {
    // Belt and braces for the D83 mute: `StreamBroker` already returns before
    // calling this, but the transcode-egress sidecar pushes into a restreamer
    // of its own, and a second guard here costs one boolean.
    if (this.deviceAudioMuted) return
    // FIRST, and synchronously: the filler's timer is gone before this packet
    // reaches any session, so no generated frame can follow it. Overlapping
    // silence with real audio is worse than either (D525). Called on every
    // packet, not only the first — the rolling quiet gap inside the filler is
    // what lets it take the track back when the camera sleeps again.
    this.sentryAudioSilence?.noteRealAudio(Date.now())
    if (this.sessions.size === 0) return

    const rtpPacket: RtpPacket = {
      data: rtpData,
      marker: (rtpData[1]! & 0x80) !== 0,
    }

    for (const session of this.sessions.values()) {
      if (session.isMuted()) continue
      if (this.pendingKeyframe.has(session.getSessionId())) continue
      if (session.isPlaying()) {
        this.recordLiveOutcome(session.sendAudioRtp(rtpPacket))
      }
    }
  }

  removeSession(sessionId: string): void {
    this.abortReplay(sessionId)
    this.sessions.delete(sessionId)
    this.pendingKeyframe.delete(sessionId)
    this.logger?.info('RTSP client disconnected', {
      meta: { streamName: this.streamName, total: this.sessions.size },
    })
    reportConsumerEvent(this.logger, 'detach', 'rtsp', this.deviceId, this.sessions.size)
    this._onSessionCountChanged?.()
    // The last sentry leaving is what stops the filler. Nothing else does:
    // it has no source and no demand, so an unreleased run would outlive
    // every consumer it was built for.
    this.reconcileSentryAudio()
  }

  /**
   * Force-close + remove a session by id. Used by the admin `killClient`
   * cap to let operators kick a stuck holder. Returns `true` if the
   * session existed and was dropped, `false` if the id doesn't match.
   */
  killSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId)
    if (!session) return false
    try {
      session.close()
    } catch {
      /* best-effort close */
    }
    this.removeSession(sessionId)
    return true
  }

  pushPacket(packet: EncodedPacket): void {
    if (packet.type !== 'video') return

    this.currentTimestamp = Math.floor(packet.pts * 90) // ms → 90kHz

    // Initialize deframer on first packet (need codec to detect keyframes)
    if (!this.deframer) {
      this.detectedCodec = packet.codec === 'h265' || packet.codec === 'hevc' ? 'h265' : 'h264'
      this.deframer = new AnnexBDeframer(this.detectedCodec, (nal, isKeyframe) => {
        this.handleNal(nal, isKeyframe)
      })
    }

    // NOTE: keyframe collection is triggered inside handleNal() when the
    // deframer emits a complete keyframe NAL — NOT from packet.keyframe,
    // which is unreliable because ffmpeg chunks don't align to NAL boundaries.

    // Push raw bytes — the deframer emits complete NALs via handleNal callback
    this.deframer.push(packet.data)
  }

  destroy(): void {
    this._onSessionCountChanged = null
    this.dropKeyframeRtpCache()
    // Explicit, because this method clears `sessions` directly and never goes
    // through `removeSession` — the only other place the filler is released.
    // Without it a broker that ever served a sentry leaves a 50 Hz interval
    // behind for the life of the process. Same rule as `SentryPump.stop` on
    // the broker's teardown paths.
    this.sentryAudioSilence?.release('restreamer destroyed')
    this.abortAllReplays()
    this.deframer?.flush()
    for (const session of this.sessions.values()) {
      session.close()
    }
    this.sessions.clear()
    this.packetizer = null
    this.deframer = null
  }

  /** Empty the keyframe RTP cache and let go of the slabs it pinned. */
  private dropKeyframeRtpCache(): void {
    for (const cached of this.lastKeyframeRtpPackets) releasePacket(cached.data)
    this.lastKeyframeRtpPackets = []
    this.lastKeyframeRtpBytes = 0
  }

  /** Called by deframer for each complete NAL unit. */
  private handleNal(nal: Buffer, isKeyframe: boolean): void {
    // Initialize codec params from parameter set NALs (SPS/PPS/VPS)
    if (!this.codecParams) {
      this.tryInitCodec(nal)
    }

    // Start keyframe collection when the deframer emits a keyframe or
    // parameter set NAL. This is reliable because the deframer works on
    // complete NAL units — unlike packet.keyframe which scans raw chunks
    // that may split a keyframe across two ffmpeg data events.
    if (isKeyframe || this.isParameterSetNal(nal)) {
      if (!this.collectingKeyframe) {
        this.collectingKeyframe = true
        this.lastKeyframeNals = []
        this.lastKeyframeNalBytes = 0
        this.lastKeyframeTimestamp = this.currentTimestamp
      }
    }

    // Cache keyframe NALs
    if (this.collectingKeyframe) {
      this.lastKeyframeNals.push(Buffer.from(nal))
      this.lastKeyframeNalBytes += nal.length
      // Stop collecting after the first non-parameter-set, non-keyframe NAL
      // (parameter sets + IDR = the keyframe, then P/B frames start)
      if (!isKeyframe && !this.isParameterSetNal(nal)) {
        this.collectingKeyframe = false
      } else if (this.lastKeyframeNalBytes > MAX_KEYFRAME_CACHE_BYTES) {
        // Latch never closed (all-intra / post-IDR stall) — hard-bound the
        // cache so it can never grow toward the ~1.5 GB that OOM'd the runner.
        this.warnCacheCapExceeded('nal', this.lastKeyframeNalBytes, this.lastKeyframeNals.length)
        this.lastKeyframeNals = []
        this.lastKeyframeNalBytes = 0
        this.collectingKeyframe = false
      }
    }

    // Skip RTP if no clients connected or no packetizer yet
    if (this.sessions.size === 0) return
    if (!this.packetizer) return

    // Serve pending sessions: send cached keyframe when they transition to PLAY
    this.servePendingSessions()

    // RTP packetize and broadcast
    const rtpPackets = this.packetizer.packetize(nal, this.currentTimestamp, true)
    for (const rtp of rtpPackets) {
      for (const session of this.sessions.values()) {
        if (this.pendingKeyframe.has(session.getSessionId())) continue
        if (session.isPlaying()) {
          this.recordLiveOutcome(session.sendRtp(rtp))
        }
      }
    }
  }

  /** Send cached keyframe to sessions that have transitioned to PLAY. */
  private servePendingSessions(): void {
    if (this.pendingKeyframe.size === 0) return

    const ready: string[] = []
    for (const sessionId of this.pendingKeyframe) {
      const session = this.sessions.get(sessionId)
      if (session?.isPlaying()) ready.push(sessionId)
    }

    if (ready.length === 0) return
    if (this.lastKeyframeNals.length === 0 || !this.packetizer) return

    // Send cached keyframe NALs to each ready session
    for (const keyNal of this.lastKeyframeNals) {
      const rtpPackets = this.packetizer.packetize(keyNal, this.lastKeyframeTimestamp, true)
      for (const rtp of rtpPackets) {
        for (const sessionId of ready) {
          const session = this.sessions.get(sessionId)
          if (session?.isPlaying()) session.sendRtp(rtp)
        }
      }
    }

    for (const id of ready) this.pendingKeyframe.delete(id)
  }

  /** Try to initialize codec params from a parameter set NAL (SPS/PPS for H264, VPS/SPS/PPS for H265). */
  private tryInitCodec(nal: Buffer): void {
    if (!this.isParameterSetNal(nal)) return
    if (!this.detectedCodec) return

    // Accumulate parameter sets until we have enough
    if (!this.codecParams) {
      // Start a new collection
      const existing = this.lastKeyframeNals.filter((n) => this.isParameterSetNal(n))
      const all = [...existing, nal]

      const codec = this.detectedCodec
      const needed = codec === 'h264' ? 2 : 3 // SPS+PPS or VPS+SPS+PPS
      if (all.length >= needed) {
        this.codecParams = { codec, parameterSets: all.slice(0, needed) }
        this.packetizer = new RtpPacketizer(codec, 96)
        this.rebuildSdp()
      }
    }
  }

  /** Check if a NAL is a parameter set (SPS, PPS, or VPS). */
  private isParameterSetNal(nal: Buffer): boolean {
    if (nal.length === 0) return false
    if (this.detectedCodec === 'h264') {
      const type = nal[0]! & 0x1f
      return type === 7 || type === 8 // SPS, PPS
    }
    const type = (nal[0]! >> 1) & 0x3f
    return type === 32 || type === 33 || type === 34 // VPS, SPS, PPS
  }
}

/**
 * Strip audio media sections from an SDP string.
 * Returns a video-only SDP for muted RTSP sessions.
 *
 * SDP structure: session-level lines, then m= blocks.
 * We keep session-level lines and all m= blocks that aren't audio.
 */
function stripAudioFromSdp(sdpText: string): string {
  const lines = sdpText.split(/\r?\n/)
  const result: string[] = []
  let inAudioSection = false

  for (const line of lines) {
    if (line.startsWith('m=')) {
      inAudioSection = line.startsWith('m=audio')
    }
    if (!inAudioSection) {
      result.push(line)
    }
  }

  return result.join('\r\n')
}
