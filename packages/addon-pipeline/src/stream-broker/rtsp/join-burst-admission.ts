/**
 * Who may take the join burst — the decision, as a pure function of the
 * JOINING CONSUMER and the burst it would receive.
 *
 * ## The rule the bound actually encodes
 *
 * D57's span bound exists for ONE shape of consumer: something that RE-EMITS
 * what it receives on a real-time clock. An ffmpeg copy of the restream feeding
 * a HomeKit leg has ~zero decode headroom, never drains a backlog, and forwards
 * the burst's compression to its peer as jitter — measured, a 2 996 ms burst
 * became 3 030 ms of controller-visible jitter. For that consumer the bound is
 * the whole point and must not move.
 *
 * It was written as a property of the STREAM (a millisecond number per camera
 * stream) because at the time every RTSP consumer re-emitted. That is no longer
 * true, and the consequence is measurable: the burst is not trimmed when it
 * exceeds the bound, it is **withheld whole**, and the session then waits for
 * the camera's next IDR.
 *
 * ## Why detection is the other shape
 *
 * A per-session detection decode does not re-emit. It decodes at source rate
 * and publishes throttled by its `FrameSlot`, so the burst is DRAINED, not
 * accumulated — it fast-forwards to the live edge and begins emitting at NOW.
 * There is no peer to jitter. This is the same structural argument that already
 * exempts it from the live-edge rule (`restream-intent.ts`), carried to its
 * conclusion.
 *
 * WebRTC is exempt for the same reason and by the same structure: a viewer peer
 * terminates the media itself, and its bootstrap reads
 * `StreamBroker.getRtpPreBuffer()` directly, never traversing this decision at
 * all (`webrtc-join-burst-exemption.spec.ts` pins that the withholding must not
 * migrate above the fork they share).
 *
 * Measured cost of getting this wrong, on 6 h of the live fleet: with a
 * 4 000 ms IDR interval (100-frame GOP at 25 fps) against a fixed 2 000 ms
 * bound, the burst's span at join is uniform in `[0, IDR]`, so detection was
 * served on only **44-61 %** of its dials. The three cameras that happened to
 * be served on ~100 % of joins were the three fastest in the fleet — first
 * frame at 1 487 / 1 655 / 1 946 ms against 4 531-10 807 ms for the rest.
 *
 * ## What the exemption does NOT remove
 *
 * `maxPackets`. That ceiling is not a tuning knob, it is a defensive backstop
 * against RTP timestamps that stopped describing the stream — a wrap, a source
 * repeating a timestamp, an all-intra latch that never closed. In exactly those
 * cases `spanMs` is meaningless, so a span-only exemption would hand a decoder
 * an unbounded replay precisely when the number guarding it has gone wrong.
 * The packet ceiling therefore applies to every consumer, detection included.
 */
import type { PrimeBurstBound } from './rtsp-restreamer.js'

/**
 * Why a join burst was withheld, or `'none'` when it is served.
 *
 * Three distinct reasons rather than a boolean because they fire on different
 * populations under different bounds, and the restreamer counts each one
 * separately: conflating them hides a camera whose decoder starts blind on
 * nearly every dial while its viewers are served normally.
 */
export type JoinBurstWithhold = 'none' | 'live-edge' | 'span' | 'packets'

/** One joining session, and the burst it is a candidate to receive. */
export interface JoinBurstAdmissionInput {
  /**
   * `isLiveEdgeOnly()` — this consumer RE-CLOCKS what it receives on a
   * real-time clock and never drains a catch-up burst.
   *
   * This used to be `isMuted()`, and the rule below was `muted &&
   * !detectionIntent`. Mute is about AUDIO; the population this bound was
   * measured for is defined by re-clocking, and the two only ever coincided by
   * accident. A `/sentry` dial is that same ffmpeg-copy shape and now carries
   * audio (D525), so asking the mute here would have silently handed it a
   * 2-3 s backlog the day it stopped being muted.
   */
  readonly liveEdgeOnly: boolean
  /** `isDetectionIntent()` — declared on the dial path, never inferred from mute. */
  readonly detectionIntent: boolean
  /** Whether the prime came from the current-GOP ring (vs the lone cached keyframe AU). */
  readonly fromRing: boolean
  /** Media span of the burst, from its first and last RTP timestamps. */
  readonly spanMs: number
  /** Packet count of the burst. */
  readonly packets: number
  /** The bound in force for this stream. */
  readonly bound: PrimeBurstBound
  /** `LIVE_EDGE_MAX_SPAN_MS` — the near-live window a re-clocking leg needs. */
  readonly liveEdgeMaxSpanMs: number
}

/**
 * Decide whether this session may take this burst.
 *
 * Pure and total: no clock, no logger, no restreamer state. The restreamer maps
 * the result onto its counters and its `continue`.
 */
export function admitJoinBurst(input: JoinBurstAdmissionInput): JoinBurstWithhold {
  // A re-clocking leg (HomeKit/ffmpeg copy, and the sentry) must start
  // near-live or not at all. Unchanged, and deliberately evaluated FIRST so
  // that population's behaviour cannot be altered by anything below it. The
  // `&& !detectionIntent` that used to guard it is gone because it moved into
  // `isLiveEdgeOnlyDial`, which is now the one place that answers this — a
  // detection dial is never live-edge-only there.
  //
  // It returns 'none' without consulting the packet ceiling — which is exactly
  // what the code this replaced did (the `else if` was skipped once the
  // live-edge test passed). A burst inside 500 ms of media cannot plausibly
  // breach a 2 000-packet ceiling, and preserving the shape byte-for-byte
  // matters more here than tidying it.
  if (input.liveEdgeOnly) {
    return !input.fromRing || input.spanMs > input.liveEdgeMaxSpanMs ? 'live-edge' : 'none'
  }

  // Span before packets, preserving the original precedence: a burst that
  // breaches both was counted as a SPAN withhold, and that counter is read per
  // camera to decide whether a stream's bound needs raising.
  if (!input.detectionIntent && input.spanMs > input.bound.maxSpanMs) return 'span'

  // The backstop, for everyone. See the module docblock: this is the one bound
  // a detection session does NOT escape.
  if (input.packets > input.bound.maxPackets) return 'packets'

  return 'none'
}
