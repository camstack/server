/**
 * clip-stream-feeder — a clip plays FROM A STREAM, forward-only (D597).
 *
 * The second clip feeder, beside `clip-file-source.ts` + `RecordedFeeder`
 * and not in their place. The file path fetches the whole clip by handle,
 * indexes `stbl`, and lets the recorded feeder PULL access units by time.
 * This path is the other shape: the provider's clip STREAM
 * (`/clip-stream/…`, stage 1) is a fragmented MP4 written from the first
 * muxed byte, with no index and no length, and the bytes reach this process
 * as the camera delivers them. Nothing here pulls — the stream PUSHES, the
 * demuxer emits access units as their bytes land, and this feeder paces them
 * onto the session's track at the playback rate.
 *
 * ## Forward-only, and what that means for every verb
 *
 * The camera offers no seek inside a recording (operator's decision from the
 * packet capture, 2026-09-22): a replay names a FILE, and the bytes behind
 * the head were never kept. So:
 *
 * - `seek(t)` with `t` behind the HEAD (the last frame pushed) is REFUSED BY
 *   NAME — logged, the position re-sent so the viewer's playhead snaps back
 *   to the truth, and nothing else changes. "Back to the start" is as
 *   impossible as any other backward move; `forward` is measured against the
 *   head, never against zero (the viewer's `clipSeekAllowed` says the same).
 * - `seek(t)` ahead of the head is honoured if the bytes have arrived: what
 *   was buffered before the last keyframe ≤ `t` is dropped, the run from that
 *   keyframe to `t` is BURST (decode priming, as the recorded feeder's seek
 *   prefix does), and pacing resumes from `t`. If the bytes have NOT arrived,
 *   the seek waits for them and lands when they do — a stream cannot answer
 *   faster than the camera sends.
 * - `stepFrame(-1)` and the scrub verbs are refused by name; `stepFrame(+1)`
 *   pushes the next buffered unit.
 * - `setRate` is the PLAYER's rate over frames already here ({0} ∪ [0.25, 8],
 *   the recorded domain). The camera's own `playSpeed` (8, 16 — real, the app
 *   reopens the replay at 8) is a different mechanism and is NOT wired: it
 *   would go on the dial (`videoclips.dialClipStream` → the cmd-5 replay's
 *   `<playSpeed>`), costing a new stream, and is named in D597 as open.
 *
 * ## Duration is unknown until it is known
 *
 * A stream has no length up front. `durationMs()` resolves when the stream
 * ENDS, with the demuxer's own sum, or with `null` when it was cut or left
 * before it ended — never `0` (D393). The session reports it then, named by
 * clip, exactly as it reports the file path's measure.
 *
 * ## D9/D18, stated
 *
 * Media crosses the process boundary here COMPRESSED, in one TCP stream, at
 * the camera's delivery rate — the same shape the live path ingests from an
 * RTSP camera, and the same shape the file path's one by-handle fetch has,
 * spread over time instead of held whole. What D9 forbids is RAW frames at
 * frame-rate across processes, and nothing raw exists until the session's
 * decoder, which is downstream of this process. The backlog is bounded
 * ({@link CLIP_STREAM_BUFFER_MAX_BYTES}, the file path's own ceiling): above
 * it the socket is PAUSED (D447 on the consuming hop — read no chunk you have
 * not taken), and the producer's drain gate is what decides a consumer that
 * never drains. Frames behind the head are released as soon as they are
 * pushed, which is the same fact as "no backward seek".
 *
 * ## Sound, and the one clock it shares with the picture (D600)
 *
 * The stream carries audio ALREADY in the session's negotiated codec — the
 * provider transcodes before it muxes, because it is the process that holds
 * the camera's AAC and it already runs an ffmpeg. So this feeder decodes
 * nothing: it frames (`clip-stream-audio.ts`) and paces, on ONE schedule with
 * the video, on the SAME `ptsMs` axis the demuxer anchors both tracks on, and
 * off ONE {@link MonotonicClock} whose output is converted to each track's
 * RTP rate ({@link ClipStreamFeeder.stampAudio}). One clock rather than the
 * recorded path's pair: two clocks re-base on their own last output at every
 * discontinuity, so each seek leaves them a frame further apart.
 *
 * Two rules keep it honest, and both exist because a wrong one is inaudible
 * in a unit test:
 *
 * - **Audio is never pushed late.** ffmpeg's muxer writes a track's run when
 *   its own fragment closes, so the first seconds of sound can land after the
 *   picture they belong to (measured: 43 ms behind at the head on a 60x
 *   delivery, and nothing after). A unit whose moment has passed by more than
 *   {@link CLIP_STREAM_AUDIO_LATE_MS} is DROPPED and counted — never pushed
 *   in a burst the receiver would have to discard anyway, and never silently.
 * - **Audio plays at 1x only**, like the recorded feeder's: a rate change
 *   would need a resample this path has no decoder for, and pitch-shifted
 *   sound is worse than none. Units dropped for the rate are counted apart.
 *
 * What the clip turned out to carry — sound, or silence and WHY — settles on
 * {@link ClipStreamFeeder.audio} the moment the `moov` is read, and is what
 * the session reports to the viewer. A dial that promises a codec promises
 * the codec, never the content: whether the recording has a microphone track
 * is only ever knowable from the stream.
 *
 * ## Every exit is logged
 *
 * Opened, first frame (with the time since the seek and since the dial),
 * ended, cut (by reason), refused (by the provider's code), disposed, every
 * refused verb, and every backpressure transition — each with `deviceId` in
 * `data`, which the broker's `onLog` puts in `tags`.
 */
import { CLIP_SOURCE_MAX_BYTES } from './clip-file-source.js'
import {
  createClipAudioFramer,
  type ClipAudioFrame,
  type ClipAudioFramer,
} from './clip-stream-audio.js'
import { audioPlaysAtRate, BROKER_PACED_RATES, clampPlaybackRate } from './control-protocol.js'
import { MonotonicClock } from './feed-clock.js'
import {
  createFmp4StreamDemuxer,
  Fmp4DemuxError,
  type Fmp4AudioCodec,
  type Fmp4AudioUnit,
  type Fmp4StreamEnd,
} from './fmp4-stream-demux.js'
import type { FeederSink, FeederState, FeederStateTransition } from './recorded-feeder.js'
import type { AccessUnit } from './segment-demux.js'
import type { ClipPlaybackHandle, TimelineSessionClipFeeder } from './timeline-session.js'

/** The provider's answer to "where is this clip's stream". */
export type ClipStreamDialAnswer =
  | {
      readonly kind: 'dialed'
      readonly url: string
      readonly expiresAtMs: number
      /**
       * Which twin the stream ACTUALLY carries (D599). Not the ask: a `high`
       * on a recording with no main twin is streamed as its sub copy, and
       * this is the only place that says so. Optional for a provider that
       * predates the field — absent is "it did not say", never a claim.
       */
      readonly served?: string
      /**
       * Which audio codec the stream will carry (D600) — `served`'s companion
       * for sound. Optional for a provider that predates it: absent is "it
       * did not say", which this feeder reads as no sound rather than as a
       * promise it can wire a sink against.
       */
      readonly servedAudio?: string
      /** Why {@link servedAudio} is `none` although sound was asked for. */
      readonly audioReason?: string
    }
  /** The provider predates `videoclips.dialClipStream` — the file path is the only one it has. */
  | { readonly kind: 'unavailable'; readonly detail: string }
  /** The provider refused, in the clip vocabulary (`sleeping`, `catalog-miss`, …). */
  | { readonly kind: 'refused'; readonly code: string; readonly detail: string }

/**
 * Dial a clip's stream, naming the audio the caller can actually send.
 *
 * The ask travels on the DIAL and nowhere else: the provider's mux is spawned
 * once, before the first byte, and cannot gain a track afterwards.
 */
export type ClipStreamDialer = (
  handle: ClipPlaybackHandle,
  audio: ClipStreamAudioAsk,
) => Promise<ClipStreamDialAnswer>

/** What this feeder asks the provider to mux — `none` when nothing can play it. */
export type ClipStreamAudioAsk = Fmp4AudioCodec | 'none'

/** Why a clip stream is playing silent. Every one reaches the viewer. */
export type ClipAudioSilentReason =
  /** The WebRTC session negotiated no audio sender this feeder could push to. */
  | 'not-negotiated'
  /** The provider answered the dial with no audio — its own reason travels too. */
  | 'not-offered'
  /** The stream's `moov` declared no audio track: this recording has no sound. */
  | 'no-audio-track'
  /** A track exists in a codec this process cannot forward, named on the log line. */
  | 'unsupported-codec'
  /** The track's codec is not the one the session negotiated — never re-encoded here. */
  | 'codec-mismatch'
  /** The stream never got far enough to say — refused, or cut before its `moov`. */
  | 'stream-failed'
  /**
   * The clip IS carrying sound and the pacer is dropping it, because the rate
   * is not 1× (D600, D621). The one reason here that is not a permanent fact
   * about the clip: it comes and goes with the speed chip, which is why this
   * report is re-issued through {@link TimelineSessionClipFeeder.watchAudio}
   * instead of only settling once.
   */
  | 'rate'

/** What a clip TURNED OUT to carry. Settles when the `moov` is read, or at exit. */
export interface ClipAudioReport {
  readonly carried: boolean
  /** The codec being pushed, or `null` on every silent branch. */
  readonly codec: Fmp4AudioCodec | null
  /** Present iff {@link carried} is false — silence always has a reason (D391). */
  readonly reason: ClipAudioSilentReason | null
  /** The provider's own word when {@link reason} is `not-offered`. */
  readonly detail?: string
  /**
   * The rate the sound is suppressed AT. Present iff {@link reason} is
   * `rate` — "no sound because of the speed" without the speed is the same
   * unanswerable message it replaces, and the wire schema refuses the pair
   * any other way round.
   */
  readonly rate?: number
}

/** The open stream, as the feeder drives it — a `node:http` response in production. */
export interface ClipStreamConnection {
  pause(): void
  resume(): void
  destroy(): void
}

/**
 * What the PROVIDER says about the stream it just finished (D623).
 *
 * Not the broker's own measurement. `durationMs()` says how long the media
 * that arrived runs; this says whether that is the whole clip — which only
 * the provider can answer, because only it holds the camera's catalog row.
 * Two authorities on one question is how the two come to disagree (D62), so
 * the broker relays this and never derives it.
 */
export interface ClipIncompleteReport {
  readonly code: 'stream-short' | 'stream-empty'
  /** The provider's own sentence, shown where the stream error is shown. */
  readonly reason: string
}

export interface ClipStreamHandlers {
  onData(chunk: Uint8Array): void
  /**
   * The body ended. `report` is the provider's word on whether it was whole —
   * `null` when it said nothing, which is a whole stream. NOT optional in
   * spirit: a hop that forgets to pass it turns a truncated clip back into a
   * silent success, which is exactly the defect this channel exists to end.
   */
  onEnd(report: ClipIncompleteReport | null): void
  onError(err: Error): void
}

export type ClipStreamOpened =
  | { readonly kind: 'open'; readonly connection: ClipStreamConnection }
  /** A status line instead of bytes: the provider's reason code travels with it. */
  | {
      readonly kind: 'refused'
      readonly status: number
      readonly code: string
      readonly detail: string
    }

/**
 * The reason an in-flight open is abandoned, carried on the abort so the
 * opener's refusal and the provider's log line say the same thing.
 */
export const CLIP_STREAM_ABANDONED = 'clip-stream-abandoned'

/**
 * Dial the URL and take the bytes.
 *
 * The third argument is the whole cancellation contract, and it is not
 * optional in spirit: until it existed the caller's ONLY handle on the
 * request was `ClipStreamConnection.destroy()`, which does not exist until
 * the provider has sent a status line. A provider that has queued the request
 * behind others sends no status line for as long as it is queued — so a
 * feeder torn down in the meantime held the socket, and the provider, whose
 * per-host lane is strictly serial, went on believing the peer was there.
 *
 * Measured on the hub 2026-09-23 18:17–18:19 (D391): a feeder disposed at
 * 18:17:51.470 with `phaseBefore: "opening"` was only seen to leave at
 * 18:18:10.443 — `CLIP_STREAM_HEADERS_TIMEOUT_MS` to the millisecond — and
 * the sixteen requests queued behind it all drained together with `waitedMs`
 * between 29 996 and 30 000. Nothing the operator tapped played.
 */
export type ClipStreamOpener = (
  url: string,
  handlers: ClipStreamHandlers,
  signal: AbortSignal,
) => Promise<ClipStreamOpened>

export interface ClipStreamFeederDeps {
  readonly handle: ClipPlaybackHandle
  readonly dial: ClipStreamDialer
  readonly open: ClipStreamOpener
  readonly sink: FeederSink
  /**
   * The audio codec this session's sender negotiated, or absent when it
   * negotiated none. Absent means the dial asks for `none` and the audio
   * track is not followed at all — nothing is demuxed for a sink that does
   * not exist.
   */
  readonly audio?: Fmp4AudioCodec
  onState(transition: FeederStateTransition): void
  onPosition(epochMs: number): void
  /** Every exit and every refused verb. `deviceId` is in every `data`. */
  onLog?(msg: string, data: Record<string, unknown>): void
  /** Backlog ceiling before the socket is paused. Absent ⇒ {@link CLIP_STREAM_BUFFER_MAX_BYTES}. */
  readonly maxBufferedBytes?: number
  /** Silence on the socket before the stream is cut. Absent ⇒ {@link CLIP_STREAM_STALL_MS}. */
  readonly stallTimeoutMs?: number
  /** Media in hand before pacing starts. Absent ⇒ {@link CLIP_STREAM_PREROLL_MS}. */
  readonly prerollMs?: number
  /** Wall clock for pacing; tests inject one. Absent ⇒ `Date.now`. */
  readonly now?: () => number
}

/**
 * The same ceiling as the file path (`CLIP_SOURCE_MAX_BYTES`): a clip the
 * file path would refuse `too-large` is one this path stops taking. Frames
 * behind the head are released as they are pushed, so the backlog is the
 * distance between arrival and playback, not the clip.
 */
export const CLIP_STREAM_BUFFER_MAX_BYTES = CLIP_SOURCE_MAX_BYTES

/**
 * Longer than the producer's own drain gate (10 s) and its idle window
 * (300 ms) together: a socket this quiet has a producer that is stuck, not
 * one that is draining. Measured stage 1: a whole 37 s clip arrives in 682 ms.
 */
export const CLIP_STREAM_STALL_MS = 15_000

/**
 * How much media must be in hand before the pacer starts, and after a starve.
 *
 * **A pacer at rate 1 against a source that arrives at 1× is two clocks of the
 * same speed with nothing between them.** The queue never builds, so the first
 * jitter on the camera, the mux or the host empties it. Measured live on 1436
 * on 2026-09-23 — `clip-stream:starved { rate: 1, headMs: 480, arrivedMs: 480 }`
 * — `headMs === arrivedMs` exactly: the pacer had consumed precisely
 * everything that existed. 880 ms of media played and the viewer fell back to
 * live.
 *
 * **Derived, not chosen.** Measured end to end through the real producer and
 * the broker's OWN demuxer, four runs against the real camera:
 *
 * | | measured |
 * | --- | --- |
 * | media arrival rate | 1.017× |
 * | media delivered per hand-over | p50 160 ms, p99 320 ms, max 320 ms |
 * | worst deficit against a zero-cushion pacer | 189, 193, 194, 197 ms |
 *
 * Then the measured curve was replayed through the pacer at each candidate,
 * which is the claim itself rather than an argument about it:
 *
 * | cushion | starves over 26 s | worst queue left |
 * | --- | --- | --- |
 * | 0 ms | **70** | −196 ms |
 * | 200 ms | 0 | 4 ms |
 * | 400 ms | 0 | 204 ms |
 * | **600 ms** | **0** | **404 ms** |
 * | 1 000 ms | 0 | 804 ms |
 *
 * 200 ms clears the measured worst deficit with four milliseconds to spare,
 * which is not a cushion, it is a coincidence. 600 ms leaves 404 ms — room for
 * a second, independent hiccup twice as bad as the worst one on the wire — on
 * a hub busier than the machine this was measured on.
 *
 * **It is charged only where it is missing.** The anchor is pushed out by the
 * SHORTFALL, so a source that already has the clip in hand pays nothing:
 * Reolink lands a whole clip at 49–62× and starts as immediately as it ever
 * did. Only a realtime source pays, and it pays once.
 */
export const CLIP_STREAM_PREROLL_MS = 600

/**
 * How far past its moment an audio unit may still be pushed.
 *
 * ffmpeg's muxer writes a track's run when its own fragment closes, so the
 * head of a stream can carry sound slightly behind the picture it belongs to
 * — MEASURED at 43 ms worst case on a 60x delivery of a 20 s clip, and zero
 * after the first fragment. 120 ms is under the lip-sync bound a listener
 * notices and under any receiver's jitter buffer, so a frame inside it is
 * still worth sending; past it the receiver would discard it anyway, and
 * pushing it would be the burst this rule exists to prevent.
 */
export const CLIP_STREAM_AUDIO_LATE_MS = 120

/** The RTP clock each codec's re-stamped timestamps are counted on. */
const AUDIO_CLOCK_HZ: Readonly<Record<Fmp4AudioCodec, number>> = { opus: 48_000, pcmu: 8_000 }

/** A forward seek is a discontinuity for the receiver, like the recorded feeder's. */
const SEEK_DISCONTINUITY_MS = 250
const WAIT_TICK_MS = 250
const POSITION_INTERVAL_MS = 1000

type Phase = 'idle' | 'opening' | 'streaming' | 'ended' | 'cut' | 'refused' | 'disposed'

/** Why a stream that had opened stopped short. Every one is logged. */
export type ClipStreamCutReason = 'stream-stalled' | 'stream-failed' | 'demux-refused'

interface DurationWaiter {
  (value: number | null): void
}

export function createClipStreamFeeder(deps: ClipStreamFeederDeps): TimelineSessionClipFeeder {
  return new ClipStreamFeeder(deps)
}

class ClipStreamFeeder implements TimelineSessionClipFeeder {
  private phase: Phase = 'idle'
  private connection: ClipStreamConnection | null = null
  /** Armed for the length of one `open()`; aborted by {@link teardown}. */
  private opening: AbortController | null = null
  private readonly demuxer: ReturnType<typeof createFmp4StreamDemuxer>
  private readonly clock = new MonotonicClock()
  /** The RTP rate the audio sender negotiated — a CONVERSION, not a clock. */
  private readonly audioClockHz: number
  private readonly audioAsk: ClipStreamAudioAsk
  private readonly audioPush: ((data: Uint8Array, rtpTs: number) => void) | null
  private audioFramer: ClipAudioFramer | null = null
  private audioQueue: ClipAudioFrame[] = []
  private audioQueuedBytes = 0
  private audioPushed = 0
  private audioDroppedLate = 0
  private audioDroppedRate = 0
  /**
   * The last report handed to a caller — the settle promise's value, or the
   * newest one {@link watchAudio}'s listener was given. What a change is
   * measured against, so the same answer is never announced twice.
   */
  private audioEmitted: ClipAudioReport | null = null
  /**
   * The last NON-ZERO rate. Pause is the absence of a rate, not a rate: a
   * `clipAudio` blaming the speed while the clip is stopped would be false,
   * and un-pausing would have to take it back.
   */
  private audioRate = 1
  private audioListener: ((report: ClipAudioReport) => void) | null = null
  private audioDroppedSeek = 0
  private firstAudioLogged = false
  private audioReport: ClipAudioReport | null = null
  private readonly audioWaiters: ((report: ClipAudioReport) => void)[] = []
  /** The provider's last word, and whether it has been given. Settled is not
   *  the same as non-null: a whole stream settles `null` (D623). */
  private incompleteSettled = false
  private incompleteReport: ClipIncompleteReport | null = null
  private readonly incompleteWaiters: ((report: ClipIncompleteReport | null) => void)[] = []
  private clockHasAdvanced = false
  private rate = 1
  private queue: AccessUnit[] = []
  private queuedBytes = 0
  private headMs: number | null = null
  private arrivedMs: number | null = null
  private pendingSeekMs: number | null = null
  private pendingSteps = 0
  private seekToken = 0
  private anchorWall = 0
  private anchorPts = 0
  private paceTimer: ReturnType<typeof setTimeout> | null = null
  private positionTimer: ReturnType<typeof setInterval> | null = null
  private stallTimer: ReturnType<typeof setTimeout> | null = null
  private socketPaused = false
  private streamEnded = false
  private streamEnd: Fmp4StreamEnd | null = null
  private duration: { readonly settled: true; readonly value: number | null } | null = null
  private readonly durationWaiters: DurationWaiter[] = []
  private lastAnnounced: FeederState | null = null
  private scrubRefusedFor: string | null | undefined = undefined
  private pushed = 0
  /** How many times the pacer wanted a frame the stream had not produced. */
  private starved = 0
  private dropped = 0
  private bytesIn = 0
  private dialedAt: number | null = null
  private seekStartedAt: number | null = null
  private firstFrameLogged = false
  private readonly maxBufferedBytes: number
  private readonly stallTimeoutMs: number
  private readonly prerollMs: number
  /** True while the pacer is waiting for the cushion to refill after a starve. */
  private rebuffering = false
  private readonly now: () => number
  private readonly tags: { readonly deviceId: number; readonly clipId: string }

  constructor(private readonly deps: ClipStreamFeederDeps) {
    this.maxBufferedBytes = deps.maxBufferedBytes ?? CLIP_STREAM_BUFFER_MAX_BYTES
    this.stallTimeoutMs = deps.stallTimeoutMs ?? CLIP_STREAM_STALL_MS
    this.prerollMs = deps.prerollMs ?? CLIP_STREAM_PREROLL_MS
    this.now = deps.now ?? (() => Date.now())
    this.tags = { deviceId: deps.handle.deviceId, clipId: deps.handle.clipId }
    // The ask is what THIS SESSION can send, resolved once: a sink function
    // that is not there is the same answer as a codec that was not
    // negotiated, and both mean the audio track is never followed.
    const push = this.resolveAudioPush(deps)
    this.audioAsk = push === null ? 'none' : (deps.audio ?? 'none')
    this.audioPush = this.audioAsk === 'none' ? null : push
    this.audioClockHz =
      this.audioAsk === 'none' ? AUDIO_CLOCK_HZ.pcmu : AUDIO_CLOCK_HZ[this.audioAsk]
    this.demuxer = createFmp4StreamDemuxer(
      this.audioPush === null ? {} : { onAudio: (unit) => this.onAudioUnit(unit) },
    )
    if (this.audioPush === null) {
      this.settleAudio({ carried: false, codec: null, reason: 'not-negotiated' })
    }
  }

  /**
   * The sink function for the negotiated codec, or `null`.
   *
   * Mirrors `RecordedFeeder.resolveAudioPush`: the sink is what decides, and
   * a session that offered a codec on the dial but wired no push for it would
   * otherwise make the provider transcode for nobody.
   */
  private resolveAudioPush(
    deps: ClipStreamFeederDeps,
  ): ((data: Uint8Array, rtpTs: number) => void) | null {
    const { sink, audio } = deps
    if (audio === 'opus') {
      const opus = sink.pushAudioOpus
      return opus === undefined ? null : (data, ts) => opus.call(sink, data, ts)
    }
    if (audio === 'pcmu') {
      const pcmu = sink.pushAudioPcmu
      return pcmu === undefined ? null : (data, ts) => pcmu.call(sink, data, ts)
    }
    return null
  }

  // ── the verbs ────────────────────────────────────────────────────────────

  async seek(epochMs: number): Promise<void> {
    const token = ++this.seekToken
    if (this.phase === 'disposed' || this.phase === 'cut' || this.phase === 'refused') {
      this.log('clip-stream:seek-after-exit', { targetMs: epochMs, phase: this.phase })
      return
    }
    if (this.phase === 'ended') {
      // Nothing is ahead of the head any more, and nothing behind it was kept.
      this.log('clip-stream:seek-at-end', { targetMs: epochMs, headMs: this.headMs })
      if (this.headMs !== null) this.deps.onPosition(this.headMs)
      return
    }
    if (this.headMs !== null && epochMs < this.headMs) {
      // REFUSED BY NAME. The frames behind the head were never kept, and the
      // camera cannot re-send them; the viewer is told where the head really
      // is so its playhead does not draw a position nobody can reach.
      this.log('clip-stream:seek-backward-refused', {
        targetMs: epochMs,
        headMs: this.headMs,
        behindMs: this.headMs - epochMs,
      })
      this.deps.onPosition(this.headMs)
      return
    }
    this.seekStartedAt = this.now()
    this.stopPacing()
    this.pendingSeekMs = epochMs
    if (this.phase === 'idle') {
      await this.open(token)
      if (token !== this.seekToken) return
      if (!this.isStreaming()) return
    } else if (this.headMs !== null && epochMs > this.headMs && this.clockHasAdvanced) {
      // A forward jump: unmistakable to the receiver, like any other seek.
      this.clock.markDiscontinuity(SEEK_DISCONTINUITY_MS)
      this.emitState('loading', 'seek-forward', token)
      this.log('clip-stream:seek-forward', {
        targetMs: epochMs,
        headMs: this.headMs,
        arrivedMs: this.arrivedMs,
        queued: this.queue.length,
      })
    }
    this.resolvePendingSeek(token)
  }

  setRate(rate: number): void {
    const next = clampPlaybackRate(rate)
    // A rate this feeder ACCEPTED and will not deliver is the branch D391
    // names: it produces motion, just not the motion that was asked for, and
    // silence there reads as "the rate worked". `BROKER_PACED_RATES` is what the
    // viewer was told it could ask for, so a line here means the two
    // disagreed — an older viewer with its own list, or a newer one drawing
    // from something else.
    if (next !== rate) {
      this.log('clip-stream:rate-not-delivered', {
        requested: rate,
        applied: next,
        deliverable: BROKER_PACED_RATES,
      })
    }
    if (next === 0) {
      this.rate = 0
      this.stopPacing()
      this.stopPositionReports()
      if (this.phase === 'streaming' && this.pendingSeekMs === null) {
        this.emitState('paused', 'set-rate-zero', this.seekToken)
      }
      return
    }
    this.clock.setRate(next)
    const wasPaused = this.rate === 0
    this.rate = next
    // The sound answer can CHANGE here, and it is the only report that can:
    // the clip still carries audio, the pacer has simply stopped forwarding
    // it. A viewer told nothing hears the same silence a broken stream makes.
    this.audioRate = next
    this.refreshAudioReport()
    if (this.phase !== 'streaming' || this.pendingSeekMs !== null) return
    if (wasPaused) this.emitState('playing', 'set-rate-resume', this.seekToken)
    this.startPacing()
  }

  stepFrame(dir: 1 | -1): void {
    if (this.rate !== 0 || this.phase !== 'streaming') return
    if (dir === -1) {
      this.log('clip-stream:step-backward-refused', { headMs: this.headMs })
      return
    }
    if (!this.pushNext()) {
      if (this.streamEnded) {
        this.log('clip-stream:step-at-end', { headMs: this.headMs })
        return
      }
      // The next frame has not arrived: it is pushed the moment it does.
      this.pendingSteps += 1
    }
  }

  beginScrub(dragId?: string): void {
    // One line per drag, not one per pointer move.
    if (this.scrubRefusedFor === dragId) return
    this.scrubRefusedFor = dragId
    this.log('clip-stream:scrub-refused', { dragId, reason: 'forward-only', headMs: this.headMs })
  }

  scrubTo(): void {
    // Refused with the drag it belongs to, above. A stream has no random access.
  }

  scrubAck(): void {
    // Nothing was pushed for a scrub, so there is no credit to repay.
  }

  durationMs(): Promise<number | null> {
    if (this.duration !== null) return Promise.resolve(this.duration.value)
    return new Promise((resolve) => this.durationWaiters.push(resolve))
  }

  /**
   * Did the provider deliver this clip whole? (D623)
   *
   * Resolves `null` for a whole stream AND for one that never got to say —
   * cut, disposed, or opened against a provider that adds no trailer. Both are
   * "nothing to tell the operator", and neither may be reported as a defect:
   * a cut already announces itself as `state: error`, and inventing a second
   * complaint for it would file one fault twice.
   */
  incomplete(): Promise<ClipIncompleteReport | null> {
    if (this.incompleteSettled) return Promise.resolve(this.incompleteReport)
    return new Promise((resolve) => this.incompleteWaiters.push(resolve))
  }

  /**
   * What this clip turned out to carry as sound — the answer the viewer needs
   * to say "this clip has no audio" rather than leave the operator wondering.
   *
   * Settles as soon as the stream's `moov` has been read, which is the first
   * fragment, so it lands beside `durationMs()`'s much later answer rather
   * than waiting for the stream to end.
   */
  audio(): Promise<ClipAudioReport> {
    const settled = this.audioReport
    if (settled !== null) return Promise.resolve(this.audioNow(settled))
    return new Promise((resolve) => this.audioWaiters.push(resolve))
  }

  /**
   * Follow the audio answer for as long as this clip is on the pointer.
   *
   * {@link audio} settles ONCE, because what the stream carries is decided
   * once — at the `moov`. The RATE is not: it moves under the operator's
   * finger, and a one-shot report cannot say that the clip which had sound a
   * second ago is silent now because he pressed 2×. The listener is told only
   * when the answer really changes, never the settle it already awaited.
   *
   * One listener, replaced rather than added to: there is one session behind
   * one clip, and a list would outlive the pointer.
   */
  watchAudio(listener: (report: ClipAudioReport) => void): void {
    this.audioListener = listener
  }

  dispose(): void {
    if (this.phase === 'disposed') return
    const before = this.phase
    this.phase = 'disposed'
    this.teardown()
    this.settleDuration(null)
    this.settleIncomplete(null)
    this.settleAudio({ carried: false, codec: null, reason: 'stream-failed' })
    this.log('clip-stream:disposed', {
      phaseBefore: before,
      pushed: this.pushed,
      dropped: this.dropped,
      queued: this.queue.length,
      bytesIn: this.bytesIn,
      headMs: this.headMs,
    })
    this.queue = []
    this.queuedBytes = 0
    this.audioQueue = []
    this.audioQueuedBytes = 0
  }

  /** A method, not a field read: `open()` moves the phase behind an await
   *  that control-flow analysis does not see through. */
  private isStreaming(): boolean {
    return this.phase === 'streaming'
  }

  // ── opening ──────────────────────────────────────────────────────────────

  private async open(token: number): Promise<void> {
    this.phase = 'opening'
    this.emitState('loading', 'dial', token)
    this.dialedAt = this.now()
    let answer: ClipStreamDialAnswer
    try {
      answer = await this.deps.dial(this.deps.handle, this.audioAsk)
    } catch (err) {
      answer = { kind: 'refused', code: 'fetch-failed', detail: describe(err) }
    }
    if (this.phase !== 'opening') return
    if (answer.kind !== 'dialed') {
      this.settleAudio({ carried: false, codec: null, reason: 'stream-failed' })
      this.refuse(
        answer.kind === 'unavailable' ? 'stream-unavailable' : answer.code,
        answer.detail,
        token,
        answer.kind === 'unavailable'
          ? `the provider behind this clip predates videoclips.dialClipStream — deploy ${this.deps.handle.provider}, or use the file path`
          : undefined,
      )
      return
    }
    // A DOWNGRADE, not any difference. `mid` maps onto the sub twin by
    // design, so `served !== asked` fires on every ordinary clip and the line
    // would mean nothing. The one thing worth a line is the operator asking
    // for the best copy and not getting it — `high` reaches the stream since
    // D599, and a recording with no main twin is streamed as its sub copy.
    // Refusing used to be what stopped that being silent; this is.
    if (
      this.deps.handle.profile === 'high' &&
      answer.served !== undefined &&
      answer.served !== 'high'
    ) {
      this.deps.onLog?.('clip stream: no main twin — streaming the sub copy for a `high` ask', {
        deviceId: this.deps.handle.deviceId,
        asked: 'high',
        served: answer.served,
      })
    }
    // And the MIRROR IMAGE, which D599 had no room for. A source that archives
    // only its main copy — every Hikvision camera on this fleet — answers a
    // `low` or `mid` ask with `high`, because that is the only media there is.
    // That is honest and it is not refusable, but it costs roughly 33x the
    // bytes of the sub copy a Reolink would have served, and a rule that fires
    // only on a downgrade makes exactly that cost invisible (D382: a cost paid
    // by a caller who never stated the ask). This line is not the downgrade's
    // opposite twin by accident: the two say different things and a surface
    // that read one as the other would call an upgrade a fault.
    const askedProfile = this.deps.handle.profile
    if (
      askedProfile !== undefined &&
      askedProfile !== null &&
      askedProfile !== 'high' &&
      answer.served === 'high'
    ) {
      this.deps.onLog?.('clip stream: only the main copy exists — serving it for a cheaper ask', {
        deviceId: this.deps.handle.deviceId,
        asked: askedProfile,
        served: answer.served,
      })
    }
    // The audio half of the same reasoning (D600). A provider that did not
    // say, or that said `none`, is not going to carry sound — and the viewer
    // is told WHY rather than left to notice the silence.
    if (this.audioAsk !== 'none' && answer.servedAudio !== this.audioAsk) {
      this.settleAudio({
        carried: false,
        codec: null,
        reason: 'not-offered',
        detail: answer.audioReason ?? answer.servedAudio ?? 'the provider did not say',
      })
      this.log('clip-stream:audio-not-offered', {
        asked: this.audioAsk,
        servedAudio: answer.servedAudio ?? null,
        audioReason: answer.audioReason ?? null,
      })
    }
    // The request is abandonable from the instant it is made. `teardown()`
    // aborts this, and the opener hangs up on the provider rather than
    // leaving it to the headers timeout (D391, D382: a lane held by a peer
    // that has gone is work nobody is waiting for).
    const abandon = new AbortController()
    this.opening = abandon
    let opened: ClipStreamOpened
    try {
      opened = await this.deps.open(
        answer.url,
        {
          onData: (chunk) => this.onData(chunk),
          onEnd: (report) => this.onEnd(report),
          onError: (err) => this.cut('stream-failed', err.message),
        },
        abandon.signal,
      )
    } catch (err) {
      opened = { kind: 'refused', status: 0, code: 'fetch-failed', detail: describe(err) }
    }
    if (this.opening === abandon) this.opening = null
    if (this.phase !== 'opening') {
      // A branch that ACCEPTED work and produces nothing is the same branch as
      // one that drops it (D391). This one used to return in silence, which is
      // why nineteen seconds of a camera's only lane left no line at all.
      if (opened.kind === 'open') opened.connection.destroy()
      this.log('clip-stream:open-abandoned', {
        phase: this.phase,
        opened: opened.kind,
        sinceDialMs: this.now() - (this.dialedAt ?? this.now()),
        ...(opened.kind === 'refused' ? { code: opened.code } : {}),
      })
      return
    }
    if (opened.kind === 'refused') {
      this.refuse(opened.code, opened.detail, token, undefined, opened.status)
      return
    }
    this.connection = opened.connection
    this.phase = 'streaming'
    this.armStall()
    this.applyBackpressure()
    this.log('clip-stream:opened', {
      sinceDialMs: this.now() - (this.dialedAt ?? this.now()),
      expiresInMs: answer.expiresAtMs - Date.now(),
    })
  }

  private refuse(
    code: string,
    detail: string,
    token: number,
    hint?: string,
    status?: number,
  ): void {
    this.phase = 'refused'
    this.teardown()
    this.settleDuration(null)
    this.settleIncomplete(null)
    this.settleAudio({ carried: false, codec: null, reason: 'stream-failed' })
    this.log('clip-stream:refused', {
      code,
      detail,
      ...(hint !== undefined ? { hint } : {}),
      ...(status !== undefined ? { status } : {}),
    })
    this.emitState('error', `refused:${code}`, token)
  }

  // ── the stream ───────────────────────────────────────────────────────────

  /**
   * Bytes are taken while OPENING too. Node flushes body bytes it already
   * holds on `process.nextTick` the moment the `data` listener attaches,
   * and that tick runs BEFORE the promise continuation that flips this
   * feeder to `streaming` — so the head of the stream (ftyp, moov) arrives
   * while the phase still says `opening`. Dropping it there turned every
   * live stream into `no-moov` while a fake opener, which delivered only
   * after resolving, kept the suite green (2026-09-22).
   */
  private takesBytes(): boolean {
    return this.phase === 'streaming' || this.phase === 'opening'
  }

  private onData(chunk: Uint8Array): void {
    if (!this.takesBytes()) return
    this.bytesIn += chunk.byteLength
    this.armStall()
    let units: readonly AccessUnit[]
    try {
      units = this.demuxer.push(chunk)
    } catch (err) {
      const reason = err instanceof Fmp4DemuxError ? err.reason : 'malformed'
      this.cut('demux-refused', `${reason}: ${describe(err)}`)
      return
    }
    for (const unit of units) {
      this.queue.push(unit)
      this.queuedBytes += unit.data.byteLength
      this.arrivedMs = unit.ptsMs
    }
    this.settleAudioFromMoov()
    if (units.length > 0 || this.audioQueue.length > 0) this.onUnitsArrived()
    this.applyBackpressure()
  }

  /**
   * What the stream really carries, decided from the `moov` and said ONCE.
   *
   * This is the answer a dial cannot give: the provider promises a codec
   * before the camera has delivered a single audio frame, and whether the
   * recording HAS sound is written in the container it produced. A track in a
   * codec this process cannot forward, or in one the session did not
   * negotiate, is named here and never re-encoded — a second transcode on
   * this hop is exactly the backlog this path is built to avoid.
   */
  private settleAudioFromMoov(): void {
    if (this.audioReport !== null || this.audioPush === null) return
    const state = this.demuxer.audio
    if (state.kind === 'unknown') return
    if (state.kind === 'absent') {
      this.settleAudio({ carried: false, codec: null, reason: 'no-audio-track' })
      this.log('clip-stream:audio-absent', { asked: this.audioAsk })
      return
    }
    if (state.kind === 'unsupported') {
      this.settleAudio({ carried: false, codec: null, reason: 'unsupported-codec' })
      this.log('clip-stream:audio-unsupported', {
        asked: this.audioAsk,
        sampleEntry: state.sampleEntry,
      })
      return
    }
    if (state.codec !== this.audioAsk) {
      this.settleAudio({ carried: false, codec: null, reason: 'codec-mismatch' })
      this.log('clip-stream:audio-codec-mismatch', { asked: this.audioAsk, got: state.codec })
      return
    }
    this.audioFramer = createClipAudioFramer(state.codec)
    this.settleAudio({ carried: true, codec: state.codec, reason: null })
    this.log('clip-stream:audio-ready', {
      codec: state.codec,
      sampleRateHz: state.sampleRateHz,
      channels: state.channels,
    })
  }

  /** One demuxed audio sample, framed and queued on the same axis as video. */
  private onAudioUnit(unit: Fmp4AudioUnit): void {
    // Fires DURING `demuxer.push`, so the report is settled from here first:
    // a sample only exists once the `moov` has been read, which is exactly
    // what the report is waiting on.
    this.settleAudioFromMoov()
    const framer = this.audioFramer
    if (framer === null) return
    for (const frame of framer.push(unit)) {
      this.audioQueue.push(frame)
      this.audioQueuedBytes += frame.data.byteLength
    }
  }

  private onUnitsArrived(): void {
    if (this.pendingSeekMs !== null) {
      this.resolvePendingSeek(this.seekToken)
      return
    }
    while (this.rate === 0 && this.pendingSteps > 0 && this.pushNext()) this.pendingSteps -= 1
    if (this.rate === 0) return
    if (this.rebuffering) {
      // Nothing moves until the cushion is back — or until the stream ends,
      // when there is no more cushion to be had and the rest plays out.
      if (this.cushionShortfallMs() > 0) return
      this.rebuffering = false
      this.log('clip-stream:refilled', {
        headMs: this.headMs,
        arrivedMs: this.arrivedMs,
        queued: this.queue.length,
        starved: this.starved,
      })
      this.startPacing()
      return
    }
    if (this.paceTimer === null) this.tick()
  }

  private onEnd(report: ClipIncompleteReport | null): void {
    if (!this.takesBytes()) return
    this.settleIncomplete(report)
    this.streamEnded = true
    this.clearStall()
    this.streamEnd = this.demuxer.end()
    this.log('clip-stream:ended', {
      starved: this.starved,
      samples: this.streamEnd.samples,
      durationMs: this.streamEnd.durationMs,
      bytesIn: this.bytesIn,
      trailingBytes: this.streamEnd.trailingBytes,
      pendingSamples: this.streamEnd.pendingSamples,
      queued: this.queue.length,
    })
    // Absent is `null`, never 0: a stream that emitted nothing has no length.
    this.settleDuration(this.streamEnd.durationMs)
    if (this.pendingSeekMs !== null) {
      this.resolvePendingSeek(this.seekToken)
      return
    }
    if (this.rate === 0) return
    // The END makes the cushion moot: there is no more media coming, so an
    // anchor still holding a shortfall open would stall the tail of a clip
    // that is entirely in hand. Whatever is left plays out now, at its own
    // pace. A short clip that finished arriving DURING the pre-roll is the
    // ordinary case here, not the exotic one.
    if (this.rebuffering || this.anchorWall > this.now()) {
      this.rebuffering = false
      this.startPacing()
      return
    }
    if (this.paceTimer === null) this.tick()
  }

  private cut(reason: ClipStreamCutReason, detail: string): void {
    if (this.phase !== 'streaming' && this.phase !== 'opening') return
    this.phase = 'cut'
    this.teardown()
    this.settleDuration(null)
    this.settleIncomplete(null)
    this.settleAudio({ carried: false, codec: null, reason: 'stream-failed' })
    this.log('clip-stream:cut', {
      reason,
      detail,
      pushed: this.pushed,
      queued: this.queue.length,
      bytesIn: this.bytesIn,
      headMs: this.headMs,
      arrivedMs: this.arrivedMs,
      ...this.audioTally(),
    })
    this.emitState('error', `cut:${reason}`, this.seekToken)
  }

  private armStall(): void {
    this.clearStall()
    this.stallTimer = setTimeout(
      () => this.cut('stream-stalled', `no bytes for ${this.stallTimeoutMs} ms`),
      this.stallTimeoutMs,
    )
  }

  private clearStall(): void {
    if (this.stallTimer !== null) clearTimeout(this.stallTimer)
    this.stallTimer = null
  }

  /** D447 on the consuming hop: pause the socket above the bound, resume below half. */
  private applyBackpressure(): void {
    // Deferred until the socket is in hand: `open()` re-applies it then.
    if (this.connection === null) return
    const held = this.queuedBytes + this.audioQueuedBytes + this.demuxer.pendingBytes
    if (!this.socketPaused && held > this.maxBufferedBytes) {
      this.socketPaused = true
      this.connection?.pause()
      this.log('clip-stream:backpressure-paused', {
        heldBytes: held,
        maxBytes: this.maxBufferedBytes,
      })
    } else if (this.socketPaused && held < this.maxBufferedBytes / 2) {
      this.socketPaused = false
      this.connection?.resume()
      this.log('clip-stream:backpressure-resumed', { heldBytes: held })
    }
  }

  // ── seeking and pacing ───────────────────────────────────────────────────

  /**
   * Land a pending seek if its bytes are here. Called on the seek itself,
   * on every arrival while one is pending, and on end-of-stream (the last
   * chance: a target past the end lands on the last frame and the clip ends).
   */
  private resolvePendingSeek(token: number): void {
    const target = this.pendingSeekMs
    if (target === null || this.phase !== 'streaming') return
    // Drop what precedes the last keyframe ≤ target — a delta frame needs
    // the keyframe before it, and the decoder is primed by the burst below.
    // Done BEFORE the target has arrived too, so a seek far ahead holds one
    // GOP while it waits, not the whole run the camera sends in the meantime.
    let keep = 0
    for (let i = 0; i < this.queue.length; i++) {
      const unit = this.queue[i]
      if (unit === undefined || unit.ptsMs > target) break
      if (unit.keyframe) keep = i
    }
    if (keep > 0) {
      for (let i = 0; i < keep; i++) this.queuedBytes -= this.queue[i]?.data.byteLength ?? 0
      this.dropped += keep
      this.queue = this.queue.slice(keep)
    }
    const arrived = this.arrivedMs !== null && this.arrivedMs >= target
    if (!arrived && !this.streamEnded) return
    if (this.queue.length === 0) {
      if (this.streamEnded) {
        this.pendingSeekMs = null
        this.log('clip-stream:seek-past-end', { targetMs: target, headMs: this.headMs })
        this.finish()
      }
      return
    }
    // Burst the run up to the target — at least one frame, so a seek always paints.
    let burst = 0
    while (this.queue.length > 0) {
      const next = this.queue[0]
      if (next === undefined || (burst > 0 && next.ptsMs > target)) break
      this.pushNext()
      burst += 1
    }
    this.pendingSeekMs = null
    this.dropAudioBefore(this.headMs)
    this.log('clip-stream:seek-landed', {
      targetMs: target,
      landedMs: this.headMs,
      droppedUnits: keep,
      burstUnits: burst,
      queued: this.queue.length,
      streamEnded: this.streamEnded,
    })
    if (this.headMs !== null) this.deps.onPosition(this.headMs)
    if (this.rate === 0) {
      this.emitState('paused', 'seek-landed-paused', token)
      return
    }
    this.emitState('playing', 'seek-landed', token)
    this.startPacing()
  }

  /**
   * The audio RTP timestamp for a source instant — off the SAME clock as the
   * video, converted to the negotiated rate.
   *
   * ONE mapping from source time to output time, not two. The recorded path
   * runs a second `MonotonicClock` for audio and keeps the pair aligned by
   * calling `markSeek()` on both, and that alignment is only as good as the
   * discipline: each clock re-bases on its OWN last output, so every
   * discontinuity leaves the two a frame further apart than it found them —
   * a skew that is invisible on a short clip, grows with each seek, and is
   * exactly the drift this path is not going to pay for twice. Deriving the
   * audio stamp from the video clock's own output makes the alignment
   * structural: there is nothing to keep in step.
   *
   * The conversion is exact to within a rounding tick (the video clock counts
   * 90 kHz, so an output instant is known to 1/90 ms) and is computed from
   * the source pts every time, never accumulated.
   */
  private stampAudio(ptsMs: number): number {
    return Math.round((this.clock.stamp(ptsMs) * this.audioClockHz) / 90_000)
  }

  /** Forget sound the playhead has already passed — a forward seek's share. */
  private dropAudioBefore(headMs: number | null): void {
    if (headMs === null || this.audioQueue.length === 0) return
    let drop = 0
    while (drop < this.audioQueue.length) {
      const frame = this.audioQueue[drop]
      if (frame === undefined || frame.ptsMs + frame.durationMs >= headMs) break
      this.audioQueuedBytes -= frame.data.byteLength
      drop += 1
    }
    if (drop === 0) return
    // No clock mark: a gap in the SOURCE timestamps maps to a gap in the
    // output, which is what a skipped run of sound really is. Marking one
    // clock and not the other is exactly how the two would drift apart.
    this.audioQueue = this.audioQueue.slice(drop)
    this.audioDroppedSeek += drop
  }

  /**
   * How much of the cushion is MISSING, in milliseconds of media.
   *
   * Zero once the stream has ended — there is nothing more coming, so waiting
   * for it would hang the clip — and zero for any source that already holds
   * more than the cushion, which is every fast one.
   */
  private cushionShortfallMs(): number {
    if (this.streamEnded) return 0
    const head = this.headMs
    const arrived = this.arrivedMs
    if (head === null || arrived === null) return this.prerollMs
    return Math.max(0, this.prerollMs - (arrived - head))
  }

  private startPacing(): void {
    this.stopPacing()
    // The anchor is pushed out by the SHORTFALL, not by the whole cushion:
    // the frame already on screen stays there while the queue fills, and a
    // source that arrived faster than realtime pays nothing at all.
    const shortfall = this.cushionShortfallMs()
    this.anchorWall = this.now() + shortfall
    this.anchorPts = this.headMs ?? this.queue[0]?.ptsMs ?? 0
    this.startPositionReports()
    this.tick()
  }

  private stopPacing(): void {
    if (this.paceTimer !== null) clearTimeout(this.paceTimer)
    this.paceTimer = null
  }

  /**
   * Push every unit that is due; sleep until the next; wait for data, or end.
   *
   * ONE schedule for both tracks, ordered by `ptsMs` with VIDEO first on a
   * tie — the same ordering `RecordedFeeder.paceSegment` builds, so a clip
   * and the recorder's own footage interleave identically. The two clocks
   * stay separate (each codec's RTP rate) but they stamp the SAME axis.
   */
  private tick(): void {
    this.paceTimer = null
    if (this.phase !== 'streaming' || this.rate === 0 || this.pendingSeekMs !== null) return
    for (;;) {
      const video = this.queue[0]
      const audio = this.audioQueue[0]
      if (video === undefined && audio === undefined) {
        if (this.streamEnded) this.finish()
        else {
          // The cushion is gone. Resuming on the first unit that arrives would
          // spend it again immediately and starve again on the next hiccup —
          // a sawtooth, which is what the operator saw. Rebuild it first.
          this.rebuffering = true
          this.noteStarved()
        }
        return
      }
      // Video wins a tie, and wins outright while audio is still arriving:
      // waiting on a sound that has not been muxed yet would hold the picture.
      const takeVideo = video !== undefined && (audio === undefined || video.ptsMs <= audio.ptsMs)
      const ptsMs = takeVideo ? (video?.ptsMs ?? 0) : (audio?.ptsMs ?? 0)
      const due = this.anchorWall + (ptsMs - this.anchorPts) / this.rate
      const wait = due - this.now()
      if (takeVideo) {
        if (wait > 0) {
          this.paceTimer = setTimeout(() => this.tick(), Math.min(wait, WAIT_TICK_MS))
          return
        }
        this.pushNext()
        continue
      }
      if (wait > 0) {
        this.paceTimer = setTimeout(() => this.tick(), Math.min(wait, WAIT_TICK_MS))
        return
      }
      this.pushNextAudio(-wait)
    }
  }

  /**
   * Push or DROP the head of the audio queue. False only when it was empty.
   *
   * `lateMs` is how far the frame's moment has already passed. Past the
   * bound it is dropped and counted: a receiver would discard it anyway, and
   * pushing a run of them is the burst that makes a clip sound broken rather
   * than silent. At any rate but 1x it is dropped for a different reason,
   * counted apart, because resampling would need a decoder this path has not
   * got and pitch-shifted sound is worse than none.
   */
  private pushNextAudio(lateMs: number): boolean {
    const frame = this.audioQueue[0]
    if (frame === undefined) return false
    this.audioQueue = this.audioQueue.slice(1)
    this.audioQueuedBytes -= frame.data.byteLength
    if (!audioPlaysAtRate(this.rate)) {
      this.audioDroppedRate += 1
      return true
    }
    if (lateMs > CLIP_STREAM_AUDIO_LATE_MS) {
      this.audioDroppedLate += 1
      return true
    }
    this.audioPush?.(frame.data, this.stampAudio(frame.ptsMs))
    this.audioPushed += 1
    if (!this.firstAudioLogged) {
      this.firstAudioLogged = true
      this.log('clip-stream:first-audio', {
        ptsMs: frame.ptsMs,
        lateMs: Math.round(lateMs),
        headMs: this.headMs,
        droppedLate: this.audioDroppedLate,
      })
    }
    this.applyBackpressure()
    return true
  }

  /** Push the head of the queue onto the track. False when the queue is empty. */
  private pushNext(): boolean {
    const unit = this.queue.shift()
    if (unit === undefined) return false
    this.queuedBytes -= unit.data.byteLength
    this.deps.sink.pushAccessUnit(unit.data, this.clock.stamp(unit.ptsMs), unit.codec)
    this.clockHasAdvanced = true
    // The head only ever advances: a source with B-frames pushes in decode
    // order, and the head is the furthest instant already handed over.
    this.headMs = this.headMs === null ? unit.ptsMs : Math.max(this.headMs, unit.ptsMs)
    this.pushed += 1
    if (!this.firstFrameLogged) {
      this.firstFrameLogged = true
      const at = this.now()
      this.log('clip-stream:first-frame', {
        sinceSeekMs: this.seekStartedAt === null ? null : at - this.seekStartedAt,
        sinceDialMs: this.dialedAt === null ? null : at - this.dialedAt,
        bytesIn: this.bytesIn,
        ptsMs: unit.ptsMs,
        codec: unit.codec,
      })
    }
    this.applyBackpressure()
    return true
  }

  private finish(): void {
    if (this.phase !== 'streaming') return
    this.phase = 'ended'
    // Normally already settled from the `moov`. Reaching here unsettled means
    // the stream ended without ever saying — `no-audio-track` if the head was
    // read and simply had none, `stream-failed` if it never got that far.
    this.settleAudio({
      carried: false,
      codec: null,
      reason: this.demuxer.ready ? 'no-audio-track' : 'stream-failed',
    })
    this.stopPacing()
    this.stopPositionReports()
    if (this.headMs !== null) this.deps.onPosition(this.headMs)
    this.log('clip-stream:played-out', {
      pushed: this.pushed,
      dropped: this.dropped,
      headMs: this.headMs,
      durationMs: this.streamEnd?.durationMs ?? null,
      ...this.audioTally(),
    })
    this.emitState('ended', 'stream-played-out', this.seekToken)
  }

  // ── reporting ────────────────────────────────────────────────────────────

  private startPositionReports(): void {
    if (this.positionTimer !== null) return
    this.positionTimer = setInterval(() => {
      if (this.headMs !== null && this.phase === 'streaming') this.deps.onPosition(this.headMs)
    }, POSITION_INTERVAL_MS)
  }

  private stopPositionReports(): void {
    if (this.positionTimer !== null) clearInterval(this.positionTimer)
    this.positionTimer = null
  }

  private emitState(to: FeederState, reason: string, seekToken: number): void {
    const from = this.lastAnnounced
    this.lastAnnounced = to
    this.deps.onState({ from, to, reason, seekToken })
  }

  /** The audio counters every exit line carries. Silence is never unexplained. */
  private audioTally(): Record<string, unknown> {
    return {
      audioAsked: this.audioAsk,
      audioCarried: this.audioReport?.carried ?? false,
      audioSilentReason: this.audioReport?.reason ?? null,
      audioPushed: this.audioPushed,
      audioDroppedLate: this.audioDroppedLate,
      audioDroppedRate: this.audioDroppedRate,
      audioDroppedSeek: this.audioDroppedSeek,
      audioQueued: this.audioQueue.length,
    }
  }

  /** One-shot, like the duration beside it: the provider speaks once, at the
   *  end of the body, and a cut settles `null` so nobody waits for ever. */
  private settleIncomplete(report: ClipIncompleteReport | null): void {
    if (this.incompleteSettled) return
    this.incompleteSettled = true
    this.incompleteReport = report
    if (report !== null) {
      // The broker's own line, per camera, beside the provider's (D391): two
      // processes, and only one of them is in the hub log the operator reads
      // when he asks why a clip stopped.
      this.log('clip-stream:incomplete', { code: report.code, reason: report.reason })
    }
    for (const resolve of this.incompleteWaiters.splice(0)) resolve(report)
  }

  private settleAudio(report: ClipAudioReport): void {
    if (this.audioReport !== null) return
    this.audioReport = report
    const now = this.audioNow(report)
    this.audioEmitted = now
    const waiters = this.audioWaiters.splice(0)
    for (const resolve of waiters) resolve(now)
  }

  /**
   * The audio answer AS IT STANDS — the stream's own settled fact, with the
   * rate laid over it.
   *
   * The overlay only ever applies to a clip that really is carrying sound. A
   * clip whose camera has no microphone is silent at 1× too, and replacing
   * `no-audio-track` with `rate` would swap the true cause for a transient
   * one and send the operator to the speed chip.
   */
  private audioNow(settled: ClipAudioReport): ClipAudioReport {
    if (!settled.carried || audioPlaysAtRate(this.audioRate)) return settled
    return { carried: false, codec: null, reason: 'rate', rate: this.audioRate }
  }

  /** Tell the listener when — and only when — the answer has actually moved. */
  private refreshAudioReport(): void {
    const settled = this.audioReport
    if (settled === null) return
    const next = this.audioNow(settled)
    const last = this.audioEmitted
    if (last !== null && last.reason === next.reason && last.rate === next.rate) return
    this.audioEmitted = next
    this.audioListener?.(next)
  }

  private settleDuration(value: number | null): void {
    if (this.duration !== null) return
    this.duration = { settled: true, value }
    const waiters = this.durationWaiters.splice(0)
    for (const resolve of waiters) resolve(value)
  }

  private teardown(): void {
    this.stopPacing()
    this.stopPositionReports()
    this.clearStall()
    // An open that has not answered yet is the one that costs the provider a
    // lane: abort it FIRST, before the connection that may not exist.
    const opening = this.opening
    this.opening = null
    opening?.abort(new Error(CLIP_STREAM_ABANDONED))
    const connection = this.connection
    this.connection = null
    connection?.destroy()
  }

  /**
   * The pacer asked for a frame the stream has not produced yet.
   *
   * **A branch that accepts work and produces nothing is the same branch as
   * one that drops it** (D391), and this is the one that hid Hikvision's whole
   * acceleration defect: an RTSP replay arrives at 1×, so a pacer set to 2×
   * or 4× eats the queue faster than the socket fills it, stops, waits, and
   * says nothing at all. The picture froze, the operator reported *"pare non
   * funzionare"*, and the only line anywhere was the provider's `peer-stalled`
   * ten seconds later — which names the wrong end of the pipe.
   *
   * ONE line per run, not one per starve. At rate 1 against a realtime source
   * the queue legitimately empties between frames, so a line per occurrence is
   * the storm that buries the line that matters; the count travels on the
   * run's own end.
   */
  private noteStarved(): void {
    this.starved += 1
    if (this.starved > 1) return
    this.log('clip-stream:starved', {
      rate: this.rate,
      headMs: this.headMs,
      arrivedMs: this.arrivedMs,
      bytesIn: this.bytesIn,
      // What the source can deliver is a PROVIDER fact
      // (`CLIP_PLAYBACK_OPTIONS`); this line says only that the rate being
      // paced outran what has arrived.
      pushed: this.pushed,
    })
  }

  private log(msg: string, data: Record<string, unknown>): void {
    this.deps.onLog?.(msg, { ...this.tags, ...data })
  }
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
