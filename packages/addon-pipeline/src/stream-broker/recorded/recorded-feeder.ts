import { SNAP_MAX_DISTANCE_MS } from './playback-profile-fallback.js'
import { errMsg } from '@camstack/types'
import { clampPlaybackRate } from './control-protocol'
import type { DemuxPathCounts, DemuxPathTally } from './demux-path-tally'
import { FeedOrigin, MonotonicClock } from './feed-clock'
import { type ScrubCoverage, ScrubDragStats, type ScrubMapMode } from './scrub-drag-stats'
import { SCRUB_FRAGMENT_CACHE_MAX_BYTES, ScrubFragmentCache } from './scrub-fragment-cache'
import type { AccessUnit } from './segment-demux'
import { repairSegmentPts } from './segment-pts-repair.js'

/**
 * recorded-feeder — orchestrates a playback cursor for one (deviceId, profile).
 *
 * Pulls segments via injected callbacks, demuxes them, re-stamps every access
 * unit onto a feed-relative monotonic 90 kHz clock, and pushes Annex-B units to
 * a sink at the playback rate (0 = paused, else clamped to [0.25, 8]). Reports
 * position ~1 Hz (media time — the cursor tracks each fed frame). Skips gaps.
 * Latest-wins on seek (a fresh `seek()` invalidates any in-flight feed/advance
 * via a token). While paused, a seek feeds only up to the requested instant
 * (exact-frame render) and `stepFrame(±1)` moves exactly one frame. At rate > 0
 * a seek bursts only the IDR→epoch prefix (decode priming) and PACES the
 * remainder of the covering segment from the cursor — so resume-after-pause and
 * rate changes (which re-enter via seek) continue from the exact position.
 *
 * All real I/O is injected so the feeder is unit-testable with fakes.
 */

/** Lifecycle states surfaced to the consumer via `onState`. */
export type FeederState = 'loading' | 'playing' | 'paused' | 'gap' | 'ended' | 'error'

/**
 * One state transition, WHY it happened, and which commit produced it.
 *
 * Before this, `onState` carried only `to` — a naked string. `recorded: feeder
 * state = loading` said nothing about where the state came from, why it moved,
 * or which seek/scrub was behind it, and a state that got stuck there (2026-08-26:
 * two commits reached `playback:intent` and never `playback:ready`) could not be
 * explained from the logs alone — it had to be inferred by subtracting fields
 * from an unrelated line, or not explained at all. `from`/`reason`/`seekToken`
 * make one transition self-describing: `from` is this feeder's own previously
 * announced state (`null` before the first), `reason` names the code path that
 * produced `to`, and `seekToken` is the seek/scrub-commit generation that owns
 * it — comparing it against a LATER transition's `seekToken` is what proves a
 * transition was superseded even though the superseded seek never announces
 * that itself (latest-wins is silent by design; see `recorded:seek-abandoned`
 * and `recorded:seek-outcome`). `dragId` is the client-supplied id for the
 * scrub gesture this transition belongs to (undefined outside one).
 */
export interface FeederStateTransition {
  readonly from: FeederState | null
  readonly to: FeederState
  readonly reason: string
  readonly seekToken: number
  readonly dragId?: string
}

/** A re-stampable PCMU (8 kHz µ-law) audio access unit (one 20 ms frame). */
export interface AudioAccessUnit {
  readonly data: Uint8Array
  /** Source presentation time in milliseconds (segment-relative). */
  readonly ptsMs: number
}

/** Sink that accepts re-stamped Annex-B video + (optional) audio units. */
export interface FeederSink {
  pushAccessUnit(annexB: Uint8Array, rtpTs90k: number, codec: 'H264' | 'H265'): void
  /** Push one re-stamped PCMU audio frame (8 kHz). Optional: video-only sinks omit it. */
  pushAudioPcmu?(pcmu: Uint8Array, rtpTs8k: number): void
  /**
   * Push one re-stamped Opus audio frame (48 kHz). Optional: present only when
   * the session negotiated Opus. Mutually exclusive with {@link pushAudioPcmu}
   * per feeder — the broker wires exactly one, matching the negotiated codec.
   */
  pushAudioOpus?(opus: Uint8Array, rtpTs48k: number): void
}

/** A located segment covering (or starting at) the requested epoch. */
export interface LocatedSegment {
  readonly kind: 'segment'
  readonly startMs: number
  readonly durMs: number
  readonly bytes: number
}

/**
 * A located gap. `nearestEdgeMs` is the next forward footage edge, or `null`
 * when there is no forward footage (past the end of the recording) — the feeder
 * treats `null` as `ended`. `prevEndMs` is the exclusive END of the nearest
 * footage BEHIND the queried epoch (null/absent when none): consecutive
 * recorded segments have small cracks between `startMs + durMs` and the next
 * `startMs` (11–17 ms measured live), so a backward frame-step at a segment
 * head lands its `startMs − 1` probe INSIDE a crack — `prevEndMs` lets the
 * feeder hop the crack to the true previous segment instead of no-opping.
 */
export interface LocatedGap {
  readonly kind: 'gap'
  readonly nearestEdgeMs: number | null
  readonly prevEndMs?: number | null
}

/**
 * Discriminated union over `kind` so the `'segment'` branch guarantees
 * `startMs`/`durMs` without non-null assertions.
 */
export type LocateResult = LocatedSegment | LocatedGap

/**
 * The GOP-granular read (D31 byte range): ONE fragment covering `epochMs`,
 * resolved through the segment's own `mfra` on the recording node. `bytes` is
 * standalone-demuxable (moov head + one moof/mdat); `gopStartMs`/`gopDurMs`
 * place it on the absolute timeline.
 */
export interface ReadGopFn {
  (args: {
    deviceId: number
    profile: string
    segmentStartMs: number
    segmentDurMs: number
    epochMs: number
  }): Promise<{ gopStartMs: number; gopDurMs: number; bytes: Uint8Array }>
}

export interface RecordedFeederDeps {
  readonly deviceId: number
  readonly profile: string
  locate(args: { deviceId: number; profile: string; epochMs: number }): Promise<LocateResult>
  readBytes(args: { deviceId: number; profile: string; startMs: number }): Promise<Uint8Array>
  /**
   * Optional GOP byte-range read. Present ⇒ the SCRUB path fetches one
   * fragment per target instead of the whole covering segment (D31's letter on
   * this path; 41–173 KB instead of 100–600 KB on `low`). Absent (an older
   * recording provider, or a test that does not care) ⇒ scrub degrades to the
   * whole-segment read. Playback always reads whole segments — it consumes
   * every byte of them anyway, so the file IS its byte range there.
   */
  readonly readGop?: ReadGopFn
  /**
   * Optional SESSION-scoped fragment cache. The broker passes one per WebRTC
   * session so warmed/demuxed fragments survive the feeder rebuilds that
   * `enterRecorded` performs (profile changes, scrub↔playback transitions) —
   * the timeline warm-up writes into it before any feeder exists. Absent ⇒ the
   * feeder owns a private one with the same bounds.
   */
  readonly fragmentCache?: ScrubFragmentCache
  /**
   * Optional SESSION-scoped demux-path tally. Present ⇒ the per-drag aggregate
   * reports how many fragments the JS demux served and how many fell
   * back to the ffmpeg subprocess, with the last reason. The tally is written by
   * the demux wrapper the broker injects (`demuxSegmentPreferJsOffThread`), not here —
   * the feeder only DIFFS it across the drag, so the numbers cover the warm-up
   * and prefetch demuxes that the drag actually benefits from.
   */
  readonly demuxTally?: DemuxPathTally
  /**
   * Threshold above which a single `locate` gets its own (throttled) line.
   * Defaults to {@link SCRUB_SLOW_LOCATE_MS}; tests lower it.
   */
  readonly slowLocateMs?: number
  /** Median read time above which speculation suspends itself. Tests override
   *  it; production takes {@link SCRUB_SLOW_READ_MS}. */
  readonly slowReadMs?: number
  /** Pause between IDLE warm reads (after a seek/commit, no drag live). Tests
   *  shrink it; production takes {@link IDLE_WARM_READ_GAP_MS}. */
  readonly idleWarmGapMs?: number
  /**
   * Seek travel-animation tuning (tests set tiny budgets; production omits it
   * and gets the SEEK_ANIMATION_* defaults). All fields optional.
   */
  readonly seekAnimation?: SeekAnimationConfig
  /**
   * Scrub frame-deadline tuning (tests set millisecond budgets; production
   * omits it and gets the SCRUB_TICK_DEADLINE_MS / SCRUB_FIRST_TICK_DEADLINE_MS
   * / SCRUB_RIDE_WINDOW_MS defaults).
   */
  readonly scrubDeadline?: ScrubDeadlineConfig
  demux(bytes: Uint8Array): Promise<AccessUnit[]>
  /** Optional: demux+transcode the segment's audio to PCMU. Omitted → video-only. */
  demuxAudio?(bytes: Uint8Array): Promise<AudioAccessUnit[]>
  /**
   * Audio RTP clock rate in Hz. Drives the feeder's internal audio clock so
   * re-stamped audio timestamps match the negotiated codec (PCMU 8 kHz / Opus
   * 48 kHz). Defaults to 8000 for the PCMU path.
   */
  readonly audioClockRateHz?: number
  sink: FeederSink
  onState(transition: FeederStateTransition): void
  /**
   * Report the pointer position. `pushSeq` is present ONLY on the position a
   * scrub push emits, and names that push — the viewer echoes it on `scrubAck`
   * so the feeder knows which outstanding push an ack settles (see
   * {@link OutstandingPush}). Playback/step positions carry none.
   */
  onPosition(epochMs: number, pushSeq?: number): void
  /**
   * Diagnostic seam. The scrub sub-mode was DARK server-side: `scrubTick`
   * pushed (or silently swallowed a failure) with no line either way, so a
   * production incident had to be reconstructed from an RTP-rebase side
   * effect. Pushes, parks and tick failures now log through here.
   */
  onLog?(msg: string, data: Record<string, unknown>): void
}

const SEGMENT_TIMEOUT_MS = 8000
/**
 * Deadline for the recorded-AUDIO demux on the `reusedWhole` seek path, and
 * the reason it is not `SEGMENT_TIMEOUT_MS`.
 *
 * That await sits BETWEEN the painted video prefix and `startAdvance`, so
 * every millisecond of it is a frozen picture the operator is looking at.
 * On the live hub (8/24–8/25) 4 of 9 `recorded:seek-ready` lines landed at
 * `loadMs - firstFrameMs = 8000 ± 1 ms` — the timeout, not work: first frame
 * at 2.3 s, then eight seconds of still image before playback advanced.
 *
 * The wait bought NOTHING in all four: the race rejects, `.catch` yields `[]`,
 * and the segment plays without audio anyway. So this is not audio traded for
 * latency — it is a wait whose only outcome is the outcome it already had.
 * 1500 ms is ~5x the worst demux observed in the same window (`demuxMs` p50
 * 2 ms, p95 202 ms, max 285 ms), so a segment that CAN yield audio still does.
 */
const AUDIO_DEMUX_TIMEOUT_MS = 1500
const POSITION_INTERVAL_MS = 1000
/** How often `recorded:play-census` fires while the advance loop is alive. */
const PLAY_CENSUS_INTERVAL_TICKS = 5
/**
 * Prefetch wait that counts as a boundary stall. Segments are ~10 s; a
 * prefetch that is still on FUSE when pacing ends is the hiccup the operator
 * feels. 50 ms is well above a cache hit and well below a disk read.
 */
const PLAY_STALL_MS = 50
/**
 * How many distinct segment starts a feeder remembers having reported as
 * PTS-repaired, so a camera writing broken stamps names each damaged segment
 * once instead of once per scrub warm. Cleared wholesale when full — the set is
 * a log de-duplicator, not state anything reads.
 */
const PTS_REPAIR_LOG_MEMORY = 64
/**
 * Upper bound on a single inter-frame sleep. Frame gaps at 10–30 fps are
 * 33–100 ms, so this rarely splits a real wait; it exists so an unusually long
 * PTS gap (or an empty/tail wait) still re-checks the abort guards promptly,
 * keeping seeks responsive without per-frame drift.
 */
const WAIT_TICK_MS = 250
/**
 * Output-clock gap stamped at every seek/scrub commit (markDiscontinuity on
 * both A/V clocks). Root cause of the "smeared frame on scrub": the aborted
 * pace loop's last access units are already in the RTP send path when the new
 * feed starts; with only the ~1-frame (+33 ms) continuation nudge the receiver
 * sees ONE contiguous timestamp stream, so if any packet of the new feed's IDR
 * is lost in the seek burst, the decoder decodes the following deltas against
 * PRE-seek reference frames — the classic wrong-reference smear. A 250 ms jump
 * makes the seek an unambiguous stream discontinuity: stale lower-ts units
 * can't look contiguous with the new GOP, and the receiver resets timing
 * instead of merging the two feeds.
 */
const SEEK_DISCONTINUITY_MS = 250
/**
 * Coalescing window for feeder-scrub `scrubTo` (experimental). Pointer-move
 * targets arrive far faster than a segment demux completes; the feeder collapses
 * them to at most one keyframe push per this window (≈ 16 pushes/s), always
 * pushing only the LATEST pending target (latest-wins). The FIRST move fires a
 * leading-edge tick immediately; subsequent moves ride the pending timer.
 *
 * Tightened 100 → 60 ms: same-fragment moves are memo/cache hits (zero demux) so
 * the window is now the dominant per-push cost inside a fragment, and 60 ms is
 * sustainable there — cross-fragment moves remain paced by the demux + the
 * one-in-flight guard, so this cannot spawn parallel demuxes.
 */
const SCRUB_COALESCE_MS = 33
/**
 * How much forward slack two fragments may have and still count as ADJACENT
 * for sweep continuity. Two real cases live inside it: the ±1 ms rounding of a
 * GOP's tick-derived start/duration, and the 11–17 ms inter-segment cracks the
 * recorder leaves between `startMs + durMs` and the next `startMs`. Beyond it,
 * the move is a jump with a discontinuity stamp — never a silent stall.
 */
const SCRUB_ADJACENT_TOLERANCE_MS = 50
/**
 * SEEK TRAVEL ANIMATION — a seek must not teleport. The contract is bounded
 * by WALL-CLOCK BUDGET, never by distance: a 4-hour seek and a 30-second seek
 * animate for the same time and then land on the exact target. Time-driven
 * interpolation is what makes it safe on a saturated hub: the still for
 * "budget-progress × distance" is fetched with the remaining budget as its
 * deadline, so slow fetches yield FEWER stills (the animation shortens and
 * lands early) instead of a queue that outlives the seek.
 *
 * Still count: the reference contract is ~33 stills at ~30 ms. Our stills are
 * full `low` keyframes (34–38 KB measured), so 33 would be ~1.25 MB in one
 * second — a ~10 Mbit/s burst that congests exactly the thin remote links this
 * feeder serves, arriving AFTER the landing. 16 at ~60 ms is ~0.6 MB, still
 * reads as travel, and leaves headroom for the landing GOP behind it.
 */
const SEEK_ANIMATION_BUDGET_MS = 250
const SEEK_ANIMATION_TICK_MS = 60
const SEEK_ANIMATION_MAX_STILLS = 4
/**
 * Below this distance there is at most ONE intermediate keyframe (the camera
 * GOP is fixed at 4 s) — the landing burst already paints the target, so
 * animating would only delay it. 2 × GOP.
 */
const SEEK_ANIMATION_MIN_DISTANCE_MS = 8_000
/**
 * Max CACHE-ONLY travel stills a drag-jump paints between the previous target
 * and the new one. Zero I/O by design: a fling must never add locate/read
 * chains to a hub already at 70–95% — warm fragments ride along, cold ones
 * degrade to today's single keyframe.
 */
const SCRUB_JUMP_TRAVEL_MAX_STILLS = 3
/**
 * The profile whose scrub read unit is the WHOLE SEGMENT.
 *
 * Every drag is pinned to `low` by the client, and a `low` segment is ~230 KB
 * for 10 s of timeline. Reading it whole is ONE sequential read; the GOP
 * byte-range it replaces was three random seeks (a 2 KB tail probe for the
 * `mfra` index, the `ftyp`+`moov` head, then the fragment) for ~135 KB of those
 * ~230 KB — and it bought nothing reusable, because the next tick inside the
 * same segment paid all three again. On a spindle that is also absorbing every
 * camera's writes, seeks are the cost and bytes are nearly free.
 *
 * The win is not the single read, it is what the read leaves behind: ten
 * seconds of demuxed access units. A drag inside one segment then costs zero
 * I/O and zero demux — which is the regime the operator spends most of a
 * careful gesture in.
 */
const SCRUB_WHOLE_SEGMENT_PROFILE = 'low'
/**
 * Safety ceiling on ONE scrub read, in bytes.
 *
 * `low` is ~230 KB per 10 s, so this is ~6× headroom for a camera whose
 * substream is unusually fat — but a segment past it (a mis-pinned `high` at
 * ~5 MB) falls back to the GOP range, because reading 5 MB to push one
 * keyframe is the trade this change exists to avoid, in the other direction.
 *
 * ⚠️ THIS NUMBER IS TIED TO THE SEGMENT DURATION AND THE TIE IS NOT ENFORCED.
 * It was tuned against a 10-second `low` segment. At the 60-second segments
 * the 2026-08-25 teardown proposes, a NATIVE `low` is ~1.4 MB (just inside,
 * and the whole-segment read gets six times better — one seek leaves a minute
 * of access units behind) while a DERIVED `low` is ~4.8 MB (outside, and every
 * scrub read silently degrades to a 3-seek GOP range that leaves nothing
 * behind). Same constant, opposite outcomes, no signal either way — which is
 * why the degradation is now COUNTED and LOGGED
 * (`scrub-feeder:oversize-segment`, `oversizeSegments` on the drag census)
 * instead of being inferred from a falling hit rate.
 *
 * The real fix, for when 60 s segments land, is a read unit that is a BYTE
 * BUDGET over the fragment's own keyframe table — "as many consecutive GOPs
 * as fit in N bytes" — computed from `tfra` offsets alone, no payload read
 * (`fragmentsWithinBudget`, `recorder/mfra-index.ts`). `readGopBytes` now uses
 * exactly this budget on the fallback path below: it no longer reads exactly
 * one GOP, it reads as many CONSECUTIVE fragments as fit this same ceiling, in
 * one range read (`gop-range-read.ts`'s `maxBytes`). The recorder-side handler
 * (`recording-provider.ts`) declares its OWN copy of this number
 * (`SCRUB_GOP_BUDGET_MAX_BYTES` in `gop-range-read.ts`) rather than importing
 * this module — the client feeder is a different addon-internal concern, and
 * pulling its whole dependency graph in for one number is the wrong
 * direction. Exported here so a future caller in THIS process can reuse it;
 * if D163's number moves, move both.
 */
export const SCRUB_WHOLE_SEGMENT_MAX_BYTES = 1_500_000
/**
 * How still the finger must be before the window warm may take the disk back.
 *
 * Long enough that it does not thrash on the gap between two ticks of a slow
 * drag (tickMsP50 was 120-129 ms on the measured drags), short enough that a
 * pause the operator would call "stopped" is warm again before they move.
 */
const SCRUB_WARM_QUIET_MS = 300

/**
 * How far the entry warm-up reaches, backward and forward from the playhead the
 * drag starts on.
 *
 * Asymmetric because the gesture is: a drag that begins at the live edge — or
 * at a notification's moment — is looking for what ALREADY happened. 15 min
 * back against 5 min forward fills the 48 MB window where the finger will
 * actually move, read sequentially in the background while the first ticks
 * still pay their own demand-read.
 */
const SCRUB_WARM_BACK_MS = 15 * 60_000
const SCRUB_WARM_FWD_MS = 5 * 60_000
/** Symmetric span used after a jump: scrub around the landing, both ways. */
const SCRUB_WARM_AROUND_MS = 15 * 60_000
/**
 * Re-centre the fill when a tick lands this far from the window we are filling.
 * A slow drag stays inside this; a jump to 8am does not.
 */
const SCRUB_RECENTER_MS = 120_000
/** Typical demuxed `low` segment; the warm cap is `budget / this`. */
const SCRUB_WARM_SEGMENT_BYTES = 200_000
/** Hard bound on warm reads, derived from the session RAM budget. */
const SCRUB_WARM_MAX_SEGMENTS = Math.max(
  1,
  Math.floor(SCRUB_FRAGMENT_CACHE_MAX_BYTES / SCRUB_WARM_SEGMENT_BYTES),
)
/**
 * Pause between two IDLE warm reads — the fill that continues AFTER a seek or
 * a scrub commit, while no finger is down.
 *
 * Idle warm exists because the cold/warm ratio on the recordings spindle is
 * 19× (531 ms vs 28 ms, measured 2026-08-25) and the operator's think-time on
 * a landed frame is the one window where the spindle is otherwise free. But
 * that same spindle carries every camera's writes and the export/event reads:
 * an UNPACED background walk would be one more saturating reader. One segment
 * read per gap keeps the fill under ~1 read/s worst case — the window fills in
 * a couple of minutes and the drag that follows lands on RAM.
 */
const IDLE_WARM_READ_GAP_MS = 250
/**
 * Median recent read time at or above which the feeder STOPS speculating.
 *
 * Speculation is a bet that spare I/O exists. When reads are this slow there is
 * no spare I/O — the array is saturated — and a prefetch is not free work, it
 * is another random seek queued ahead of the read the operator is waiting on.
 * The field regime that forced this: 54 prefetch reads for 9 hits with the disk
 * at 98% busy. Suppression is counted (`prefetchSuppressed`) so the decision is
 * visible, and it lifts by itself as soon as reads come back.
 */
const SCRUB_SLOW_READ_MS = 600
/** Reads kept for the median above — short, so suppression tracks NOW. */
const SCRUB_READ_WINDOW = 5
/**
 * Max forward TARGET delta (ms of timeline, between consecutive drag targets)
 * that SWEEPS predicted frames instead of jumping. A steady forward drag is
 * playback with a moving target: once a keyframe decoded, the predicted frames
 * after it decode in sequence at a fraction of an IDR's bytes — that is the
 * continuous flow. Beyond this window (a fling), or backwards, a jump to an
 * independently-decodable keyframe is cheaper than the burst; and because a
 * thin pipe slows the ack-gated ticks down, per-tick deltas GROW under
 * congestion, so degradation to jump-only is emergent, and visible per push
 * (`mode` on every scrub-feeder:pushed line).
 */
const SCRUB_SWEEP_WINDOW_MS = 4_000
/**
 * THE DEADLINE ON ONE SCRUB FRAME — and the reason it is not
 * {@link SEGMENT_TIMEOUT_MS}.
 *
 * A scrub tick used to be bounded only by the 8 s per-RPC timeout, against a
 * cold read measured at p50 531 ms, p95 1.4–2 s and a 9.2 s max (census
 * 2026-08-25). So the feeder WAITED. The frame it eventually pushed was for a
 * finger position from seconds earlier, and the gesture spent its whole
 * duration on a handful of stale frames — the operator's "quasi 0 frame, e
 * l'immagine insegue il dito".
 *
 * The reference design (teardown 2026-08-25) spends at most
 * ~1000 ms on the WHOLE scrub animation and gives every single frame the
 * REMAINING window as its deadline: a frame that cannot be produced in time is
 * dropped, never awaited. This is the same contract on our constraints.
 *
 * 700 ms and not 1000: the deadline must be shorter than the gesture's own
 * animation window or it can never fire twice inside one, and it must be above
 * the cold-read p50 (531 ms) or the median frame would be dropped — a deadline
 * that drops the median makes the picture WORSE, not fresher. 700 ms sits
 * between: it serves the p50–p60 of cold reads and cuts the p90 tail that used
 * to eat the gesture.
 *
 * Dropping is never silent: `deadlineMisses` on the drag aggregate plus one
 * `scrub-feeder:deadline-miss` line per drag.
 */
const SCRUB_TICK_DEADLINE_MS = 700
/**
 * The FIRST frame of a drag gets a longer deadline, because nothing is painted
 * yet.
 *
 * Every later frame has a predecessor on screen, so dropping it costs
 * freshness. The first one has none: dropping it costs the whole picture, and
 * the operator reads a blank recorded view as "playback parte dopo una vita" [playback starts after an eternity].
 * The reference design has the same asymmetry for the same reason — its
 * animation frames are deadline-dropped while the LANDING seek is unbounded.
 *
 * 2500 ms covers the cold-read p95 (1.4–2 s) and still cuts the 9.2 s tail.
 */
const SCRUB_FIRST_TICK_DEADLINE_MS = 2_500
/**
 * How far a new target may be from an in-flight read's target and still RIDE
 * it instead of starting a second one.
 *
 * A `low` segment is ~10 s of timeline and the read unit is the whole segment
 * ({@link SCRUB_WHOLE_SEGMENT_PROFILE}), so a target within one segment of the
 * one being read is very likely already inside the bytes on their way. Riding
 * costs nothing and saves a random seek on the spindle that is the bottleneck;
 * being wrong costs one wasted deadline, which is now cheap by construction.
 */
const SCRUB_RIDE_WINDOW_MS = 10_000
/**
 * Hard bound on concurrent fragment resolutions for one drag.
 *
 * A deadline that drops frames is only safe if dropping does not multiply the
 * work: without this bound a drag over slow footage would abandon a read every
 * {@link SCRUB_TICK_DEADLINE_MS} and start another, turning one saturated
 * spindle into N. Two: the one that is landing, and the one the finger has
 * moved on to. At the cap, a tick rides the newest in-flight read instead.
 */
const SCRUB_RESOLVE_MAX_INFLIGHT = 2
/**
 * READ-AHEAD LEAD — the fix for "the picture chases the finger".
 *
 * A scrub frame is always the frame a read STARTED for, one read time ago.
 * On this disk that is 531 ms of wall clock (p50, census 2026-08-25), and on
 * a wide window 531 ms of gesture is TWENTY MINUTES of timeline: measured in
 * the drag bench, the median painted frame on a 2 h fling was 1 220 000 ms
 * behind the finger. Nothing about that is I/O — it is aiming at where the
 * finger WAS.
 *
 * So a steady drag reads where the finger WILL BE: `mediaVelocity ×
 * medianRecentReadMs`. It costs nothing (the same one read, at a different
 * offset), and it is bounded by the two things that make it a prediction
 * rather than a guess:
 *
 *  - a direction RUN of at least {@link SCRUB_LEAD_MIN_DIR_RUN} POINTER
 *    samples, so a jittery or reversing drag never leads. Pointer samples and
 *    not pushes: on this disk a 3 s drag produces ~75 pointer samples and only
 *    ~4 pushes, so a gate counted in pushes has no runway inside the gesture
 *    it is supposed to help — measured in the drag bench, it engaged once, at
 *    the very end;
 *  - at least {@link SCRUB_LEAD_MIN_READ_SAMPLES} measured read, so the lead
 *    is derived from this disk right now and not from a constant. ONE is
 *    enough: against a read cost that is unknown, a one-sample estimate is not
 *    a good prediction — it is simply a far better one than assuming zero.
 *
 * Overshoot is self-correcting: the retarget below serves the newest target
 * the landed fragment covers, so a lead that is slightly long lands on the
 * finger exactly, and one that is wrong costs the same single read it would
 * have cost anyway.
 */
import { scrubLeadDecision } from './scrub-lead.js'

const SCRUB_LEAD_MIN_READ_SAMPLES = 1
/**
 * Smoothing for the media-velocity estimate (ms of timeline per ms of wall
 * clock), folded on every pointer sample. Half-and-half: fast enough to track
 * a fling that starts mid-gesture, slow enough that one jittery sample cannot
 * aim a read an hour away.
 */
const SCRUB_VELOCITY_EMA = 0.5
/** Same-direction POINTER samples required before a read may aim ahead. */
const SCRUB_LEAD_MIN_DIR_RUN = 2
/**
 * Pointer-sample gaps outside this range do not update the velocity estimate:
 * below it the delta is dominated by timer jitter, above it the finger has
 * effectively paused and the "velocity" is an artefact of the pause.
 */
const SCRUB_VELOCITY_MIN_GAP_MS = 10
const SCRUB_VELOCITY_MAX_GAP_MS = 500
/**
 * Receiver-credit cap for scrub pushes: at most this many PUSHES may be
 * OUTSTANDING (on the track, not yet acknowledged by the viewer via
 * `scrubAck`). The coalescing window above shapes the INPUT; on a thin pipe it
 * is not backpressure — pushing a ~45 KB keyframe every 60 ms floods a link
 * that delivers one every 500 ms, RTP drops, and nothing paints. Backpressure
 * is the receiver's: a push spends a credit, the first ack naming it restores
 * that credit, and with zero credit the newest target PARKS on
 * `scrubPendingEpochMs` until an ack (or {@link SCRUB_ACK_TIMEOUT_MS}) arrives.
 *
 * THE UNIT IS THE PUSH, NOT THE FRAME — and getting that wrong is what made a
 * slowed drag die. A push carries one AU in `jump` mode but a whole sweep (~25
 * AUs at 25 fps over a 1 s step) in `sweep` mode, while the viewer emits ONE
 * position per push. Charging one credit per push and repaying one per FRAME
 * meant two sweeps drained the cap against a viewer that could only ever send
 * two acks: the drag parked permanently at the exact moment the operator
 * slowed down to look at something.
 */
const SCRUB_CREDIT_CAP = 2
/**
 * How long an outstanding push may go unacknowledged before the feeder writes
 * it off and takes its credit back.
 *
 * The credit gate is released by an ack and by nothing else — which is right
 * while acks flow and fatal when one is lost: the drag parks with no timer to
 * release it, and `beginScrub` (the only other reset) is a documented no-op
 * mid-drag. Generous on purpose: this is not pacing, it is the bound that
 * makes a lost ack cost one stalled tick instead of the rest of the gesture.
 * Every write-off is logged and counted (`ackTimeouts` on the drag census) —
 * dropped work is never silent.
 */
const SCRUB_ACK_TIMEOUT_MS = 2_000
/**
 * INSTRUMENTATION (D68 tuning). The primary surface is the per-drag AGGREGATE
 * (`scrub-feeder:drag-end`) — one line carrying counts, sums and min/median/max
 * per phase. The per-tick lines below exist only for the cases the aggregate
 * cannot localise, and every one of them is sampled or throttled: at drag rates
 * a line per tick is ~16/s per camera, and the hub is measured at 70–95% main
 * thread with 42 s of synchronous blocks per 120 s. An instrument that costs
 * that much is not an instrument.
 *
 * `scrub-feeder:pushed` keeps ONE representative push per this window (plus the
 * drag's first, which carries the finger-down→first-frame latency).
 */
export const SCRUB_PUSH_LOG_SAMPLE_MS = 1_000
/** A `locate` at/over this gets its own throttled line — it is the phase D68
 *  took off the warm path, so a slow one surviving there is the finding. */
export const SCRUB_SLOW_LOCATE_MS = 400
/** Minimum gap between two lines of the same pathological kind, per drag. */
const SCRUB_PATHOLOGY_LOG_INTERVAL_MS = 1_000
/**
 * How far a `gap` locate may be SNAPPED onto real footage.
 *
 * A snap is a CORRECTION — the playhead landed a moment outside coverage and
 * the operator plainly means the footage beside it — not a SEARCH for wherever
 * footage happens to exist. The distinction is not cosmetic, because the index
 * that answers `locate` cannot tell "there is no footage here" apart from "I
 * have not walked this far back yet": it is rebuilt by walking the archive on
 * every recorder start, and that walk takes minutes.
 *
 * Production 2026-08-02: the recorder had restarted 9 minutes earlier, so
 * `locate` answered `gap` for the whole timeline with a `nearestEdgeMs` 6
 * minutes to 23 HOURS away. Unbounded snapping turned every seek and every drag
 * tick into a segment read against the addon that was busy re-walking, each one
 * blew the 8 s budget, and both surfaces died. Bounded, all of those answer
 * `gap` for free — exactly as they did before snapping existed.
 *
 * 120 s covers the real cases by a wide margin: an inter-segment crack is
 * 11–17 ms, and the dead band between two recording bands measured 48 s. Beyond
 * that the server is answering a question the viewer did not ask; the viewer
 * holds the coverage ranges and can offer "jump to nearest footage" as an
 * action instead.
 */

/** Where a gap should land, if anywhere — see {@link resolveSnapTarget}. */
type SnapDecision =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'too-far'
      readonly snapMs: number
      readonly distanceMs: number
    }
  | { readonly kind: 'snap'; readonly snapMs: number }

/**
 * Decide where a `gap` locate should snap: forward to the next footage edge,
 * else backward onto the last ms of the footage behind (`prevEndMs − 1`, which
 * also hops the 11–17 ms inter-segment cracks). Rejects a candidate further than
 * {@link SNAP_MAX_DISTANCE_MS} so a partially-walked index cannot teleport the
 * cursor — and so rejecting costs NO segment I/O at all.
 */
function resolveSnapTarget(loc: LocatedGap, requestedMs: number): SnapDecision {
  const snapMs = loc.nearestEdgeMs ?? (typeof loc.prevEndMs === 'number' ? loc.prevEndMs - 1 : null)
  if (snapMs === null) return { kind: 'none' }
  const distanceMs = Math.abs(snapMs - requestedMs)
  if (distanceMs > SNAP_MAX_DISTANCE_MS) return { kind: 'too-far', snapMs, distanceMs }
  return { kind: 'snap', snapMs }
}

/** The demuxed segment currently under the playback/step cursor. */
interface StepSegment {
  readonly startMs: number
  readonly durMs: number
  /**
   * Treat as immutable. On the low whole-segment path this array is the same
   * reference stored in the scrub cache — do not splice/sort in place.
   */
  readonly aus: AccessUnit[]
}

/**
 * A scrub fragment plus what its two I/O phases cost. The timings exist so the
 * per-drag aggregate can separate FETCH from DEMUX: D68 replaced whole-file
 * reads with `readGopBytes`, and "the saving should be visible, not assumed".
 */
interface ScrubFragmentLoad {
  readonly seg: StepSegment
  readonly readMs: number
  /** Bytes actually read for this fragment (a GOP range, or the whole file). */
  readonly readBytes: number
  /** Null on the whole-segment path, where read and demux are not separable. */
  readonly demuxMs: number | null
  readonly wholeSegmentRead: boolean
  /** Present when `wholeSegmentRead` — the same bytes loadAus would re-fetch. */
  readonly rawBytes?: Uint8Array
}

/** Whether a demuxed fragment's window covers an absolute instant. */
function fragmentCovers(seg: StepSegment, epochMs: number): boolean {
  return epochMs >= seg.startMs && epochMs < seg.startMs + seg.durMs
}

/** Seek travel-animation tuning — see the SEEK_ANIMATION_* constants. */
export interface SeekAnimationConfig {
  readonly budgetMs?: number
  readonly tickMs?: number
  readonly maxStills?: number
  readonly minDistanceMs?: number
}

/** Scrub frame-deadline tuning — see the SCRUB_*_DEADLINE_MS constants. */
export interface ScrubDeadlineConfig {
  readonly tickMs?: number
  readonly firstTickMs?: number
  readonly rideWindowMs?: number
}

/**
 * The ONE fragment resolution a live drag may have in flight, and the target
 * that started it.
 *
 * It outlives the tick that started it on purpose: when a tick abandons its
 * frame on the deadline, the locate+read+demux behind it cannot be cancelled
 * (it is an RPC already on the wire), so it is allowed to finish INTO THE
 * SESSION CACHE. The next tick either rides it — no second seek on a disk that
 * is the bottleneck — or finds its fragment already cached.
 */
interface ScrubResolveInFlight {
  /** The drag target the read was issued for. */
  readonly target: number
  readonly promise: Promise<ScrubResolution | null>
}

/** What one fragment resolution produced, with its phases, for the census. */
interface ScrubResolution {
  readonly seg: StepSegment
  /** The instant the read was ISSUED for — a rider's target is a different one. */
  readonly requested: number
  /** The instant actually served — differs from `requested` after a gap snap. */
  readonly effTarget: number
  readonly locateCalls: number
  readonly locateMs: number | null
  readonly readMs: number | null
  readonly readBytes: number | null
  readonly demuxMs: number | null
  readonly wholeSegmentRead: boolean
}

/**
 * What the CLIENT's px→time mapping decided for the pointer sample that
 * produced this `scrubTo` (`embed/src/scrub/drag-mapping.ts`).
 *
 * The mapping is the first phase of a scrub tick and the only one the server
 * cannot observe: velocity lives in the gesture. Without it "did the drag ever
 * enter fine mode" is unanswerable from the logs — and if fine mode never
 * engages, nothing downstream matters. Optional on the wire: a client that
 * predates the field leaves the mode UNKNOWN, never mis-attributed.
 */
export interface ScrubMapHint {
  readonly mode: ScrubMapMode
  readonly velocityPxPerS: number
}

/**
 * One outstanding scrub push: which push it is, how many frames it put on the
 * wire, and when it went out. `seq` is what the viewer echoes on `scrubAck`, so
 * the first ack naming it settles it and every surplus ack (an rvfc viewer acks
 * per RENDERED FRAME) is a no-op. It is monotonic for the LIFE OF THE FEEDER,
 * never per drag: a late ack from a drag that already ended then names a
 * sequence no outstanding push can match, instead of settling a fresh one.
 *
 * The push timestamp measures the push→render round trip — with
 * `SCRUB_CREDIT_CAP = 2` that RTT IS the achievable scrub push rate (2 / RTT) —
 * and it is what {@link SCRUB_ACK_TIMEOUT_MS} ages the entry against.
 */
interface OutstandingPush {
  readonly seq: number
  readonly frames: number
  readonly pushedAtMs: number
}

/** Options for {@link RecordedFeeder.seek}. */
export interface SeekOptions {
  /**
   * Where the viewer is COMING FROM, for the travel animation — the session
   * coordinator passes its last emitted position so a fresh feeder (rebuilt on
   * `playRecorded`) can still animate the interval. Null/absent ⇒ the feeder
   * falls back to its own cursor, or skips the animation when it has none.
   */
  readonly travelFromMs?: number | null
  /**
   * The scrub gesture this seek COMMITS, when this seek is a scrub commit.
   * Client-generated, opaque, optional — the server never invents one. Printed
   * on every log line this call produces so a stuck commit can be joined back
   * to the `[app:*]` lines that share it, without relying on clock ordering
   * across the phone/hub boundary (see {@link FeederStateTransition}).
   */
  readonly dragId?: string
}

/** One intermediate travel still: the keyframe, its fragment, its instant. */
interface TravelStill {
  readonly seg: StepSegment
  readonly au: AccessUnit
  readonly tMs: number
}

/**
 * The covering segment a rate>0 seek/resume hands to the advance loop: the
 * IDR→cursor prefix was already burst by `seek()`; the loop must PACE only the
 * items strictly after `resumeAfterPtsMs` (null = pace the whole segment).
 */
interface InitialAdvanceSegment {
  readonly prepared: PreparedSegment
  readonly resumeAfterPtsMs: number | null
}

/** A located + demuxed segment ready to push (prefetch result). */
interface PreparedSegment {
  readonly startMs: number
  readonly durMs: number
  readonly aus: AccessUnit[]
  readonly audio: AudioAccessUnit[]
  readonly readMs?: number
  readonly demuxMs?: number
  readonly bytes?: number
}

/** One `loadAus` result — video/audio plus the FUSE vs demux split. */
interface LoadedAus {
  readonly video: AccessUnit[]
  readonly audio: AudioAccessUnit[]
  readonly readMs: number
  readonly demuxMs: number
  readonly bytes: number
}

/** How the seek prefix was obtained — the land-stall question. */
type SeekPrefixSource = 'cache' | 'gop' | 'whole' | 'none'

type PlayCensusReason = 'tick' | 'stall' | 'stop'

interface PlayCensusWindow {
  windowStartedAt: number
  pacedAus: number
  segments: number
  prefetchWaitMsMax: number
  stalls: number
  lastReadMs: number
  lastDemuxMs: number
  lastBytes: number
}

function emptyPlayCensus(): PlayCensusWindow {
  return {
    windowStartedAt: 0,
    pacedAus: 0,
    segments: 0,
    prefetchWaitMsMax: 0,
    stalls: 0,
    lastReadMs: 0,
    lastDemuxMs: 0,
    lastBytes: 0,
  }
}

/**
 * One entry in a segment's PTS-ordered delivery schedule — exactly one of
 * `video` / `audio` is set. Built by `paceSegment` to interleave video + audio
 * by source PTS so neither stream is delivered as a burst.
 */
interface ScheduledItem {
  readonly ptsMs: number
  readonly video?: AccessUnit
  readonly audio?: AudioAccessUnit
}

export class RecordedFeeder {
  /**
   * ONE origin for both tracks. Two independent ones replaced the real A/V
   * offset with the interleave gap at every seek, in the same direction each
   * time — measured at 23 ms per seek on the clock alone and 900 ms over
   * three seeks on a real clip. See `FeedOrigin`.
   */
  private readonly feedOrigin = new FeedOrigin()
  private clock = new MonotonicClock(90000, this.feedOrigin)
  /** Audio clock (PCMU 8 kHz / Opus 48 kHz); re-anchored together with video. */
  private audioClock: MonotonicClock
  private clockHasAdvanced = false
  /** Playback rate: 0 (paused) or a continuous factor in [0.25, 8]. */
  private rate = 1
  private disposed = false
  private seekToken = 0
  private advanceToken = 0
  private cursorMs = 0
  private positionTimer: ReturnType<typeof setInterval> | null = null
  private positionTicks = 0
  private playCensus: PlayCensusWindow = emptyPlayCensus()
  /**
   * The demuxed segment "under the cursor" — the frame-step working set. Kept
   * in lockstep with every feed path (seek burst, paused partial feed, pacing)
   * so a pause at any moment can step from the exact last-fed frame.
   */
  private currentSegment: StepSegment | null = null
  /** Index (into `currentSegment.aus`) of the last video AU fed; -1 = none. */
  private lastFedVideoIdx = -1
  /** Serializes frame steps without dropping rapid taps. */
  private stepInFlight = false
  private readonly pendingStepDirs: Array<1 | -1> = []
  /**
   * Target epoch of the seek currently in flight (null when none). A rate
   * change re-enters via seek(); while a seek is still resolving, `cursorMs`
   * is stale — re-seeking the in-flight target instead avoids snapping back to
   * the pre-seek position when the client changes rate right after a seek.
   */
  private inFlightSeekEpochMs: number | null = null
  /**
   * EXPERIMENTAL feeder-scrub sub-mode. While true the normal advance/feed loop
   * is suspended and each coalesced `scrubTick` pushes the covering fragment's
   * nearest keyframe ≤ the drag target. `scrubToken` is the MODE-EXIT guard (not
   * a per-move token): it is bumped on `beginScrub`, on the commit `seek`, and on
   * `dispose`, so an in-flight tick whose captured generation no longer matches
   * drops itself. Latest-wins across rapid moves is handled by COALESCING —
   * `scrubPendingEpochMs` always holds the newest target, and one tick per
   * `SCRUB_COALESCE_MS` window processes it.
   */
  private scrubbing = false
  private scrubToken = 0
  /** Remaining receiver credit for scrub pushes — see {@link SCRUB_CREDIT_CAP}. */
  private scrubCredit = SCRUB_CREDIT_CAP
  /**
   * The pushes on the wire and not yet settled, OLDEST FIRST (and therefore
   * ascending in both `seq` and `pushedAtMs` — every settle and every write-off
   * takes a prefix). One entry per push, whatever it carried: the first
   * `scrubAck` naming it returns its credit.
   */
  private scrubOutstanding: OutstandingPush[] = []
  /**
   * The push sequence the viewer echoes on `scrubAck`. Monotonic for the life of
   * the feeder — see {@link OutstandingPush} for why it must NOT restart per
   * drag.
   */
  private scrubPushSeq = 0
  /**
   * The write-off timer for the oldest outstanding push
   * ({@link SCRUB_ACK_TIMEOUT_MS}). Separate from `scrubTimer` on purpose: that
   * one is the coalescing slot, and an ack arriving while this is pending must
   * be able to schedule a leading-edge tick without waiting on it.
   */
  private scrubAckTimer: ReturnType<typeof setTimeout> | null = null
  /** One `scrub-feeder:ack-timeout` line per drag — the count is on the census. */
  private scrubAckTimeoutLogged = false
  /** The newest un-processed drag target (null when the tick cycle has drained). */
  private scrubPendingEpochMs: number | null = null
  /** The mapping hint that came with the newest target (latest-wins with it). */
  private scrubPendingHint: ScrubMapHint | null = null
  /**
   * The active coalescing timer. Non-null means a tick cycle is live (scheduled
   * OR running its async load) — it is the single re-entrancy guard, so a burst
   * of `scrubTo` calls coalesce onto `scrubPendingEpochMs` instead of spawning
   * parallel demuxes.
   */
  private scrubTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * The fragment demuxed by the last tick (same-fragment memo): consecutive drag
   * targets inside ONE fragment reuse these access units instead of re-running
   * readBytes/demux (ffmpeg) per pointer move. Reset on fragment change + exit.
   */
  private scrubSegment: StepSegment | null = null
  /**
   * The demuxed-fragment LRU. Session-scoped when the broker injects one
   * (`deps.fragmentCache` — the timeline warm-up writes into it BEFORE any
   * feeder exists, and it survives every `enterRecorded` rebuild), private
   * otherwise. Never cleared on commit/dispose: recorded footage is immutable,
   * so a revisited fragment — back-and-forth drags, a second drag after a
   * commit — pushes with zero re-read; only the LRU bound evicts.
   */
  private readonly scrubCache: ScrubFragmentCache
  /**
   * The last drag target a `scrubTick` PROCESSED (null before the first). The
   * sign of `(newTarget − this)` is the drag direction that steers prefetch.
   */
  private scrubPrevTarget: number | null = null
  /** The last AU actually pushed this drag — the sweep-continuity cursor
   *  (which fragment, and how deep into its AU list). Null until a jump lands. */
  private scrubCursor: {
    fragStartMs: number
    fragDurMs: number
    idx: number
  } | null = null
  /**
   * Per-drag phase accounting — the whole of `scrub-feeder:drag-end`. Non-null
   * exactly while a drag is live; `beginScrub` creates it, the commit `seek`
   * and `dispose` drain it into the one aggregate line and clear it.
   */
  private scrubStats: ScrubDragStats | null = null
  private scrubStartedAtMs = 0
  /** The tally reading at drag start, so the aggregate reports THIS drag. */
  private scrubDemuxMark: DemuxPathCounts | null = null
  /** Once-per-drag guard: a dead-zone drag ticks fast; one line says it all. */
  private scrubNoFootageLogged = false
  /** Once-per-drag guard for the zero-credit park (every pointer move parks). */
  private scrubParkLogged = false
  /** Sampling clocks for the two per-tick lines that survive. */
  private scrubLastPushLogAtMs = 0
  private scrubLastSlowLocateLogAtMs = 0
  /**
   * Fragment starts this drag put in the cache SPECULATIVELY. A later tick that
   * hits one of them is what makes speculation provably worth its I/O
   * (`prefetchHits`) — without this the feeder could double the load on the disk
   * that is the bottleneck and the census would look calm.
   */
  private scrubPrefetched = new Set<number>()
  /** Segment starts already reported by {@link repairPts} — see the docblock. */
  private ptsRepairLogged = new Set<number>()
  /** Recent read durations — the evidence speculation is suspended on. */
  private scrubReadMsWindow: number[] = []
  /** Warm-up runs once per drag, from the playhead the finger went down on. */
  private scrubWarmStarted = false
  /**
   * True while the fill window belongs to IDLE mode — started by a seek (a
   * timeline tap or a scrub commit) rather than by a drag. An idle fill paces
   * itself ({@link IDLE_WARM_READ_GAP_MS}) and yields to any in-flight seek;
   * a drag's own warm (`beginScrub`) always takes the window over.
   */
  private idleWarm = false
  /** Centre of the fill currently in flight (or last completed). */
  private scrubWarmCentreMs: number | null = null
  /** Bumped to abort a fill without aborting the drag tick (`scrubToken`). */
  private scrubWarmGen = 0
  /** Tick demand-read in flight: the fill waits so the finger wins the spindle. */
  private scrubTickReadInFlight = false
  /**
   * The newest fragment resolution in flight for this drag — what a later tick
   * rides instead of issuing its own read. Cleared by the resolution itself.
   */
  private scrubResolve: ScrubResolveInFlight | null = null
  /** Concurrent resolutions, bounded by {@link SCRUB_RESOLVE_MAX_INFLIGHT}. */
  private scrubResolvesInFlight = 0
  /** One `deadline-miss` line per drag; the count lives on the aggregate. */
  private scrubDeadlineLogged = false
  /** One `oversize-segment` line per drag; the count lives on the aggregate. */
  private scrubOversizeLogged = false
  /** One `profile-degraded` line per drag — the `low` pin is lost. */
  private scrubProfileLogged = false
  /** Has this drag put a frame on the wire? Gates the first-frame deadline. */
  private scrubPushedThisDrag = false
  /** Smoothed media-ms per wall-ms of the drag, signed. Null until measurable. */
  private scrubVelocity: number | null = null
  /** Previous pointer sample, for the velocity estimate above. */
  private scrubLastSampleMs: number | null = null
  private scrubLastSampleAtMs = 0
  /** Signed run of consecutive same-direction POINTER samples. */
  private scrubVelRun = 0
  /** One fill walker per drag — a fling retargets it, it does not spawn another. */
  private scrubFillLoopActive = false
  private scrubWarmBackMs = SCRUB_WARM_BACK_MS
  private scrubWarmFwdMs = SCRUB_WARM_FWD_MS
  /**
   * The client-supplied id of the CURRENT (or most recently active) scrub
   * gesture, set by `beginScrub(dragId)`. Printed on every `scrub-feeder:*`
   * line — ticks, warm fill, park/deadline/ack pathologies, and the drag-end
   * aggregate — so a drag can be isolated in the logs without depending on
   * wall-clock proximity. `undefined` outside a drag (and for a feeder whose
   * caller never sends one — additive, optional, see D1 in the plan).
   */
  private scrubDragId: string | undefined
  /** This feeder's own last-announced state — the `from` half of every
   *  {@link FeederStateTransition}. `null` before the first transition. */
  private lastAnnouncedState: FeederState | null = null

  constructor(private readonly deps: RecordedFeederDeps) {
    this.audioClock = new MonotonicClock(deps.audioClockRateHz ?? 8000, this.feedOrigin)
    this.scrubCache = deps.fragmentCache ?? new ScrubFragmentCache()
  }

  /**
   * The negotiated audio sink push fn (Opus preferred, else PCMU), or undefined
   * for a video-only sink. A feeder is wired with exactly ONE of the two.
   */
  private resolveAudioPush(): ((data: Uint8Array, rtpTs: number) => void) | undefined {
    const sink = this.deps.sink
    const opus = sink.pushAudioOpus
    if (typeof opus === 'function') return (data, rtpTs) => opus.call(sink, data, rtpTs)
    const pcmu = sink.pushAudioPcmu
    if (typeof pcmu === 'function') return (data, rtpTs) => pcmu.call(sink, data, rtpTs)
    return undefined
  }

  /**
   * Emit one state transition through `onState` — see
   * {@link FeederStateTransition} for why `from`/`reason`/`seekToken` exist.
   * The ONLY place `this.lastAnnouncedState` is written, so every announced
   * state (wherever it is announced from) is captured as the next
   * transition's `from`.
   */
  private emitState(to: FeederState, reason: string, seekToken: number, dragId?: string): void {
    const from = this.lastAnnouncedState
    this.lastAnnouncedState = to
    this.deps.onState({ from, to, reason, seekToken, dragId })
  }

  /**
   * ONE line per `seek()` call, unconditionally — the C3 rendiconto. Before
   * this, a commit's outcome was told by WHICHEVER of several lines happened
   * to fire: `recorded:seek-ready` only on success, `recorded:seek-abandoned`
   * only when a later token/dispose superseded this one, `recorded:seek-no-footage`
   * / `recorded:snap-too-far` only on a gap — and a raw thrown error (or an
   * error on an ALREADY-abandoned commit) logged NOTHING at all. That silent
   * shape is exactly the 2026-08-26 stall: two commits reached
   * `playback:intent` and never `playback:ready`, with nothing in the feeder's
   * own logs saying why. Every return path in `seek()` now calls this before
   * it exits, so a commit that never lands still leaves one line naming what
   * happened to it.
   */
  private logSeekOutcome(
    token: number,
    seekStartedAt: number,
    epochMs: number,
    dragId: string | undefined,
    outcome: 'served' | 'gap' | 'error' | 'abandoned',
    state: FeederState | null,
  ): void {
    this.deps.onLog?.('recorded:seek-outcome', {
      dragId,
      epochMs,
      outcome,
      state,
      disposed: this.disposed,
      superseded: token !== this.seekToken,
      tokenAtStart: token,
      tokenNow: this.seekToken,
      totalMs: Math.round(performance.now() - seekStartedAt),
    })
  }

  /**
   * Seek to an epoch and (if rate > 0) begin forward playback. Resolves after
   * the FIRST located segment is fed; the forward `advance` loop is started
   * fire-and-forget so seek never blocks on its pacing. Latest-wins: a newer
   * seek bumps the token and silently abandons this one.
   */
  async seek(epochMs: number, opts?: SeekOptions): Promise<void> {
    const seekStartedAt = performance.now()
    let locateMs = 0
    let travelMs = 0
    let loadMs = 0
    let firstFrameMs = 0
    const token = ++this.seekToken
    // The scrub gesture this call COMMITS, when it is a commit — the caller
    // (a `scrubCommit` control message) passes the same id it gave
    // `beginScrub`. Undefined for a plain seek/playRecorded. Captured once so
    // every line this call produces — success, gap, abandon, error — names
    // the same gesture (C1).
    const dragId = opts?.dragId
    // A scrub COMMIT must land immediately — the drag already showed the
    // travel. Captured before the scrub-exit block below flips the flag.
    const wasScrubbing = this.scrubbing
    // Leaving the feeder-scrub sub-mode: a real seek (the scrub commit) supersedes
    // any pending scrub push. Bumping scrubToken invalidates any in-flight
    // scrubTick; cancelling the coalescing timer stops a still-scheduled leading-
    // edge/re-arm tick from firing; the memo is dropped so a later drag re-reads.
    // seek() already bumps seekToken/advanceToken below/above.
    if (this.scrubbing) {
      // The whole drag on ONE line, server-side, phase by phase.
      this.emitDragEnd()
      this.scrubbing = false
      this.scrubToken++
      this.scrubSegment = null
      this.scrubCursor = null
      this.scrubOutstanding = []
      this.clearScrubAckTimeout()
      this.scrubPendingHint = null
      // Commit teardown. The fragment CACHE is intentionally kept: footage is
      // immutable and the next drag routinely revisits the committed moment —
      // clearing here used to throw away exactly the fragments the warm-up
      // paid for. (A bumped scrubToken already invalidates any in-flight
      // prefetch.)
      this.scrubPrevTarget = null
      if (this.scrubTimer) {
        clearTimeout(this.scrubTimer)
        this.scrubTimer = null
      }
    }
    // Latest-wins for the ADVANCE loop too (not just the feed): bump advanceToken
    // up-front so any loop already pacing a previous position bails on its next
    // `gen === advanceToken` check (loop guard / paceSegment / sleepUntil) RIGHT
    // NOW — before this seek's async locate+load+prefix runs. Without this the old
    // loop keeps dripping stale-position frames onto the same output clock during
    // the new seek's I/O window, interleaving two positions → the post-commit
    // "scrub freezes/stutters" symptom. A normal seek re-bumps it in startAdvance()
    // (line below); a gap/paused seek leaves it bumped so the old loop stays dead.
    this.advanceToken++
    this.inFlightSeekEpochMs = epochMs
    // Set once this seek lands somewhere the caller did NOT ask for. A snap is a
    // courtesy the server pays for with a segment load; when that load fails the
    // honest answer is the one the caller would have got without the courtesy
    // ('gap' — recoverable, the client re-seeks), never the terminal 'error'.
    let snapInfo: {
      readonly requestedMs: number
      readonly snappedMs: number
    } | null = null
    try {
      this.emitState('loading', 'seek-start', token, dragId)
      // Re-base the output clocks only once something has already been emitted —
      // the first feed after a fresh feeder must start at rtp ts 0. Audio + video
      // re-anchor together so they stay aligned across the seek. A seek is a
      // NON-contiguous jump: stamp a large, unmistakable discontinuity (not the
      // ~1-frame segment-boundary nudge) so any stale in-flight AU from the
      // aborted pace loop can never look contiguous with the new GOP on the
      // receiver (see SEEK_DISCONTINUITY_MS — the scrub-smear root cause).
      if (this.clockHasAdvanced) {
        this.clock.markDiscontinuity(SEEK_DISCONTINUITY_MS)
        this.audioClock.markDiscontinuity(SEEK_DISCONTINUITY_MS)
      }

      const locateStartedAt = performance.now()
      let loc = await this.withTimeout(
        this.deps.locate({
          deviceId: this.deps.deviceId,
          profile: this.deps.profile,
          epochMs,
        }),
      )
      locateMs += performance.now() - locateStartedAt
      if (this.disposed || token !== this.seekToken) {
        this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'abandoned', null)
        return
      }

      // Where the pointer actually lands. A seek into a crack — or a moment past
      // the archive's edge — SNAPS to the footage beside it instead of reporting
      // a false gap. Bounded by SNAP_MAX_DISTANCE_MS: beyond that the "nearest
      // edge" is not a correction but an index that has not walked the archive
      // yet, and answering it would cost a segment load. Every formerly-silent
      // branch here logs.
      let landMs = epochMs
      if (loc.kind === 'gap') {
        const decision = resolveSnapTarget(loc, epochMs)
        if (decision.kind !== 'snap') {
          if (decision.kind === 'too-far') {
            this.deps.onLog?.('recorded:snap-too-far', {
              dragId,
              requestedMs: epochMs,
              nearestMs: decision.snapMs,
              distanceMs: decision.distanceMs,
            })
          } else {
            // NO footage in either direction — the only true gap, and it logs.
            this.deps.onLog?.('recorded:seek-no-footage', {
              dragId,
              requestedMs: epochMs,
            })
          }
          this.currentSegment = null // nothing under the cursor — steps no-op
          this.lastFedVideoIdx = -1
          this.stopPositionReports()
          this.emitState(
            'gap',
            decision.kind === 'too-far' ? 'seek-snap-too-far' : 'seek-no-footage',
            token,
            dragId,
          )
          this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'gap', 'gap')
          return
        }
        const snapLocateStartedAt = performance.now()
        const snapped = await this.withTimeout(
          this.deps.locate({
            deviceId: this.deps.deviceId,
            profile: this.deps.profile,
            epochMs: decision.snapMs,
          }),
        )
        locateMs += performance.now() - snapLocateStartedAt
        if (this.disposed || token !== this.seekToken) {
          this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'abandoned', null)
          return
        }
        if (snapped.kind !== 'segment') {
          this.deps.onLog?.('recorded:seek-no-footage', {
            dragId,
            requestedMs: epochMs,
            snappedMs: decision.snapMs,
          })
          this.currentSegment = null
          this.lastFedVideoIdx = -1
          this.stopPositionReports()
          this.emitState('gap', 'seek-snap-target-no-footage', token, dragId)
          this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'gap', 'gap')
          return
        }
        this.deps.onLog?.('recorded:seek-snapped', {
          dragId,
          requestedMs: epochMs,
          snappedMs: decision.snapMs,
        })
        loc = snapped
        landMs = decision.snapMs
        snapInfo = { requestedMs: epochMs, snappedMs: decision.snapMs }
      }

      // SEEK TRAVEL: a seek must not teleport — show the interval it crosses,
      // bounded by budget, then land EXACTLY. Skipped for a scrub commit (the
      // drag showed the travel) and when there is nothing on screen to travel
      // FROM (a truly fresh session). Runs after the snap so it never animates
      // into no-footage; a newer seek aborts it via the token like everything
      // else in this method.
      const travelFromMs = opts?.travelFromMs ?? (this.clockHasAdvanced ? this.cursorMs : null)
      if (!wasScrubbing && travelFromMs !== null) {
        const travelStartedAt = performance.now()
        await this.animateSeekTravel(travelFromMs, landMs, token, dragId)
        travelMs = performance.now() - travelStartedAt
        if (this.disposed || token !== this.seekToken) {
          this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'abandoned', null)
          return
        }
      }

      this.cursorMs = loc.startMs
      // The small target GOP owns first paint. Only AFTER it is on the wire do
      // we start the full-segment load for paced continuation, audio, and
      // deterministic frame-step. The recorder cap runner serializes/contends
      // these reads in production; starting the large read first made the
      // supposedly-prioritized GOP wait behind it for several seconds.
      // Providers without readGop retain the whole-segment path.
      const loadStartedAt = performance.now()
      let prefixFed = false
      let gopFirst = false
      let stateAnnounced = false
      let reusedWhole: { video: AccessUnit[]; bytes: Uint8Array } | null = null
      let prefixSource: SeekPrefixSource = 'none'
      if (this.deps.readGop) {
        const cached = this.scrubCache.covering(this.deps.profile, landMs)
        let fragment: StepSegment
        if (cached) {
          // Cache has demuxed AUs, not the raw .m4s. Playback still loadAus-
          // reads the file. The one-read reuse below is the cold attach path.
          fragment = cached
          prefixSource = 'cache'
        } else {
          const fragmentLoad = await this.loadScrubFragment(loc, landMs)
          if (fragmentLoad === null) {
            this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'abandoned', null)
            return
          }
          fragment = fragmentLoad.seg
          this.scrubCache.put(this.deps.profile, fragment)
          prefixSource = fragmentLoad.wholeSegmentRead ? 'whole' : 'gop'
          if (fragmentLoad.wholeSegmentRead && fragmentLoad.rawBytes) {
            reusedWhole = { video: fragment.aus, bytes: fragmentLoad.rawBytes }
          }
        }
        if (this.disposed || token !== this.seekToken) {
          this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'abandoned', null)
          return
        }
        const fragmentLoc: LocatedSegment = {
          kind: 'segment',
          startMs: fragment.startMs,
          durMs: fragment.durMs,
          bytes: loc.bytes,
        }
        this.feedPrefix(fragmentLoc, fragment.aus, landMs)
        prefixFed = true
        gopFirst = true
        firstFrameMs = performance.now() - seekStartedAt
        // Reveal the painted frame immediately. Full-segment preparation can
        // continue behind this stable frame instead of holding the Viewer in
        // its loading state until audio and every AU have been prepared.
        this.emitState(
          this.rate === 0 ? 'paused' : 'playing',
          'seek-gop-prefix-landed',
          token,
          dragId,
        )
        this.deps.onPosition(this.cursorMs)
        this.startPositionReports()
        stateAnnounced = true
      }
      let loaded: LoadedAus | null
      let loadAusMs = 0
      if (reusedWhole) {
        // `low` already read the whole file for the prefix. A second FUSE
        // read of the same .m4s doubled attach (seek-ready 2026-08-22: first
        // frame 0.5–3 s, then loadMs another 0.3–3 s before startAdvance).
        // This await is the frozen picture: the video prefix is already fed
        // and `state=playing` already announced, and `startAdvance` is behind
        // it. Bounded by `AUDIO_DEMUX_TIMEOUT_MS`, not the segment deadline.
        //
        // And it LOGS when it drops the audio. It did not, and that is why an
        // 8 s freeze on 4 of 9 seeks produced zero lines and had to be found
        // by subtracting `firstFrameMs` from `loadMs` (repo rule: a branch
        // that drops work silently logs it).
        let audio: AudioAccessUnit[] = []
        if (this.rate !== 0 && this.deps.demuxAudio && this.resolveAudioPush() !== undefined) {
          const audioStartedAt = Date.now()
          try {
            audio = [
              ...(await this.withTimeout(
                this.deps.demuxAudio(reusedWhole.bytes),
                AUDIO_DEMUX_TIMEOUT_MS,
              )),
            ]
          } catch (err) {
            this.deps.onLog?.('recorded:seek-audio-dropped', {
              dragId,
              waitedMs: Date.now() - audioStartedAt,
              budgetMs: AUDIO_DEMUX_TIMEOUT_MS,
              bytes: reusedWhole.bytes.byteLength,
              reason: err instanceof Error ? err.message : String(err),
            })
          }
        }
        loaded = {
          video: reusedWhole.video,
          audio,
          readMs: 0,
          demuxMs: 0,
          bytes: reusedWhole.bytes.byteLength,
        }
      } else {
        const fullLoad = this.loadAus(
          loc.startMs,
          loc.durMs,
          this.rate !== 0,
          this.deps.readGop
            ? undefined
            : (video) => {
                if (this.disposed || token !== this.seekToken) return
                this.feedPrefix(loc, video, landMs)
                prefixFed = true
                firstFrameMs = performance.now() - seekStartedAt
              },
        )
        void fullLoad.catch(() => {})
        const loadAusStartedAt = performance.now()
        loaded = await fullLoad
        loadAusMs = performance.now() - loadAusStartedAt
      }
      loadMs = performance.now() - loadStartedAt
      if (this.disposed || token !== this.seekToken || loaded === null) {
        // A SUPERSEDED SEEK IS SILENT BY DESIGN — on the assumption that
        // whoever bumped the token announces a state in its place. `seek()`
        // does. `beginScrub()` DOES NOT: it bumps `seekToken` and returns.
        //
        // Its guard (`if (this.scrubbing) return`) makes a re-sent scrubStart a
        // no-op DURING a drag, which is the storm it was written for. It does
        // not cover the commit: the commit `seek()` sets `scrubbing = false`
        // before it goes to disk, so a `scrubStart` landing inside that load
        // passes the guard, invalidates the seek — which has ALREADY emitted
        // `onState('loading')` — and nothing ever announces again.
        //
        // Reported 2026-08-26, camera 104: two commits reached
        // `playback:intent` and never `playback:ready`, with the feeder left on
        // `loading`. The hazard above is real in the code; that it caused THAT
        // stall is NOT proven, because app lines carry the phone's clock and
        // feeder lines carry the hub's, so the two cannot be ordered against
        // each other at this resolution.
        //
        // So this logs instead of guessing. The next occurrence names its own
        // cause: whether the token moved at all, and how far.
        this.deps.onLog?.('recorded:seek-abandoned', {
          dragId,
          requestedMs: epochMs,
          disposed: this.disposed,
          superseded: token !== this.seekToken,
          tokenAtStart: token,
          tokenNow: this.seekToken,
          loadedNull: loaded === null,
          announcedLoading: true,
          loadMs: Math.round(loadMs),
        })
        this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'abandoned', null)
        return
      }

      // Prefix burst: IDR → requested epoch (always at least the first AU).
      // Sets cursorMs to the (clamped) requested epoch + the step state.
      if (!prefixFed) this.feedPrefix(loc, loaded.video, landMs)
      if (gopFirst) {
        // Replace the temporary GOP step state with the complete segment once
        // it is ready. A step command queued during the seek can now move
        // across GOP boundaries without reloading or jumping backward.
        this.currentSegment = {
          startMs: loc.startMs,
          durMs: loc.durMs,
          aus: loaded.video,
        }
        const firstFullPtsMs = loaded.video[0]?.ptsMs ?? 0
        const targetPtsMs = firstFullPtsMs + Math.max(0, this.cursorMs - loc.startMs)
        this.lastFedVideoIdx = -1
        for (let i = 0; i < loaded.video.length; i++) {
          const au = loaded.video[i]
          if (!au || au.ptsMs > targetPtsMs) break
          this.lastFedVideoIdx = i
        }
        if (this.clockHasAdvanced) {
          // The standalone GOP and full segment use different PTS origins.
          // Re-anchor before either paused frame-step or paced continuation.
          this.clock.markSeek()
          this.audioClock.markSeek()
        }
      }

      if (this.rate === 0) {
        // Paused: the prefix IS the feed — the exact frame renders. Report the
        // position immediately so the client playhead lands on it.
        if (!stateAnnounced) {
          this.emitState('paused', 'seek-landed-paused', token, dragId)
          this.deps.onPosition(this.cursorMs)
          this.startPositionReports()
        }
        this.logSeekReady({
          dragId,
          epochMs,
          startedAt: seekStartedAt,
          locateMs,
          travelMs,
          loadMs,
          firstFrameMs,
          state: 'paused',
          prefixSource,
          reusedWhole: reusedWhole !== null,
          readMs: loaded.readMs,
          demuxMs: loaded.demuxMs,
          bytes: loaded.bytes,
          loadAusMs: Math.round(loadAusMs),
        })
        // The operator is now sitting on this frame — fill the window around
        // it while they decide where to go next (idle warm, paced).
        this.startIdleWarm(this.cursorMs)
        this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'served', 'paused')
        return
      }

      // Rate > 0 (fresh seek AND resume-after-pause/rate-change, which re-enter
      // here via setRate → seek(cursor)): playback continues FROM THE CURSOR —
      // the advance loop paces the REMAINDER of this covering segment (the AUs
      // strictly after the prefix) at the current rate, then crosses into the
      // next segment as usual. No whole-segment burst, no jump to segment end.
      if (!stateAnnounced) {
        this.emitState('playing', 'seek-landed-playing', token, dragId)
        this.deps.onPosition(this.cursorMs)
        this.startPositionReports()
      }
      this.logSeekReady({
        dragId,
        epochMs,
        startedAt: seekStartedAt,
        locateMs,
        travelMs,
        loadMs,
        firstFrameMs,
        state: 'playing',
        prefixSource,
        reusedWhole: reusedWhole !== null,
        readMs: loaded.readMs,
        demuxMs: loaded.demuxMs,
        bytes: loaded.bytes,
        loadAusMs: Math.round(loadAusMs),
      })
      const firstFullAu = loaded.video[0]
      const resumeAfterPtsMs = gopFirst
        ? firstFullAu
          ? firstFullAu.ptsMs + Math.max(0, this.cursorMs - loc.startMs)
          : null
        : this.lastFedVideoIdx >= 0
          ? (loaded.video[this.lastFedVideoIdx]?.ptsMs ?? null)
          : null
      this.startAdvance({
        prepared: {
          startMs: loc.startMs,
          durMs: loc.durMs,
          aus: loaded.video,
          audio: loaded.audio,
          readMs: loaded.readMs,
          demuxMs: loaded.demuxMs,
          bytes: loaded.bytes,
        },
        resumeAfterPtsMs,
      })
      // Playback is rolling from the landing; the paced advance owns the
      // forward reads, and the idle fill (paced, seek-yielding) covers the
      // window a NEXT drag would start from.
      this.startIdleWarm(this.cursorMs)
      this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'served', 'playing')
    } catch (err) {
      // seek() is called fire-and-forget by external control dispatch
      // (TimelineSession). Surface failures as an 'error' state rather than
      // rejecting to the caller. Latest-wins: a newer seek owns recovery.
      if (!this.disposed && token === this.seekToken) {
        this.stopPositionReports()
        if (snapInfo !== null) {
          // The load we attempted was for a moment the caller never asked for.
          // 'error' is TERMINAL — nothing retries it, so one slow read kills the
          // surface for the rest of the session. Degrade to the answer an
          // un-snapped seek would have given: 'gap', which the client renders as
          // "no footage" and can seek away from.
          this.deps.onLog?.('recorded:seek-snap-load-failed', {
            dragId,
            requestedMs: snapInfo.requestedMs,
            snappedMs: snapInfo.snappedMs,
            error: errMsg(err),
          })
          this.currentSegment = null
          this.lastFedVideoIdx = -1
          this.emitState('gap', 'seek-snap-load-failed', token, dragId)
          this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'gap', 'gap')
          return
        }
        // A thrown error on a commit still owned by this token — the ONLY
        // path that used to log nothing at all: no `recorded:seek-*` line
        // named the error, only the bare `onState('error')`. This is the
        // other silent shape the 2026-08-26 stall could have had.
        this.emitState('error', 'seek-error', token, dragId)
        this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'error', 'error')
      } else {
        // The commit that threw was ALREADY superseded or disposed — the
        // error itself is uninteresting (nobody is waiting on this seek
        // anymore), but the exit still gets the one line every path owes.
        this.logSeekOutcome(token, seekStartedAt, epochMs, dragId, 'abandoned', null)
      }
    } finally {
      // Only the LATEST seek clears the marker — an abandoned one must not
      // wipe the in-flight target of the seek that superseded it.
      if (token === this.seekToken) {
        this.inFlightSeekEpochMs = null
        this.drainStepQueue()
      }
    }
  }

  private logSeekReady(fields: {
    readonly dragId?: string
    readonly epochMs: number
    readonly startedAt: number
    readonly locateMs: number
    readonly travelMs: number
    readonly loadMs: number
    readonly firstFrameMs: number
    readonly state: 'paused' | 'playing'
    readonly prefixSource: SeekPrefixSource
    readonly reusedWhole: boolean
    readonly readMs: number
    readonly demuxMs: number
    readonly bytes: number
    readonly loadAusMs: number
  }): void {
    this.deps.onLog?.('recorded:seek-ready', {
      dragId: fields.dragId,
      epochMs: fields.epochMs,
      state: fields.state,
      totalMs: Math.round(performance.now() - fields.startedAt),
      locateMs: Math.round(fields.locateMs),
      travelMs: Math.round(fields.travelMs),
      loadMs: Math.round(fields.loadMs),
      firstFrameMs: Math.round(fields.firstFrameMs),
      prefixSource: fields.prefixSource,
      reusedWhole: fields.reusedWhole,
      readMs: Math.round(fields.readMs),
      demuxMs: Math.round(fields.demuxMs),
      bytes: fields.bytes,
      loadAusMs: Math.round(fields.loadAusMs),
    })
  }

  /**
   * Set playback rate. 0 pauses in place (the pacing loop aborts on its next
   * guard check); any other value is clamped to [0.25, 8].
   *
   * Rate-change strategy (documented choice): every transition TO a non-zero
   * rate — resume from pause AND a playing→playing rate change — re-enters via
   * `seek(cursorMs)`. seek() bumps `advanceToken` up-front, which aborts any
   * mid-segment pacing loop, then re-feeds the covering segment from its IDR
   * (a burst — the decoder needs the GOP head) and restarts the advance loop
   * pacing at the new rate. No in-place re-pacing of a half-delivered segment.
   */
  setRate(rate: number): void {
    if (this.disposed) return
    const next = clampPlaybackRate(rate)
    // No-op on a redundant set — prevents starting a duplicate advance loop.
    if (next === this.rate) return
    this.rate = next
    if (next === 0) {
      this.advanceToken++
      this.stopPositionReports()
      this.emitState('paused', 'rate-zero', this.seekToken, this.scrubDragId)
      return
    }
    this.pendingStepDirs.length = 0
    // Only the VIDEO clock carries the rate factor — audio is delivered only at
    // 1× (dropped otherwise), so the 8 kHz clock always stays real-time.
    this.clock.setRate(next)
    // seek() emits 'loading' → 'playing' itself and starts the advance loop.
    // Re-enter at the in-flight seek target when one is still resolving —
    // cursorMs is stale until that seek completes.
    void this.seek(this.inFlightSeekEpochMs ?? this.cursorMs)
  }

  /**
   * EXPERIMENTAL feeder-scrub: enter the scrub sub-mode. Aborts any in-flight
   * seek/advance loop (latest-wins, exactly like `seek()` does up-front) and
   * suspends the ~1 Hz position timer — during a drag position is reported per
   * pushed keyframe instead. `this.rate` is preserved for the post-commit resume
   * (the commit `seek` re-enters at the same rate).
   *
   * Idempotent WITHIN a drag: a second `beginScrub` while already scrubbing is a
   * NO-OP. The app may re-send `scrubStart` mid-gesture (the observed repeated
   * `scrubStart` storm), and resetting the token/coalescing state on each re-send
   * would abort in-flight keyframe work and restart the drag — the exact stutter
   * this guards against. The ONLY exit from scrub mode is the commit `seek()`
   * (which flips `scrubbing` false and clears the session cache) or `dispose()`;
   * a genuinely NEW drag is therefore always preceded by that exit, so its
   * `beginScrub` runs the full reset below. (D-scrub-ux)
   *
   * `dragId` is the client's id for this gesture (optional — the viewer's main
   * session generates it; a caller that omits it gets identical behaviour,
   * just no id on the logs). Stored for the whole drag, including its commit:
   * every `scrub-feeder:*` line printed until the next `beginScrub` carries it
   * (C1).
   */
  beginScrub(dragId?: string): void {
    if (this.disposed || this.scrubbing) return
    this.scrubDragId = dragId
    this.seekToken++
    this.advanceToken++
    this.scrubbing = true
    this.scrubToken++
    this.scrubPendingEpochMs = null
    this.scrubSegment = null
    // A fresh drag starts with full receiver credit: frames outstanding from a
    // PREVIOUS drag were rendered (or lost) long ago and must not throttle this
    // one — the viewer re-arms its render acks per drag.
    this.scrubCredit = SCRUB_CREDIT_CAP
    // Reached only on a FRESH drag (the `this.scrubbing` guard above no-ops a
    // re-entrant scrubStart). `scrubCache` is intentionally NOT cleared here —
    // and NOT by the commit `seek()` either: recorded footage is immutable and
    // the next drag routinely revisits the committed moment, so the fragments
    // the warm-up paid for are kept on purpose (see the commit teardown in
    // `seek`). Bumping scrubToken invalidates any in-flight IDLE warm read.
    this.scrubPrevTarget = null
    // A fresh drag counts fresh: the fragments the IDLE warm landed stay in the
    // cache (footage is immutable) but must not be credited to this drag.
    this.scrubPrefetched = new Set()
    this.scrubCursor = null
    this.scrubNoFootageLogged = false
    this.scrubParkLogged = false
    this.scrubDeadlineLogged = false
    this.scrubOversizeLogged = false
    this.scrubProfileLogged = false
    this.scrubPushedThisDrag = false
    this.scrubResolve = null
    this.scrubVelocity = null
    this.scrubLastSampleMs = null
    this.scrubVelRun = 0
    this.scrubOutstanding = []
    this.clearScrubAckTimeout()
    this.scrubAckTimeoutLogged = false
    this.scrubPendingHint = null
    // The drag's clock and its phase accumulator start together — every number
    // on `scrub-feeder:drag-end` is relative to this instant.
    this.scrubStartedAtMs = performance.now()
    this.scrubStats = new ScrubDragStats(this.scrubStartedAtMs)
    // AFTER the accumulator exists: a degradation reported into a null
    // accumulator is a line with no census beside it, which is half a report.
    this.reportProfileDegradation()
    this.scrubDemuxMark = this.deps.demuxTally?.counts() ?? null
    this.scrubLastPushLogAtMs = 0
    this.scrubLastSlowLocateLogAtMs = 0
    if (this.scrubTimer) {
      clearTimeout(this.scrubTimer)
      this.scrubTimer = null
    }
    this.stopPositionReports()
    // The drag is about to happen somewhere near the playhead the finger went
    // down on. Warm that window in the background — fire-and-forget, so a cold
    // cache costs the first tick nothing but its own read.
    this.scrubWarmStarted = false
    this.scrubReadMsWindow = []
    // ONLY for the profile whose read unit is a whole segment. A `high`
    // segment is ~5 MB, so warming this window there would be hundreds of MB
    // of reads for a drag that is pinned to `low` anyway — the exact "fuel on
    // the fire" this design exists to avoid. Caught by an existing test, not
    // by review.
    if (this.cursorMs > 0 && this.deps.profile === SCRUB_WHOLE_SEGMENT_PROFILE) {
      // The drag owns the window now — an idle fill in progress hands over
      // (same single walker, new centre) rather than dying.
      this.idleWarm = false
      this.startScrubWarm(this.cursorMs, this.scrubToken, { force: true })
    }
  }

  /**
   * Start (or recentre) the IDLE fill: called after every completed seek —
   * a timeline tap or a scrub commit — with the landed cursor. The operator is
   * now LOOKING at that frame; the next gesture almost always starts near it,
   * and this is the one moment the spindle is not serving the finger. Bounds:
   * the same session cache budget as the drag warm (48 MB LRU — no new store),
   * the same {@link SCRUB_WARM_MAX_SEGMENTS} per-window cap, plus the idle
   * pacing gap. `low`-only for the same reason the drag warm is: a `high`
   * window would be hundreds of MB of reads for a profile no drag reads.
   */
  private startIdleWarm(centreMs: number): void {
    if (this.disposed || this.scrubbing) return
    if (centreMs <= 0 || this.deps.profile !== SCRUB_WHOLE_SEGMENT_PROFILE) return
    this.idleWarm = true
    this.startScrubWarm(centreMs, this.scrubToken, { force: true })
  }

  /**
   * Whether the fill loop generation `dragGen` may keep working. During a drag
   * only that drag's generation runs (a commit bumps `scrubToken` and the old
   * walker exits); outside a drag the loop runs exactly while idle warm is on.
   */
  private warmLoopAlive(dragGen: number): boolean {
    if (this.disposed) return false
    if (this.scrubbing) return dragGen === this.scrubToken
    return this.idleWarm
  }

  /**
   * Warm the window the drag is about to move through: {@link SCRUB_WARM_BACK_MS}
   * back and {@link SCRUB_WARM_FWD_MS} forward from the entry playhead, one
   * segment at a time, backward first.
   *
   * Fire-and-forget, never on the tick's path — a tick that arrives against a
   * cold cache pays its own read exactly as before. A later jump more than
   * {@link SCRUB_RECENTER_MS} from this centre aborts the fill (via
   * {@link scrubWarmGen}, not the drag token) and starts a new window.
   *
   * It walks segment to segment through `locate` rather than assuming a segment
   * length, so a recorder configured with a different `segmentSeconds` warms the
   * same SPAN rather than the same count.
   */
  private startScrubWarm(
    centreMs: number,
    dragGen: number,
    opts?: { force?: boolean; backMs?: number; fwdMs?: number },
  ): void {
    if (this.scrubWarmStarted && !opts?.force) return
    this.scrubWarmStarted = true
    this.scrubWarmGen += 1
    this.scrubWarmCentreMs = centreMs
    this.scrubWarmBackMs = opts?.backMs ?? SCRUB_WARM_BACK_MS
    this.scrubWarmFwdMs = opts?.fwdMs ?? SCRUB_WARM_FWD_MS
    this.deps.onLog?.('scrub-feeder:warm-start', {
      dragId: this.scrubDragId,
      centreMs,
      fillGen: this.scrubWarmGen,
    })
    if (this.scrubFillLoopActive) return
    this.scrubFillLoopActive = true
    void this.runScrubFillLoop(dragGen)
  }

  /**
   * A single sequential walk. Recentre bumps {@link scrubWarmGen} and this loop
   * restarts around the new cursor — it must never `void` a second walker, or a
   * coarse fling stacks one USB walk per tick and play/scrub starve (1.2.113:
   * 16 walkers, seek `loadMs=16652`, drags with `ticks=0`).
   */
  private async runScrubFillLoop(dragGen: number): Promise<void> {
    let lastWorked = -1
    try {
      while (this.warmLoopAlive(dragGen)) {
        const gen = this.scrubWarmGen
        const centre = this.scrubWarmCentreMs
        if (centre === null) return
        const startedAt = performance.now()
        const fetched = await this.warmScrubWindow(
          centre,
          dragGen,
          gen,
          this.scrubWarmBackMs,
          this.scrubWarmFwdMs,
        )
        lastWorked = gen
        if (gen === this.scrubWarmGen) {
          // The window is as warm as it is going to get — say so (a fill that
          // ends silently reads exactly like a fill that never ran).
          this.deps.onLog?.('scrub-feeder:warm-done', {
            dragId: this.scrubDragId,
            fillGen: gen,
            idle: this.idleWarm && !this.scrubbing,
            fetched,
            ms: Math.round(performance.now() - startedAt),
          })
          // An IDLE window that completed is done for good: recorded footage
          // is immutable, so re-walking it buys nothing — the next seek or
          // drag recentres and re-arms.
          if (!this.scrubbing) this.idleWarm = false
          return
        }
      }
    } finally {
      this.scrubFillLoopActive = false
      // Respawn against the CURRENT generation, not the captured one: a drag
      // that began (or a seek that recentred) while this walker was draining
      // must get its walker back — the captured `dragGen` comparison used to
      // silently strand exactly that case.
      if (
        !this.disposed &&
        (this.scrubbing || this.idleWarm) &&
        this.scrubWarmCentreMs !== null &&
        this.scrubWarmGen !== lastWorked
      ) {
        this.scrubFillLoopActive = true
        void this.runScrubFillLoop(this.scrubToken)
      }
    }
  }

  /**
   * Abort the current fill and start a new ±15 min window around `centreMs`.
   * Does not bump `scrubToken` — the in-flight tick must still land.
   */
  private recenterScrubWarm(centreMs: number): void {
    if (this.deps.profile !== SCRUB_WHOLE_SEGMENT_PROFILE) return
    this.startScrubWarm(centreMs, this.scrubToken, {
      force: true,
      backMs: SCRUB_WARM_AROUND_MS,
      fwdMs: SCRUB_WARM_AROUND_MS,
    })
  }

  private maybeRecenterScrubWarm(targetMs: number): void {
    if (this.deps.profile !== SCRUB_WHOLE_SEGMENT_PROFILE) return
    const centre = this.scrubWarmCentreMs
    if (centre === null) return
    if (Math.abs(targetMs - centre) <= SCRUB_RECENTER_MS) return
    this.recenterScrubWarm(targetMs)
  }

  /**
   * Is the operator's finger actually moving right now?
   *
   * `scrubbing` alone is not the question — a drag stays open while the finger
   * rests, and those pauses are exactly when the warm should work. The signal
   * is the pointer sample clock, which `noteScrubSample` stamps on every
   * `scrubTo` before any velocity gating, so it is true even for a drag too
   * slow or too jittery for the velocity estimator.
   */
  private fingerIsMoving(): boolean {
    if (!this.scrubbing) return false
    return performance.now() - this.scrubLastSampleAtMs < SCRUB_WARM_QUIET_MS
  }

  private async warmScrubWindow(
    centreMs: number,
    dragGen: number,
    fillGen: number,
    backMs: number,
    fwdMs: number,
  ): Promise<number> {
    // Backward FIRST and with the larger span: a drag that starts at the live
    // edge, or on a notification's moment, is looking for what already happened.
    const spent = await this.warmScrubDirection(centreMs, -1, backMs, 0, dragGen, fillGen)
    return this.warmScrubDirection(centreMs, 1, fwdMs, spent, dragGen, fillGen)
  }

  /**
   * Walk `dir` from `fromMs` until `spanMs` of timeline is warm (or the shared
   * bound is hit), reading each segment that is not already cached. Returns the
   * running total of segments read, so the two directions share one budget.
   */
  private async warmScrubDirection(
    fromMs: number,
    dir: 1 | -1,
    spanMs: number,
    spent: number,
    dragGen: number,
    fillGen: number,
  ): Promise<number> {
    let read = spent
    let probeMs = fromMs
    for (let i = 0; i < SCRUB_WARM_MAX_SEGMENTS; i++) {
      if (!this.warmLoopAlive(dragGen)) return read
      if (fillGen !== this.scrubWarmGen) return read
      if (read >= SCRUB_WARM_MAX_SEGMENTS) return read
      if (Math.abs(probeMs - fromMs) > spanMs) return read
      const seg = await this.warmOneScrubSegment(probeMs, dragGen, fillGen)
      if (seg === null) return read
      if (seg.fetched) read += 1
      probeMs = dir === -1 ? seg.startMs - 1 : seg.startMs + seg.durMs + 1
      if (probeMs < 0) return read
    }
    return read
  }

  /**
   * One warm step: locate the segment covering `probeMs` and, unless it is
   * already cached, read and demux it into the cache. Returns the segment's span
   * so the walk can step to its neighbour, or null when the walk must stop (a
   * gap, a failure, or teardown).
   */
  private async warmOneScrubSegment(
    probeMs: number,
    dragGen: number,
    fillGen: number,
  ): Promise<{ startMs: number; durMs: number; fetched: boolean } | null> {
    try {
      const warm = this.scrubCache.covering(this.deps.profile, probeMs)
      if (warm) return { startMs: warm.startMs, durMs: warm.durMs, fetched: false }
      // A MOVING FINGER OWNS THE DISK.
      //
      // `waitForTickReadIdle` below only avoids OVERLAPPING a tick read already
      // in flight. It cannot stop the warm from slipping a ~230 KB random read
      // into the gap between two ticks — where the next tick then queues behind
      // it on the arm, which is the thing the operator feels.
      //
      // Measured the day the directional prefetch was deleted (2026-08-26): the
      // warm silently took its place as the speculative load. Two drags on
      // camera 104, on the new code, spent 1.9 MB and 2.4 MB of warm reads
      // against 3.1 MB and 2.9 MB of tick reads — 38-45% of the gesture's I/O,
      // for ZERO cache hits, at tickMsP50 120-129 ms. The one drag in that
      // session that warmed nothing ran at tickMsP50 11 ms.
      //
      // So the warm waits out the movement. It is not being disabled: the
      // moment the finger holds still for SCRUB_WARM_QUIET_MS the walk resumes
      // exactly where it stopped, which is the regime it was written for and
      // the only one where its reads are free.
      while (this.fingerIsMoving()) {
        if (!this.warmLoopAlive(dragGen) || fillGen !== this.scrubWarmGen) return null
        await new Promise<void>((r) => setTimeout(r, SCRUB_WARM_QUIET_MS))
      }
      // IDLE mode is a background guest on a saturated spindle: pace between
      // reads, and never read while a seek is resolving — the operator is
      // waiting on that one.
      if (this.idleWarm && !this.scrubbing) {
        await new Promise<void>((r) =>
          setTimeout(r, this.deps.idleWarmGapMs ?? IDLE_WARM_READ_GAP_MS),
        )
        while (this.inFlightSeekEpochMs !== null) {
          if (!this.warmLoopAlive(dragGen) || fillGen !== this.scrubWarmGen) return null
          await new Promise<void>((r) => setTimeout(r, 20))
        }
        if (!this.warmLoopAlive(dragGen) || fillGen !== this.scrubWarmGen) return null
      }
      if (!(await this.waitForTickReadIdle(fillGen))) return null
      const loc = await this.withTimeout(
        this.deps.locate({
          deviceId: this.deps.deviceId,
          profile: this.deps.profile,
          epochMs: probeMs,
        }),
      )
      if (!this.warmLoopAlive(dragGen)) return null
      if (fillGen !== this.scrubWarmGen) return null
      if (loc.kind !== 'segment') return null
      if (!(await this.waitForTickReadIdle(fillGen))) return null
      const load = await this.loadScrubFragment(loc, probeMs)
      if (load !== null && this.scrubbing) this.scrubStats?.recordWarmRead(load.readBytes)
      if (!this.warmLoopAlive(dragGen) || load === null) {
        return null
      }
      if (fillGen !== this.scrubWarmGen) return null
      this.scrubCache.put(this.deps.profile, load.seg)
      this.scrubPrefetched.add(load.seg.startMs)
      return { startMs: load.seg.startMs, durMs: load.seg.durMs, fetched: true }
    } catch {
      // Best-effort by construction: a failed warm just means the tick that
      // lands there pays its own read.
      return null
    }
  }

  /** Yield the spindle to an in-flight finger tick. Returns false if this fill died. */
  private async waitForTickReadIdle(fillGen: number): Promise<boolean> {
    while (this.scrubTickReadInFlight) {
      await new Promise<void>((r) => setTimeout(r, 4))
      if (this.disposed || fillGen !== this.scrubWarmGen) return false
      if (!this.scrubbing && !this.idleWarm) return false
    }
    return true
  }

  /**
   * EXPERIMENTAL feeder-scrub: register a drag target. Records the newest target
   * and, if no tick cycle is live, starts a leading-edge tick. A burst of moves
   * within the coalescing window collapses onto `scrubPendingEpochMs` (latest-
   * wins) so only one keyframe is demuxed+pushed per `SCRUB_COALESCE_MS`. A
   * `scrubTo` without a prior `beginScrub` (or after commit/dispose) is a no-op.
   */
  scrubTo(epochMs: number, hint?: ScrubMapHint): void {
    if (this.disposed || !this.scrubbing) return
    this.noteScrubSample(epochMs)
    this.scrubPendingEpochMs = epochMs
    // The hint rides the target through coalescing: when several pointer
    // samples collapse into one tick, the mapping mode attributed to that tick
    // is the one that produced the target it actually served.
    this.scrubPendingHint = hint ?? null
    // Leading-edge: fire the first tick on a 0 ms timer (not synchronously) so
    // `scrubTimer` is immediately non-null — concurrent moves during the tick's
    // async load then coalesce onto the pending slot instead of each starting a
    // parallel demux. The tick itself re-arms (or clears) the timer.
    if (this.scrubTimer === null) {
      this.scrubTimer = setTimeout(() => void this.scrubTick(), 0)
    }
  }

  /**
   * Receiver credit: the viewer received a pushed scrub frame. Settles the push
   * `seq` names — and every older one still outstanding, since the channel is
   * ordered — restores their credit (capped: over-acking never banks a burst)
   * and, when a target sat parked on an exhausted budget, resumes the tick.
   * This — not any timer — is what paces scrub pushes to what the link
   * actually delivers; {@link SCRUB_ACK_TIMEOUT_MS} is only the bound for when
   * an ack never comes.
   *
   * THE UNIT IS THE PUSH. A sweep puts ~25 AUs on the wire under ONE position
   * message, so a viewer without `requestVideoFrameCallback` can only ever send
   * ONE ack for it; the old per-FRAME settle waited for 25 and the drag parked
   * forever the moment the operator slowed down. A viewer WITH rvfc sends one
   * ack per rendered frame instead — those surplus acks all name the same
   * settled `seq` and are no-ops, which is what `seq` is for.
   *
   * A `seq` no outstanding push matches (a late ack from a drag that already
   * ended) banks nothing. An ack without `seq` comes from a viewer older than
   * the field: it settles the oldest outstanding push, which can only repay too
   * early — never strand the drag.
   */
  scrubAck(seq?: number): void {
    if (this.disposed) return
    const settled =
      seq === undefined
        ? this.scrubOutstanding.length > 0
          ? 1
          : 0
        : this.scrubOutstanding.filter((p) => p.seq <= seq).length
    if (settled === 0) return
    // PHASE 6 — the push→render round trip, measured per settled push. With
    // SCRUB_CREDIT_CAP = 2 the achievable push rate is 2 / RTT, so this number
    // is the ceiling the whole scrub runs under, and it was invisible: the
    // viewer acked, the feeder banked a credit, and nothing recorded the trip.
    const now = performance.now()
    for (const push of this.scrubOutstanding.slice(0, settled)) {
      this.scrubStats?.recordAckRtt(Math.round(now - push.pushedAtMs))
    }
    this.scrubOutstanding = this.scrubOutstanding.slice(settled)
    this.scrubCredit = Math.min(SCRUB_CREDIT_CAP, this.scrubCredit + settled)
    this.resumeScrubTick()
  }

  /**
   * Resume a parked drag: the newest target is still pending and the coalescing
   * slot is free, so run a leading-edge tick. Never touches a LIVE slot — a
   * pending re-arm is this tick cycle's own coalescing window and pre-empting it
   * would push faster than {@link SCRUB_COALESCE_MS}.
   */
  private resumeScrubTick(): void {
    if (this.scrubbing && this.scrubPendingEpochMs !== null && this.scrubTimer === null) {
      this.scrubTimer = setTimeout(() => void this.scrubTick(), 0)
    }
  }

  /**
   * Arm the write-off timer for the OLDEST outstanding push, if one is not
   * already pending. Newer entries are always due later, so a timer armed for
   * an entry that gets settled first simply fires early and re-arms — one
   * harmless wakeup, no bookkeeping.
   */
  private armScrubAckTimeout(): void {
    if (this.scrubAckTimer !== null) return
    const head = this.scrubOutstanding[0]
    if (head === undefined) return
    const dueInMs = Math.max(0, SCRUB_ACK_TIMEOUT_MS - (performance.now() - head.pushedAtMs))
    this.scrubAckTimer = setTimeout(() => {
      this.scrubAckTimer = null
      this.expireScrubAcks()
    }, dueInMs)
  }

  /** Drop the ack timer (drag exit / teardown). */
  private clearScrubAckTimeout(): void {
    if (this.scrubAckTimer === null) return
    clearTimeout(this.scrubAckTimer)
    this.scrubAckTimer = null
  }

  /**
   * Write off every push that has waited longer than
   * {@link SCRUB_ACK_TIMEOUT_MS}, give its credit back, and resume the drag.
   *
   * This is DROPPED WORK — a frame the viewer may never have painted — so it is
   * counted on the census every time and logged once per drag. Without it a
   * single lost ack ends the gesture: the gate is released by acks alone, and
   * `beginScrub` (its only other reset) is a no-op mid-drag.
   */
  private expireScrubAcks(): void {
    if (this.disposed || !this.scrubbing) return
    const now = performance.now()
    // Oldest first ⇒ the expired set is a prefix.
    const expired = this.scrubOutstanding.filter(
      (p) => now - p.pushedAtMs >= SCRUB_ACK_TIMEOUT_MS,
    ).length
    if (expired > 0) {
      const frames = this.scrubOutstanding.slice(0, expired).reduce((sum, p) => sum + p.frames, 0)
      this.scrubOutstanding = this.scrubOutstanding.slice(expired)
      this.scrubCredit = Math.min(SCRUB_CREDIT_CAP, this.scrubCredit + expired)
      this.scrubStats?.recordAckTimeout(expired)
      if (!this.scrubAckTimeoutLogged) {
        this.scrubAckTimeoutLogged = true
        this.deps.onLog?.('scrub-feeder:ack-timeout', {
          dragId: this.scrubDragId,
          pushes: expired,
          frames,
          timeoutMs: SCRUB_ACK_TIMEOUT_MS,
          pendingEpochMs: this.scrubPendingEpochMs,
        })
      }
      this.resumeScrubTick()
    }
    this.armScrubAckTimeout()
  }

  /**
   * One coalesced feeder-scrub push. Captures the newest pending target + the
   * current mode generation, resolves the covering fragment (reusing the memo'd
   * one when the target stays inside it), picks the nearest keyframe ≤ the
   * target, stamps a discontinuity, and pushes that single access unit. Re-arms
   * itself after `SCRUB_COALESCE_MS` while more moves are pending; otherwise
   * ends the cycle. Video only — no audio during scrub. A gap target holds the
   * last pushed frame (no push, no error).
   */
  private async scrubTick(): Promise<void> {
    const gen = this.scrubToken
    if (this.disposed || !this.scrubbing || gen !== this.scrubToken) {
      this.scrubTimer = null
      return
    }
    // RECEIVER-CREDIT GATE, before the target is consumed: with zero credit the
    // newest target stays PARKED on `scrubPendingEpochMs` — `scrubAck` (a
    // rendered frame at the viewer) is the only thing that resumes the tick.
    if (this.scrubCredit <= 0) {
      this.scrubTimer = null
      // Parked work is DROPPED-for-now work — it is COUNTED every time (the
      // aggregate's `parks`) and logged ONCE per drag. Once, because at zero
      // credit every further pointer move parks: the unthrottled line was a
      // line per pointer sample, which is the flood this instrument exists to
      // avoid. A park with no ack ever following is the mute-receiver
      // signature, and one line plus the count says it.
      this.scrubStats?.recordPark()
      if (!this.scrubParkLogged) {
        this.scrubParkLogged = true
        this.deps.onLog?.('scrub-feeder:parked', {
          dragId: this.scrubDragId,
          pendingEpochMs: this.scrubPendingEpochMs,
          outstanding: this.scrubOutstanding.length,
        })
      }
      return
    }
    const target = this.scrubPendingEpochMs
    let hint = this.scrubPendingHint
    this.scrubPendingEpochMs = null
    this.scrubPendingHint = null
    if (target === null) {
      this.scrubTimer = null
      return
    }
    const tickStartMs = performance.now()
    // Per-phase accounting for this tick — folded into the drag aggregate at
    // the push, and carried on the sampled per-tick line.
    let coverage: ScrubCoverage = 'miss'
    let locateCalls = 0
    let locateMs: number | null = null
    let readMs: number | null = null
    let readBytes: number | null = null
    let demuxMs: number | null = null
    let wholeSegmentRead = false
    try {
      // Fragment resolution, cheapest tier first — and BEFORE any RPC:
      // (1) the fragment already under the drag (memo), (2) the session cache
      // by COVERAGE. Recorded footage is immutable, so coverage is proof of
      // footage: a warm tick skips `locate` (a cap RPC measured at 1–8 s on
      // the saturated hub) and the read entirely. Only a miss pays the chain —
      // locate (with gap snapping), then the GOP byte-range read (or the
      // whole-segment read where the provider predates `readGop`), then the
      // demux. Video-only either way.
      let effTarget = target
      let seg: StepSegment | null = null
      if (this.scrubSegment !== null && fragmentCovers(this.scrubSegment, target)) {
        seg = this.scrubSegment
        coverage = 'memo'
      } else {
        seg = this.scrubCache.covering(this.deps.profile, target)
        if (seg) {
          coverage = 'cache'
          // A hit on a fragment SPECULATION landed is the only evidence that
          // the reads it spent were worth issuing.
          if (this.scrubPrefetched.has(seg.startMs)) this.scrubStats?.recordWarmHit()
        }
      }
      if (!seg) {
        // THE MISS PATH — the only one that costs I/O, and therefore the only
        // one with a deadline. Three rules, in this order:
        //
        //  (1) SINGLE FLIGHT. If a read is already on the wire for a target
        //      within one segment of this one, ride it. A drag that drops
        //      frames must not multiply reads, or the deadline makes the disk
        //      worse instead of the picture fresher.
        //  (2) DEADLINE. The whole chain (locate + snap + read + demux) races
        //      the frame's budget. On expiry the FRAME is abandoned — the read
        //      is not: it finishes into the session cache, so the work becomes
        //      the next tick's hit instead of nothing.
        //  (3) RETARGET. When the resolution lands, the finger has moved. If
        //      the fragment also covers the newest target, paint THAT — the
        //      stale instant is never pushed.
        const cfg = this.deps.scrubDeadline
        const rideWindowMs = cfg?.rideWindowMs ?? SCRUB_RIDE_WINDOW_MS
        const inFlight = this.scrubResolve
        let entry: ScrubResolveInFlight
        if (
          inFlight !== null &&
          (Math.abs(target - inFlight.target) <= rideWindowMs ||
            this.scrubResolvesInFlight >= SCRUB_RESOLVE_MAX_INFLIGHT)
        ) {
          entry = inFlight
          this.scrubStats?.recordResolveJoin()
        } else {
          // AIM WHERE THE FINGER WILL BE when these bytes land, not where it
          // was when they were asked for. Zero unless the drag has earned it.
          const leadMs = this.scrubLeadMs()
          if (leadMs !== 0) this.scrubStats?.recordLead(leadMs)
          const readTarget = target + leadMs
          entry = { target: readTarget, promise: this.startScrubResolve(readTarget, gen) }
          this.scrubResolve = entry
        }
        const deadlineMs = this.scrubPushedThisDrag
          ? (cfg?.tickMs ?? SCRUB_TICK_DEADLINE_MS)
          : (cfg?.firstTickMs ?? SCRUB_FIRST_TICK_DEADLINE_MS)
        const res = await this.raceDeadline(entry.promise, performance.now() + deadlineMs)
        if (this.disposed || !this.scrubbing || gen !== this.scrubToken) return
        if (res === 'deadline') {
          // DROPPED WORK — counted every time, logged once per drag. The
          // target goes back on the pending slot so the `finally` re-arms and
          // the drag continues; the read it abandoned keeps running into the
          // cache behind it.
          this.scrubStats?.recordDeadlineMiss()
          if (this.scrubPendingEpochMs === null) this.scrubPendingEpochMs = target
          if (!this.scrubDeadlineLogged) {
            this.scrubDeadlineLogged = true
            this.deps.onLog?.('scrub-feeder:deadline-miss', {
              dragId: this.scrubDragId,
              epochMs: target,
              deadlineMs,
              first: !this.scrubPushedThisDrag,
              inFlight: this.scrubResolvesInFlight,
            })
          }
          return
        }
        if (res === null) return
        seg = res.seg
        // WHICH INSTANT THIS FRAGMENT IS SERVED AT — rule (3), RETARGET.
        //
        // The read was issued for one instant; by the time it landed the finger
        // is somewhere else, and the fragment in hand may sit BEHIND the finger
        // (a slow read) or AHEAD of it (a lead that ran long). The frame to
        // paint is always the one closest to WHERE THE FINGER IS NOW:
        // `pickScrubIndex` and `clampIntoSegment` reduce an out-of-range
        // instant to the nearest frame the fragment actually holds, so aiming
        // at the finger can never paint something we do not have.
        //
        // A gap SNAP overrides all of it: the snapped instant is the only
        // footage that exists.
        const newest = this.scrubPendingEpochMs
        if (res.effTarget !== res.requested) {
          effTarget = res.effTarget
        } else if (newest !== null && fragmentCovers(seg, newest)) {
          // A TRUE retarget — the finger's current instant is inside these
          // bytes, so it is served exactly and its pending slot is consumed.
          effTarget = newest
          hint = this.scrubPendingHint
          this.scrubPendingEpochMs = null
          this.scrubPendingHint = null
        } else {
          // Covered neither: aim at the finger anyway and let the clamp pick
          // the nearest frame we have. The pending slot is LEFT ALONE — the
          // instant the finger is on still deserves its own read.
          effTarget = newest ?? target
        }
        if (effTarget !== res.effTarget) this.scrubStats?.recordRetarget()
        locateCalls = res.locateCalls
        locateMs = res.locateMs
        readMs = res.readMs
        readBytes = res.readBytes
        demuxMs = res.demuxMs
        wholeSegmentRead = res.wholeSegmentRead
      }
      this.scrubSegment = seg

      // JUMP or SWEEP, in EITHER direction. A steady forward drag is playback
      // with a moving target: the predicted frames between the last pushed AU
      // and the target decode in sequence (their keyframe is already decoded)
      // and cost a fraction of an IDR — that is the continuous flow. A steady
      // BACKWARD drag steps too, but the cost is permanently asymmetric: with
      // the camera GOP fixed at ~4 s there is never a closer keyframe behind,
      // so every backward step re-pays the covering IDR plus the P-prefix up to
      // the target (41–173 KB measured on `low`) where a forward step pays only
      // the new P-frames (0.6–35 KB). This P-frame walk is LOAD-BEARING — it is
      // the only mechanism that can land between keyframes at all. Beyond the
      // window (a fling, either direction) the step degrades — documented, not
      // silent — to a JUMP: one independently-decodable keyframe, i.e. keyframe
      // granularity; and because a thin pipe slows the ack-gated ticks, per-tick
      // deltas GROW under congestion, so the same degradation is emergent
      // exactly when the link cannot afford GOP walks.
      const prevTarget = this.scrubPrevTarget
      const cursor = this.scrubCursor
      const targetIdx = this.pickScrubIndex(seg, effTarget, false)
      const delta = prevTarget === null ? null : effTarget - prevTarget
      const withinFwd = delta !== null && delta > 0 && delta <= SCRUB_SWEEP_WINDOW_MS
      const withinBack = delta !== null && delta < 0 && -delta <= SCRUB_SWEEP_WINDOW_MS
      const sameFragment = cursor !== null && cursor.fragStartMs === seg.startMs
      // Forward adjacency with tolerance — GOP starts derive from tick→ms
      // rounding (±1 ms) and segments have 11–17 ms cracks between them; both
      // are continuity, not cuts. See SCRUB_ADJACENT_TOLERANCE_MS.
      const edgeGapMs =
        cursor === null ? null : seg.startMs - (cursor.fragStartMs + cursor.fragDurMs)
      const adjacentForward =
        edgeGapMs !== null && edgeGapMs >= 0 && edgeGapMs <= SCRUB_ADJACENT_TOLERANCE_MS
      let aus: AccessUnit[]
      let firstIdx: number
      let mode: 'jump' | 'sweep'
      let jumpTravel: TravelStill[] = []
      const dir: 'fwd' | 'back' = delta !== null && delta < 0 ? 'back' : 'fwd'
      // A sweep that crosses a fragment edge must nudge the output clock: the
      // new fragment's PTS restarts at 0, which is a REWIND the clock clamps.
      let crossesFragment = false
      // A backward step re-feeds source PTS the clock already emitted — a full
      // rewind, stamped like a seek so the run cannot clamp into one instant.
      let rewind = false
      if (withinFwd && sameFragment && cursor !== null && targetIdx > cursor.idx) {
        mode = 'sweep'
        firstIdx = cursor.idx + 1
        aus = seg.aus.slice(firstIdx, targetIdx + 1)
      } else if (withinFwd && adjacentForward) {
        // Crossing into the next fragment forward: its AU list STARTS with an
        // IDR (`+frag_keyframe`), so the flow continues from there — the frames
        // are contiguous. Their TIMESTAMPS are not: `ptsMs` is fragment-relative
        // (each recorded fragment carries its own `moov` and restarts at 0 —
        // measured 0 → 11943 ms on four consecutive real fragments), so the edge
        // hands the clock a fragment-length rewind.
        mode = 'sweep'
        firstIdx = 0
        aus = seg.aus.slice(0, targetIdx + 1)
        crossesFragment = true
      } else if (withinBack && sameFragment && cursor !== null && targetIdx === cursor.idx) {
        // Backward micro-move inside the frame already showing: nothing new to
        // render — report the position, push nothing, charge nothing.
        mode = 'sweep'
        firstIdx = targetIdx
        aus = []
      } else if (withinBack) {
        // The backward STEP: covering IDR + P-prefix, stopping at the exact
        // frame at-or-before the target. Works within one fragment AND across a
        // backward fragment edge (seg is the fragment covering the target).
        mode = 'sweep'
        firstIdx = this.pickScrubIndex(seg, effTarget, true)
        aus = seg.aus.slice(firstIdx, targetIdx + 1)
        rewind = true
      } else {
        mode = 'jump'
        firstIdx = this.pickScrubIndex(seg, effTarget, true)
        const kf = seg.aus[firstIdx]
        aus = kf === undefined ? [] : [kf]
        // A jump should not teleport either: whatever keyframes of the crossed
        // interval are already WARM ride along as travel stills — cache-only,
        // zero extra I/O (see collectWarmTravelStills).
        if (prevTarget !== null && kf !== undefined) {
          jumpTravel = this.collectWarmTravelStills(prevTarget, effTarget, seg.startMs, firstIdx)
        }
      }
      const lastAu = aus[aus.length - 1]
      if (lastAu === undefined) {
        // A sweep with no new AU under the target (micro-move inside one
        // frame): nothing to push, nothing to charge.
        this.deps.onPosition(this.clampIntoSegment(seg, effTarget))
        this.scrubPrevTarget = effTarget
        return
      }
      // A JUMP is a non-contiguous cut: stamp the same large discontinuity a
      // seek uses so the output 90 kHz clock stays strictly monotonic across
      // arbitrary back-and-forth drags (the scrub-smear root cause). A BACKWARD
      // step is a rewind — its run re-feeds source PTS already emitted — so it
      // takes the same stamp, once per step, and the run then advances
      // strictly from the new anchor. A forward sweep inside one fragment is
      // contiguous by construction and must NOT be stamped, or the flow
      // stutters at every push. A sweep ACROSS a fragment edge is contiguous in
      // frames but not in PTS, so it takes the same ~1-frame continuation nudge
      // forward playback uses at a segment boundary — without it the clamp in
      // MonotonicClock.stamp pins every AU of the new fragment to one instant
      // and the receiver sees time stop.
      // Travel stills first, in drag order — each an independent cut with its
      // own stamp; the jump's own discontinuity then separates the target.
      for (const s of jumpTravel) {
        if (this.clockHasAdvanced) this.clock.markDiscontinuity(SEEK_DISCONTINUITY_MS)
        this.deps.sink.pushAccessUnit(s.au.data, this.clock.stamp(s.au.ptsMs), s.au.codec)
        this.clockHasAdvanced = true
        this.deps.onPosition(this.clampIntoSegment(s.seg, s.tMs))
      }
      if ((mode === 'jump' || rewind) && this.clockHasAdvanced) {
        this.clock.markDiscontinuity(SEEK_DISCONTINUITY_MS)
      } else if (crossesFragment && this.clockHasAdvanced) {
        this.clock.markSeek()
      }
      for (const au of aus) {
        this.deps.sink.pushAccessUnit(au.data, this.clock.stamp(au.ptsMs), au.codec)
      }
      // ONE push, ONE credit, settled by the FIRST ack that names it. `frames`
      // is what went on the wire (a sweep is ~25 AUs, a jump is 1) and is
      // carried for the logs and the write-off line — never as the repayment
      // unit: the viewer sends one position per PUSH, so charging per push and
      // repaying per frame parked the drag permanently the moment sweeps
      // started (`mode=sweep aus=26 creditLeft=1`, then nothing, ever).
      const pushedAtMs = performance.now()
      const pushSeq = ++this.scrubPushSeq
      this.scrubOutstanding = [
        ...this.scrubOutstanding,
        {
          seq: pushSeq,
          frames: jumpTravel.length + aus.length,
          pushedAtMs,
        },
      ]
      this.scrubCredit -= 1
      this.scrubPushedThisDrag = true
      this.armScrubAckTimeout()
      this.clockHasAdvanced = true
      let runBytes = 0
      for (const s of jumpTravel) runBytes += s.au.data.length
      for (const au of aus) runBytes += au.data.length
      this.scrubCursor = {
        fragStartMs: seg.startMs,
        fragDurMs: seg.durMs,
        idx: firstIdx + aus.length - 1,
      }
      // EVERY tick folds into the drag aggregate; only a SAMPLE of them gets a
      // line. The aggregate is what tuning reads (counts, sums, percentiles per
      // phase); the sampled line is what localises one bad tick inside it.
      this.scrubStats?.recordTick(
        {
          mode,
          dir,
          mapMode: hint?.mode ?? null,
          velocityPxPerS: hint?.velocityPxPerS ?? null,
          coverage,
          locateCalls,
          locateMs: locateMs === null ? null : Math.round(locateMs),
          readMs: readMs === null ? null : Math.round(readMs),
          readBytes,
          wholeSegmentRead,
          demuxMs: demuxMs === null ? null : Math.round(demuxMs),
          aus: aus.length,
          travel: jumpTravel.length,
          wireBytes: runBytes,
          creditLeft: this.scrubCredit,
          tickMs: Math.round(pushedAtMs - tickStartMs),
        },
        pushedAtMs,
      )
      // The push line proves the server SENT (the client's `scrub:pushed`only
      // ever proved it ASKED). It is now SAMPLED — the drag's first push, then
      // one per SCRUB_PUSH_LOG_SAMPLE_MS. Unsampled it is ~16 lines/s per
      // camera, and the counts it used to carry alone all live on the
      // aggregate now; what a sampled line adds is the per-phase breakdown of
      // one real tick.
      if (
        this.scrubLastPushLogAtMs === 0 ||
        pushedAtMs - this.scrubLastPushLogAtMs >= SCRUB_PUSH_LOG_SAMPLE_MS
      ) {
        this.scrubLastPushLogAtMs = pushedAtMs
        this.deps.onLog?.('scrub-feeder:pushed', {
          dragId: this.scrubDragId,
          epochMs: effTarget,
          mode,
          dir,
          map: hint?.mode ?? null,
          aus: aus.length,
          travel: jumpTravel.length,
          codec: lastAu.codec,
          bytes: runBytes,
          creditLeft: this.scrubCredit,
          coverage,
          locateMs: locateMs === null ? null : Math.round(locateMs),
          readMs: readMs === null ? null : Math.round(readMs),
          demuxMs: demuxMs === null ? null : Math.round(demuxMs),
          tickMs: Math.round(pushedAtMs - tickStartMs),
        })
      }
      // The position that CARRIES the push: its `seq` is what the viewer echoes
      // on `scrubAck`, and it is the only receiver-side delivery signal on a
      // platform with no `requestVideoFrameCallback`.
      this.deps.onPosition(this.clampIntoSegment(seg, effTarget), pushSeq)
      // Where the drag was, for the NEXT tick's delta — which decides sweep vs
      // jump, and nothing else. This assignment used to live inside the
      // directional prefetch, so deleting that method silently stopped the
      // whole SWEEP path: with `scrubPrevTarget` frozen, every delta was
      // measured from wherever the drag started and every step read as a fling.
      // Speculation had quietly become the owner of the drag's bookkeeping.
      this.scrubPrevTarget = effTarget
    } catch (err) {
      // Fire-and-forget for the OPERATOR (the last pushed keyframe holds
      // rather than surfacing an error state) — but never silent for the
      // logs: this swallow is exactly where a dark failure would hide.
      this.scrubStats?.recordFailure()
      this.deps.onLog?.('scrub-feeder:tick-failed', {
        dragId: this.scrubDragId,
        epochMs: target,
        error: err instanceof Error ? err.message : String(err),
      })
    } finally {
      // Re-arm only while newer moves have arrived AND this tick's generation
      // still owns the mode — a re-entrant `beginScrub` mid-await bumps the
      // token and takes ownership of `scrubTimer`; a superseded tick re-arming
      // here would create a SECOND live timer behind the single slot (two
      // concurrent demuxes — the exact bounded-concurrency invariant).
      if (gen !== this.scrubToken) {
        // A newer generation owns the timer slot — do not touch it.
      } else if (
        !this.disposed &&
        this.scrubbing &&
        this.scrubPendingEpochMs !== null &&
        this.scrubCredit > 0
      ) {
        // Re-arm only WITH credit: at zero, the pending target parks and only a
        // receiver ack resumes the tick — a timer never releases work.
        this.scrubTimer = setTimeout(() => void this.scrubTick(), SCRUB_COALESCE_MS)
      } else {
        this.scrubTimer = null
      }
    }
  }

  /**
   * ONE fragment resolution for the drag: locate (with gap snapping), read,
   * demux, cache. Deliberately NOT bound to the tick that started it.
   *
   * The tick races this with the frame's deadline and may walk away; this
   * promise then finishes on its own and puts the fragment in the session
   * cache, because the read is already on the wire and abandoning its RESULT
   * as well would turn a dropped frame into wasted disk. That is what makes
   * the deadline cheap: the tick after a miss is usually a cache hit.
   *
   * Null ⇒ nothing to serve (dead zone, superseded generation, or a load the
   * seek token invalidated). Throws propagate to the tick's `tick-failed`.
   */
  private async startScrubResolve(target: number, gen: number): Promise<ScrubResolution | null> {
    this.scrubResolvesInFlight += 1
    this.scrubTickReadInFlight = true
    let locateCalls = 0
    let locateMs: number | null = null
    try {
      this.maybeRecenterScrubWarm(target)
      // PHASE 2 — the `locate` RPC, measured at 1–8 s on a saturated hub.
      // D68 took it off the warm path; `coverMemo`/`coverCache`/`coverMiss`
      // plus `locateCalls` are what prove whether it actually left.
      const locateStartMs = performance.now()
      let loc = await this.withTimeout(
        this.deps.locate({
          deviceId: this.deps.deviceId,
          profile: this.deps.profile,
          epochMs: target,
        }),
      )
      locateCalls += 1
      locateMs = performance.now() - locateStartMs
      this.maybeLogSlowLocate(target, locateMs)
      if (this.disposed || gen !== this.scrubToken) return null
      let effTarget = target
      // A dead-stretch target SNAPS to the nearest footage (pull-ladder
      // parity: a drag into a gap paints the nearest moment that exists).
      // The old silent hold produced half a session of positions:0 drags that
      // were undiagnosable from the logs.
      if (loc.kind === 'gap') {
        const decision = resolveSnapTarget(loc, target)
        if (decision.kind !== 'snap') {
          // Both dead-zone outcomes hold the last pushed frame and cost NO
          // segment I/O — the property the unbounded snap destroyed, one drag
          // tick at a time. One line per drag: a dead-zone drag ticks fast.
          if (!this.scrubNoFootageLogged) {
            this.scrubNoFootageLogged = true
            if (decision.kind === 'too-far') {
              this.deps.onLog?.('scrub-feeder:snap-too-far', {
                dragId: this.scrubDragId,
                epochMs: target,
                nearestMs: decision.snapMs,
                distanceMs: decision.distanceMs,
              })
            } else {
              this.deps.onLog?.('scrub-feeder:no-footage', {
                dragId: this.scrubDragId,
                epochMs: target,
              })
            }
          }
          return null
        }
        const snapStartMs = performance.now()
        const snapped = await this.withTimeout(
          this.deps.locate({
            deviceId: this.deps.deviceId,
            profile: this.deps.profile,
            epochMs: decision.snapMs,
          }),
        )
        // A snap costs a SECOND locate — the aggregate counts calls, not
        // ticks, so a snapping drag shows its true RPC load.
        locateCalls += 1
        locateMs = (locateMs ?? 0) + (performance.now() - snapStartMs)
        if (this.disposed || gen !== this.scrubToken) return null
        if (snapped.kind !== 'segment') {
          if (!this.scrubNoFootageLogged) {
            this.scrubNoFootageLogged = true
            this.deps.onLog?.('scrub-feeder:no-footage', {
              dragId: this.scrubDragId,
              epochMs: target,
            })
          }
          return null
        }
        this.deps.onLog?.('scrub-feeder:snapped', {
          dragId: this.scrubDragId,
          requestedMs: target,
          snappedMs: decision.snapMs,
        })
        loc = snapped
        effTarget = decision.snapMs
      }
      // A snapped target — or one another resolution already landed — may hit
      // a fragment that IS already warm.
      const warm = this.scrubCache.covering(this.deps.profile, effTarget)
      if (warm) {
        return {
          seg: warm,
          requested: target,
          effTarget,
          locateCalls,
          locateMs,
          readMs: null,
          readBytes: null,
          demuxMs: null,
          wholeSegmentRead: false,
        }
      }
      // PHASES 3 + 4 — the GOP byte-range read and the demux. `readBytes`
      // is what makes D68's "41–173 KB instead of 100–600 KB" a
      // measurement rather than an assumption, and `wholeSegmentRead`
      // counts the documented degradation apart from the win.
      const load = await this.loadScrubFragment(loc, effTarget)
      if (this.disposed || load === null) return null
      // The PUT happens even when this generation is dead: the bytes are read,
      // the footage is immutable, and the next drag deserves the hit.
      this.scrubCache.put(this.deps.profile, load.seg)
      if (gen !== this.scrubToken) return null
      return {
        seg: load.seg,
        requested: target,
        effTarget,
        locateCalls,
        locateMs,
        readMs: load.readMs,
        readBytes: load.readBytes,
        demuxMs: load.demuxMs,
        wholeSegmentRead: load.wholeSegmentRead,
      }
    } finally {
      this.scrubResolvesInFlight -= 1
      if (this.scrubResolvesInFlight === 0) this.scrubTickReadInFlight = false
      if (this.scrubResolve?.target === target) this.scrubResolve = null
    }
  }

  /**
   * Index of the nearest AU at-or-before the drag target within `seg`
   * (default 0 — the fragment's params-fused IDR, which the demux contract
   * guarantees). `keyframesOnly` restricts the pick to sync frames — the JUMP
   * mode, whose pushed frame must be standalone-decodable; sweep mode picks
   * ANY frame, which is what makes the flow frame-granular.
   */
  private pickScrubIndex(seg: StepSegment, target: number, keyframesOnly: boolean): number {
    const first = seg.aus[0]
    if (!first) return 0
    const offsetMs = target - seg.startMs
    let idx = 0
    for (let i = 0; i < seg.aus.length; i++) {
      const au = seg.aus[i]
      if (!au) continue
      if (au.ptsMs - first.ptsMs > offsetMs) break
      if (!keyframesOnly || au.keyframe) idx = i
    }
    return idx
  }

  /**
   * Load the scrub unit covering `effTarget`.
   *
   * For the scrub profile that unit is the WHOLE SEGMENT — one sequential read
   * of ~230 KB that leaves ten seconds of demuxed access units behind, so every
   * later tick landing in it costs nothing at all. Everything else keeps the
   * GOP byte-range (D31): a `high` segment is ~5 MB and reading it to push one
   * keyframe would be this same trade made backwards.
   *
   * Null when superseded mid-flight. Video-only: scrub never plays audio.
   */
  private async loadScrubFragment(
    loc: LocatedSegment,
    effTarget: number,
  ): Promise<ScrubFragmentLoad | null> {
    const readGop = this.deps.readGop
    if (readGop && !this.readsWholeSegment(loc)) {
      const token = this.seekToken
      const readStartMs = performance.now()
      const gop = await this.withTimeout(
        readGop({
          deviceId: this.deps.deviceId,
          profile: this.deps.profile,
          segmentStartMs: loc.startMs,
          segmentDurMs: loc.durMs,
          epochMs: effTarget,
        }),
      )
      const readEndMs = performance.now()
      if (this.disposed || token !== this.seekToken) return null
      const demuxed = await this.withTimeout(this.deps.demux(gop.bytes))
      if (this.disposed || token !== this.seekToken) return null
      const aus = this.repairPts(demuxed, gop.gopStartMs, gop.gopDurMs)
      this.noteScrubReadMs(readEndMs - readStartMs)
      return {
        seg: { startMs: gop.gopStartMs, durMs: gop.gopDurMs, aus },
        readMs: readEndMs - readStartMs,
        readBytes: gop.bytes.length,
        demuxMs: performance.now() - readEndMs,
        wholeSegmentRead: false,
      }
    }
    // THE WHOLE SEGMENT. Primary path for the scrub profile, and still the
    // version-skew fallback for a recorder without `readGopBytes` — counted
    // apart either way (`wholeReads`) so the two can never be confused.
    const token = this.seekToken
    const readStartMs = performance.now()
    const bytes = await this.withTimeout(
      this.deps.readBytes({
        deviceId: this.deps.deviceId,
        profile: this.deps.profile,
        startMs: loc.startMs,
      }),
    )
    const readEndMs = performance.now()
    if (this.disposed || token !== this.seekToken) return null
    const demuxedWhole = await this.withTimeout(this.deps.demux(bytes))
    if (this.disposed || token !== this.seekToken) return null
    const aus = this.repairPts(demuxedWhole, loc.startMs, loc.durMs)
    this.noteScrubReadMs(readEndMs - readStartMs)
    return {
      seg: { startMs: loc.startMs, durMs: loc.durMs, aus },
      readMs: readEndMs - readStartMs,
      readBytes: bytes.length,
      demuxMs: performance.now() - readEndMs,
      wholeSegmentRead: true,
      rawBytes: bytes,
    }
  }

  /**
   * Whether this located segment is read WHOLE. The scrub profile is, up to a
   * safety ceiling on the byte size — see {@link SCRUB_WHOLE_SEGMENT_PROFILE}.
   * A `locate` that does not report a size is trusted for the scrub profile,
   * where the shape is known and small.
   */
  private readsWholeSegment(loc: LocatedSegment): boolean {
    if (this.deps.profile !== SCRUB_WHOLE_SEGMENT_PROFILE) return false
    if (loc.bytes === undefined || loc.bytes <= SCRUB_WHOLE_SEGMENT_MAX_BYTES) return true
    // A `low` segment too big to read whole is the documented degradation of
    // {@link SCRUB_WHOLE_SEGMENT_MAX_BYTES} — it is exactly the failure that a
    // segment-duration change makes silent otherwise. It no longer drops all
    // the way to one seek per frame: `readGop` now reads as many CONSECUTIVE
    // fragments as fit the SAME budget (`fragmentsWithinBudget` on the
    // recorder), so a segment that overshoots this pre-check by a little still
    // leaves most of itself behind for the next tick. This line is the census
    // signal either way — with the two numbers that say whether the ceiling or
    // the segment is wrong.
    this.scrubStats?.recordOversizeSegment()
    if (!this.scrubOversizeLogged) {
      this.scrubOversizeLogged = true
      this.deps.onLog?.('scrub-feeder:oversize-segment', {
        dragId: this.scrubDragId,
        profile: this.deps.profile,
        startMs: loc.startMs,
        durMs: loc.durMs,
        bytes: loc.bytes,
        maxBytes: SCRUB_WHOLE_SEGMENT_MAX_BYTES,
        bytesPerSecond: loc.durMs > 0 ? Math.round(loc.bytes / (loc.durMs / 1000)) : null,
      })
    }
    return false
  }

  /**
   * Fold one read into the recent-read window that governs speculation. The
   * window is short on purpose: suppression must track what the disk is doing
   * NOW, and lift as soon as it recovers.
   */
  private noteScrubReadMs(readMs: number): void {
    this.scrubReadMsWindow = [...this.scrubReadMsWindow, readMs].slice(-SCRUB_READ_WINDOW)
  }

  /**
   * A drag that is NOT on the scrub profile runs with every scrub optimisation
   * off: the whole-segment read unit, the 48 MB fragment-cache budget and the
   * entry warm are all gated on the exact string `low`
   * ({@link SCRUB_WHOLE_SEGMENT_PROFILE}). A momentary hole in `low` therefore
   * turns a drag into 3-seek GOP reads over ~5 MB `high` segments — measured at
   * 2 642 ms cold — and the client cannot repair it.
   *
   * It used to be indistinguishable from a slow disk. Now it says so, once per
   * drag, and the census carries the flag beside the numbers it explains.
   */
  private reportProfileDegradation(): void {
    if (this.deps.profile === SCRUB_WHOLE_SEGMENT_PROFILE) return
    this.scrubStats?.recordProfileDegraded(this.deps.profile)
    if (this.scrubProfileLogged) return
    this.scrubProfileLogged = true
    this.deps.onLog?.('scrub-feeder:profile-degraded', {
      dragId: this.scrubDragId,
      profile: this.deps.profile,
      scrubProfile: SCRUB_WHOLE_SEGMENT_PROFILE,
    })
  }

  /**
   * Median of the recent reads — what a read costs on this disk RIGHT NOW.
   * Null until there are enough samples to call it anything: a single cold
   * first read is not a median, and acting on it would aim a whole gesture.
   */
  private scrubReadMedianMs(): number | null {
    if (this.scrubReadMsWindow.length < SCRUB_LEAD_MIN_READ_SAMPLES) return null
    const sorted = this.scrubReadMsWindow.toSorted((a, b) => a - b)
    return sorted[Math.floor(sorted.length / 2)] ?? null
  }

  /**
   * Fold one pointer sample into the drag's media velocity (ms of timeline per
   * ms of wall clock, signed). Cheap on purpose: this runs at pointer rate.
   */
  private noteScrubSample(epochMs: number): void {
    const now = performance.now()
    const prev = this.scrubLastSampleMs
    const prevAt = this.scrubLastSampleAtMs
    this.scrubLastSampleMs = epochMs
    this.scrubLastSampleAtMs = now
    if (prev === null) return
    const gapMs = now - prevAt
    if (gapMs < SCRUB_VELOCITY_MIN_GAP_MS || gapMs > SCRUB_VELOCITY_MAX_GAP_MS) return
    const deltaMs = epochMs - prev
    const dir = Math.sign(deltaMs)
    if (dir === 0) {
      this.scrubVelRun = 0
      return
    }
    this.scrubVelRun = Math.sign(this.scrubVelRun) === dir ? this.scrubVelRun + dir : dir
    const v = deltaMs / gapMs
    this.scrubVelocity =
      this.scrubVelocity === null
        ? v
        : this.scrubVelocity * (1 - SCRUB_VELOCITY_EMA) + v * SCRUB_VELOCITY_EMA
  }

  /**
   * How far AHEAD of the finger this read should aim — see the
   * {@link SCRUB_LEAD_MIN_READ_SAMPLES} docblock for why this exists and what
   * bounds it. Zero whenever the prediction is not earned: no measured reads,
   * no sustained direction, or a velocity whose sign disagrees with the run.
   */
  private scrubLeadMs(): number {
    const velocity = this.scrubVelocity
    if (velocity === null) return 0
    if (Math.abs(this.scrubVelRun) < SCRUB_LEAD_MIN_DIR_RUN) return 0
    if (Math.sign(velocity) !== Math.sign(this.scrubVelRun)) return 0
    const readMs = this.scrubReadMedianMs()
    if (readMs === null) return 0
    return scrubLeadDecision(velocity, readMs).leadMs
  }

  /**
   * A single slow `locate` gets its own line, throttled per drag. Reserved for
   * the pathological case on purpose: D68 moved this RPC off the warm path, so
   * a slow one still landing there is the finding — and if it is NOT rare, the
   * throttle turning the flood into one line is itself the finding (the
   * aggregate's `locateCalls` / `locateMsMax` carry the rest).
   */
  private maybeLogSlowLocate(epochMs: number, locateMs: number): void {
    const threshold = this.deps.slowLocateMs ?? SCRUB_SLOW_LOCATE_MS
    if (locateMs < threshold) return
    const now = performance.now()
    if (
      this.scrubLastSlowLocateLogAtMs !== 0 &&
      now - this.scrubLastSlowLocateLogAtMs < SCRUB_PATHOLOGY_LOG_INTERVAL_MS
    ) {
      return
    }
    this.scrubLastSlowLocateLogAtMs = now
    this.deps.onLog?.('scrub-feeder:slow-locate', {
      dragId: this.scrubDragId,
      epochMs,
      locateMs: Math.round(locateMs),
      thresholdMs: threshold,
    })
  }

  /**
   * The seek travel animation: push intermediate keyframes across
   * [fromMs → toMs], time-driven under a hard wall-clock budget, then return
   * so the caller LANDS on the exact target. Each iteration interpolates the
   * instant from BUDGET PROGRESS (never from a still index), so distance
   * cannot stretch the animation and slow fetches shrink it — a fetch races
   * the remaining budget and a loss ends the animation ('deadline'), it never
   * queues. Fetched fragments go into the session cache, so the crossed
   * interval comes out warm for the next drag. Aborts (without landing — the
   * caller owns that) the moment a newer seek bumps the token.
   */
  private async animateSeekTravel(
    fromMs: number,
    toMs: number,
    token: number,
    dragId?: string,
  ): Promise<void> {
    const cfg = this.deps.seekAnimation
    const budgetMs = cfg?.budgetMs ?? SEEK_ANIMATION_BUDGET_MS
    const tickMs = cfg?.tickMs ?? SEEK_ANIMATION_TICK_MS
    const maxStills = cfg?.maxStills ?? SEEK_ANIMATION_MAX_STILLS
    const minDistanceMs = cfg?.minDistanceMs ?? SEEK_ANIMATION_MIN_DISTANCE_MS
    if (Math.abs(toMs - fromMs) <= minDistanceMs) return
    const start = performance.now()
    const deadline = start + budgetMs
    let stills = 0
    let lastFragStartMs: number | null = null
    while (stills < maxStills) {
      const now = performance.now()
      if (now >= deadline) break
      const progress = Math.min(1, (now - start) / budgetMs)
      const tMs = Math.round(fromMs + (toMs - fromMs) * progress)
      const still = await this.fetchTravelStill(tMs, deadline)
      if (this.disposed || token !== this.seekToken) return
      if (still === 'deadline') break
      if (
        still !== null &&
        still.seg.startMs !== lastFragStartMs &&
        !fragmentCovers(still.seg, toMs) &&
        !fragmentCovers(still.seg, fromMs)
      ) {
        lastFragStartMs = still.seg.startMs
        // Every still is an independent cut — same stamp as a scrub jump, so
        // the receiver can never smear one still's deltas onto another's refs.
        if (this.clockHasAdvanced) this.clock.markDiscontinuity(SEEK_DISCONTINUITY_MS)
        this.deps.sink.pushAccessUnit(
          still.au.data,
          this.clock.stamp(still.au.ptsMs),
          still.au.codec,
        )
        this.clockHasAdvanced = true
        // The playhead travels WITH the stills — the label reads as motion.
        this.deps.onPosition(this.clampIntoSegment(still.seg, tMs))
        stills += 1
      }
      const sleepMs = Math.min(tickMs, deadline - performance.now())
      if (sleepMs > 0) await new Promise<void>((r) => setTimeout(r, sleepMs))
      if (this.disposed || token !== this.seekToken) return
    }
    if (stills > 0) {
      this.deps.onLog?.('recorded:seek-travel', {
        dragId,
        fromMs,
        toMs,
        stills,
        elapsedMs: Math.round(performance.now() - start),
      })
    }
  }

  /**
   * One travel still: the keyframe at-or-before `epochMs`, from the session
   * cache when warm, else fetched — racing the animation deadline so a slow
   * hub shortens the animation instead of stalling it.
   */
  private async fetchTravelStill(
    epochMs: number,
    deadlineWall: number,
  ): Promise<TravelStill | 'deadline' | null> {
    const cached = this.scrubCache.covering(this.deps.profile, epochMs)
    const seg = cached ?? (await this.raceDeadline(this.loadTravelFragment(epochMs), deadlineWall))
    if (seg === 'deadline') return 'deadline'
    if (seg === null) return null
    const kfIdx = this.pickScrubIndex(seg, epochMs, true)
    const au = seg.aus[kfIdx]
    return au !== undefined && au.keyframe ? { seg, au, tMs: epochMs } : null
  }

  /** Locate + read + demux the fragment covering `epochMs`, caching it. Null
   *  on gap/failure — a hole inside the travelled interval skips a still. */
  private async loadTravelFragment(epochMs: number): Promise<StepSegment | null> {
    try {
      const loc = await this.deps.locate({
        deviceId: this.deps.deviceId,
        profile: this.deps.profile,
        epochMs,
      })
      if (loc.kind !== 'segment') return null
      const load = await this.loadScrubFragment(loc, epochMs)
      if (load === null) return null
      this.scrubCache.put(this.deps.profile, load.seg)
      return load.seg
    } catch {
      return null
    }
  }

  /** Race a promise against the animation deadline. The loser keeps running
   *  in the background (its result still lands in the cache) — only the
   *  ANIMATION stops waiting for it. */
  private async raceDeadline<T>(p: Promise<T>, deadlineWall: number): Promise<T | 'deadline'> {
    const remaining = deadlineWall - performance.now()
    if (remaining <= 0) {
      p.catch(() => {})
      return 'deadline'
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), remaining)
    })
    try {
      const winner = await Promise.race([p, timeout])
      if (winner === 'deadline') p.catch(() => {})
      return winner
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * CACHE-ONLY travel stills for a drag JUMP: sample the crossed interval and
   * keep whatever keyframes are already warm — zero locate/read chains, by
   * design (a fling must never add load to a saturated hub; cold footage
   * degrades to today's single keyframe). Ordered in the drag direction,
   * deduped by fragment, excluding the fragments that cover the endpoints
   * (one is on screen, the other is the jump's own push).
   */
  private collectWarmTravelStills(
    fromMs: number,
    toMs: number,
    excludeFragStartMs: number,
    excludeKfIdx: number,
  ): TravelStill[] {
    const stills: TravelStill[] = []
    // Dedupe by the KEYFRAME, not by the cache entry that holds it. When the
    // scrub unit was one GOP the two were the same thing — one entry, one
    // keyframe — but a whole `low` segment holds two or three, so deduping by
    // `startMs` silently collapsed a fling across ten seconds into a single
    // still. The cost of the extra ones is zero: they are already demuxed and
    // in RAM, which is the entire reason the unit changed.
    const seen = new Set<string>()
    const samples = SCRUB_JUMP_TRAVEL_MAX_STILLS
    for (let i = 1; i <= samples; i++) {
      const tMs = Math.round(fromMs + ((toMs - fromMs) * i) / (samples + 1))
      const seg = this.scrubCache.covering(this.deps.profile, tMs)
      if (!seg || fragmentCovers(seg, fromMs)) continue
      const kfIdx = this.pickScrubIndex(seg, tMs, true)
      const au = seg.aus[kfIdx]
      if (au === undefined || !au.keyframe) continue
      // Exclude the ONE keyframe the tick is about to push itself — not the
      // whole entry that holds it. When an entry was a single GOP those were
      // the same exclusion; on a whole segment, excluding by entry threw away
      // every other keyframe in those ten seconds.
      if (seg.startMs === excludeFragStartMs && kfIdx === excludeKfIdx) continue
      const key = `${seg.startMs}|${kfIdx}`
      if (seen.has(key)) continue
      seen.add(key)
      stills.push({ seg, au, tMs })
    }
    return stills
  }

  /**
   * The directional prefetch is GONE (2026-08-26), not disabled.
   *
   * It guessed where the next tick would land from the drag's recent
   * direction. Measured on the operator's own drags the day it was removed:
   * **25 speculative reads bought 3 hits** — 88% waste, and roughly 60% of all
   * disk work during a gesture, queued as random seeks ahead of the read the
   * finger was actually blocked on, on a 5400 rpm SMR disk.
   *
   * The regression tests it passed drove a drag at CONSTANT step size, which is
   * the one regime where direction predicts position. A real backward scrub is
   * exploratory — 26 of 29 jumps backward, step size set by where the operator
   * decided to look next — so the premise never held in the field.
   *
   * The reference design has no predictive prefetch either: its read-ahead is
   * a stream `highWaterMark`, and a short forward move is a fast-forward on an
   * open fd rather than a seek. It deleted the problem instead of solving it.
   *
   * What REMAINS and must not be confused with this: the WINDOW warm
   * (`runScrubFillLoop`) — a sequential walk of the window around the playhead.
   *
   * It was described here, wrongly, as running "when no drag is live, so it
   * competes with nothing". It does not: its survival condition is
   * `this.scrubbing || this.idleWarm`, and within hours of this deletion it had
   * inherited the deleted predictor's role — 1.9 MB and 2.4 MB of reads on two
   * measured drags, 38-45% of the gesture's I/O, zero cache hits. Deleting one
   * speculator without looking at the other left the contention exactly where
   * it was. It now waits out a moving finger (`fingerIsMoving`), which is what
   * the sentence above claimed all along.
   *
   * Cost of the removal, bounded and accepted: a careful short-step drag no
   * longer warms the fragment across the edge, so the first tick past a
   * boundary may pay one cold read. Its own regression test shows that case is
   * served by the MEMO (`coverMemo ≥ 5`) with the neighbour warm worth ≤2
   * reads.
   */

  /**
   * Feed exactly one frame forward (+1) or backward (-1). Only meaningful while
   * paused over a segment (rate 0, recorded mode) — ignored otherwise. Forward
   * at a segment end crosses into the next segment (gaps are skipped via the
   * same lookahead the advance loop uses); backward at a segment start loads
   * the PREVIOUS segment and lands on its last frame. Backward re-feeds from
   * the nearest keyframe at-or-before the target so the decoder has a valid
   * GOP head. Edge no-ops: forward past the end of the recording, backward
   * into a gap/start of the recording, and a step while another cross-segment
   * step is still in flight.
   */
  stepFrame(dir: 1 | -1): void {
    // Frame-step is an ATOMIC pause+jog command. Requiring the client to send
    // setRate(0) first made ordering and stale UI state observable: a fresh
    // feeder could still be at rate 1 and silently drop the jog.
    if (this.disposed || this.scrubbing) return
    if (this.rate !== 0) this.setRate(0)
    // Preserve rapid taps rather than dropping every tap that arrives before
    // the previous async cross-segment step settles.
    if (this.pendingStepDirs.length < 16) this.pendingStepDirs.push(dir)
    this.drainStepQueue()
  }

  private drainStepQueue(): void {
    if (
      this.disposed ||
      this.scrubbing ||
      this.rate !== 0 ||
      this.stepInFlight ||
      this.inFlightSeekEpochMs !== null
    ) {
      return
    }
    const dir = this.pendingStepDirs.shift()
    if (dir === undefined) return
    this.stepInFlight = true
    void this.doStep(dir)
      .catch(() => {
        // Fire-and-forget: a locate/read/demux failure must not become an
        // unhandled rejection. The paused frame simply stays on screen.
      })
      .finally(() => {
        this.stepInFlight = false
        this.drainStepQueue()
      })
  }

  private async doStep(dir: 1 | -1): Promise<void> {
    const seg = this.currentSegment
    if (!seg || seg.aus.length === 0) return
    const token = this.seekToken
    const gen = this.advanceToken

    if (dir === 1) {
      const nextIdx = this.lastFedVideoIdx + 1
      if (nextIdx < seg.aus.length) {
        this.feedOneAu(seg, nextIdx)
        return
      }
      // At the segment tail — cross into the next segment (skips gaps forward).
      const prepared = await this.prepareNext(seg.startMs + seg.durMs, gen)
      if (prepared === null || prepared === 'ended') return
      if (this.disposed || token !== this.seekToken || this.rate !== 0) return
      if (prepared.aus.length === 0) return
      if (this.clockHasAdvanced) {
        this.clock.markSeek()
        this.audioClock.markSeek()
      }
      this.currentSegment = {
        startMs: prepared.startMs,
        durMs: prepared.durMs,
        aus: prepared.aus,
      }
      this.feedOneAu(this.currentSegment, 0)
      return
    }

    // dir === -1
    if (this.lastFedVideoIdx > 0) {
      this.refeedUpTo(seg, this.lastFedVideoIdx - 1)
      return
    }
    // At the head of the currently loaded AU list. That list may be a FULL
    // segment OR a temporary GOP window (seek paints the GOP first; full
    // demux arrives later). Probing `seg.startMs − 1` and then landing on the
    // LAST AU of whatever locate returns is the "loop": a mid-segment GOP
    // head locates the SAME segment and used to jump FORWARD to its tail.
    // Probe just before the cursor and land on the last AU strictly before it.
    const probeMs = Math.max(0, this.cursorMs - 1)
    let loc = await this.withTimeout(
      this.deps.locate({
        deviceId: this.deps.deviceId,
        profile: this.deps.profile,
        epochMs: probeMs,
      }),
    )
    if (this.disposed || token !== this.seekToken || this.rate !== 0) return
    // Consecutive segments leave an 11–17 ms crack; hop it via prevEndMs.
    if (loc.kind === 'gap' && loc.prevEndMs != null && loc.prevEndMs <= this.cursorMs) {
      loc = await this.withTimeout(
        this.deps.locate({
          deviceId: this.deps.deviceId,
          profile: this.deps.profile,
          epochMs: Math.max(0, loc.prevEndMs - 1),
        }),
      )
      if (this.disposed || token !== this.seekToken || this.rate !== 0) return
    }
    if (loc.kind !== 'segment') return
    // Paused: audio would be thrown away — skip the transcode.
    const loaded = await this.loadAus(loc.startMs, loc.durMs, false)
    if (loaded === null || loaded.video.length === 0) return
    if (this.disposed || this.rate !== 0) return
    const first = loaded.video[0]
    if (!first) return
    // Last AU whose absolute time is strictly before the cursor. Same-segment
    // GOP head → previous GOP's last frame; true segment head → previous
    // segment's last frame; nothing behind → targetIdx stays -1 (no-op).
    let targetIdx = -1
    for (let i = 0; i < loaded.video.length; i++) {
      const au = loaded.video[i]
      if (!au) break
      const absMs = loc.startMs + (au.ptsMs - first.ptsMs)
      if (absMs < this.cursorMs) targetIdx = i
      else break
    }
    if (targetIdx < 0) return
    this.currentSegment = {
      startMs: loc.startMs,
      durMs: loc.durMs,
      aus: loaded.video,
    }
    this.refeedUpTo(this.currentSegment, targetIdx)
  }

  /**
   * Clamp a frame-derived cursor into the segment's covered window
   * [startMs, startMs + durMs). Real frames can outlive the muxed `durMs`
   * (last pts − first pts ≥ durMs), and `startMs + durMs` itself is already
   * inside the inter-segment crack — a cursor parked there makes the next
   * `seek(cursorMs)` (resume/rate-change) locate a GAP and freeze playback.
   */
  private clampIntoSegment(seg: StepSegment, epochMs: number): number {
    return Math.min(Math.max(epochMs, seg.startMs), seg.startMs + seg.durMs - 1)
  }

  /** Push exactly one AU of `seg`, move the step cursor onto it, report position. */
  private feedOneAu(seg: StepSegment, idx: number): void {
    const au = seg.aus[idx]
    const first = seg.aus[0]
    if (!au || !first) return
    this.deps.sink.pushAccessUnit(au.data, this.clock.stamp(au.ptsMs), au.codec)
    this.clockHasAdvanced = true
    this.lastFedVideoIdx = idx
    this.cursorMs = this.clampIntoSegment(seg, seg.startMs + (au.ptsMs - first.ptsMs))
    this.deps.onPosition(this.cursorMs)
  }

  /**
   * Backward-step render: re-feed from the nearest keyframe at-or-before
   * `targetIdx` up TO `targetIdx` (decode needs the GOP head; the burst renders
   * fast and the display lands exactly one frame earlier). Re-anchors the
   * clocks first — the re-fed PTS run BEHIND the monotonic clock's anchor and
   * would otherwise clamp into duplicate output timestamps.
   */
  private refeedUpTo(seg: StepSegment, targetIdx: number): void {
    const first = seg.aus[0]
    const target = seg.aus[targetIdx]
    if (!first || !target) return
    let fromIdx = 0
    for (let i = targetIdx; i >= 0; i--) {
      if (seg.aus[i]?.keyframe) {
        fromIdx = i
        break
      }
    }
    if (this.clockHasAdvanced) {
      this.clock.markSeek()
      this.audioClock.markSeek()
    }
    for (let i = fromIdx; i <= targetIdx; i++) {
      const au = seg.aus[i]
      if (au) this.deps.sink.pushAccessUnit(au.data, this.clock.stamp(au.ptsMs), au.codec)
    }
    this.clockHasAdvanced = true
    this.lastFedVideoIdx = targetIdx
    this.cursorMs = this.clampIntoSegment(seg, seg.startMs + (target.ptsMs - first.ptsMs))
    this.deps.onPosition(this.cursorMs)
  }

  /**
   * Seek prefix feed (decode priming): push only the AUs with
   * `ptsMs − firstPtsMs ≤ requestedEpochMs − loc.startMs` — always at least the
   * first (IDR-led) AU so the feed is never empty — then park the cursor at the
   * requested epoch (clamped into the segment window). While paused this IS the
   * feed (exact-frame render); at rate > 0 it primes the decoder up to the
   * cursor and the advance loop paces the remainder. The demuxer contract
   * guarantees `aus[0]` is the segment's params-fused IDR, so the prefix always
   * starts at a keyframe.
   */
  private feedPrefix(loc: LocatedSegment, aus: AccessUnit[], requestedEpochMs: number): void {
    // Upper bound is durMs − 1: `startMs + durMs` is exclusive (already in the
    // inter-segment crack) and would gap-freeze the next seek(cursorMs).
    const clampedEpoch = Math.min(
      Math.max(requestedEpochMs, loc.startMs),
      loc.startMs + loc.durMs - 1,
    )
    this.currentSegment = { startMs: loc.startMs, durMs: loc.durMs, aus }
    const first = aus[0]
    if (!first) {
      this.lastFedVideoIdx = -1
      this.cursorMs = clampedEpoch
      return
    }
    const offsetMs = requestedEpochMs - loc.startMs
    let lastIdx = 0 // at least the first AU, even when the epoch precedes it
    for (let i = 1; i < aus.length; i++) {
      const au = aus[i]
      if (au && au.ptsMs - first.ptsMs <= offsetMs) lastIdx = i
      else break
    }
    for (let i = 0; i <= lastIdx; i++) {
      const au = aus[i]
      if (au) this.deps.sink.pushAccessUnit(au.data, this.clock.stamp(au.ptsMs), au.codec)
    }
    this.clockHasAdvanced = true
    this.lastFedVideoIdx = lastIdx
    this.cursorMs = clampedEpoch
  }

  /**
   * Start (or restart) the single forward advance loop. Bumping `advanceToken`
   * invalidates any loop already running, guaranteeing at most one survives.
   * `initial` hands the loop the seek's already-loaded covering segment plus
   * the prefix boundary, so pacing resumes FROM THE CURSOR instead of the loop
   * re-locating (and thereby skipping) the segment under it.
   */
  private startAdvance(initial?: InitialAdvanceSegment): void {
    const gen = ++this.advanceToken
    void this.advanceLoop(gen, initial).catch(() => {
      // A read/demux/locate failure inside the fire-and-forget loop must not
      // become an unhandled rejection (would crash the broker process).
      // Guarded so a stale/disposed loop doesn't clobber a newer state.
      if (!this.disposed && gen === this.advanceToken) {
        this.stopPositionReports()
        this.emitState('error', 'advance-loop-failed', this.seekToken, this.scrubDragId)
      }
    })
  }

  private async advanceLoop(gen: number, initial?: InitialAdvanceSegment): Promise<void> {
    // First segment: the seek's covering segment (resume from the cursor) when
    // handed one, else prepare (locate + read + demux) the next forward segment.
    let prepared: PreparedSegment | 'ended' | null
    let resumeAfterPtsMs: number | null = null
    let isResumedSegment = false
    if (initial) {
      prepared = initial.prepared
      resumeAfterPtsMs = initial.resumeAfterPtsMs
      isResumedSegment = true
    } else {
      prepared = await this.prepareNext(this.cursorMs, gen)
    }
    while (!this.disposed && gen === this.advanceToken && this.rate > 0) {
      if (prepared === null) return
      if (prepared === 'ended') {
        this.stopPositionReports()
        this.emitState('ended', 'advance-ended', this.seekToken, this.scrubDragId)
        return
      }
      if (isResumedSegment) {
        // The seek's prefix already burst part of this segment on the CURRENT
        // clock anchor and left the cursor at the resume point — do NOT rewind
        // the cursor to the segment head and do NOT re-anchor (markSeek): the
        // paced remainder continues the SAME source timeline as the prefix.
      } else {
        // Push the prepared segment. Forward-only: the cursor only ever advances
        // (prepareNext already skipped any behind-the-frontier overlap), so we
        // never replay already-shown frames.
        this.cursorMs = prepared.startMs
        // Each recorded segment carries its OWN reset timeline (the recorder muxes
        // with -reset_timestamps, so every .m4s restarts PTS at ~0). Re-anchor the
        // monotonic output clock at every segment boundary — otherwise the next
        // segment's near-zero PTS clamps against the previous segment's output and
        // only its keyframe advances the timestamp (the "one I-frame per ~4 s"
        // symptom). markSeek() continues the output clock past the last emitted ts.
        if (this.clockHasAdvanced) {
          this.clock.markSeek()
          this.audioClock.markSeek()
        }
      }

      // PREFETCH: kick off read+demux of the NEXT segment CONCURRENTLY with PACING
      // the current one. The current segment now takes ~durMs of real-time pacing
      // (drip per PTS) instead of one setTimeout(durMs); the prefetch resolves
      // well within that window, so the next batch is ready the instant the
      // current finishes — no segment-boundary stall (jitter buffer never drains).
      const prefetch = this.prepareNext(prepared.startMs + prepared.durMs, gen)

      // Pace this segment's access units at their REAL frame cadence: drip each
      // one at its PTS time relative to the segment start, instead of dumping the
      // whole segment then sleeping. RTP timestamps are unchanged (same clock.stamp
      // calls) — only DELIVERY timing changes, so the receiver's live-tuned jitter
      // buffer no longer starves between ~4 s bursts.
      const aborted = await this.paceSegment(prepared, gen, resumeAfterPtsMs)
      this.notePacedSegment(prepared)
      resumeAfterPtsMs = null
      isResumedSegment = false
      // The cursor lands at the END of the segment once it has been fully paced
      // (mirrors the old post-wait advance); if the pacing aborted on a
      // seek/dispose/rate-change we leave the loop without advancing.
      if (aborted) {
        // Drain the prefetch so its in-flight read/demux can't leak as an
        // unhandled rejection after we abandon this loop generation.
        void prefetch.catch(() => {})
        this.emitPlayCensus('stop')
        return
      }
      this.cursorMs = prepared.startMs + prepared.durMs

      // The next segment was prepared during pacing — await it (already resolved
      // in the common case) so the loop continues with no boundary I/O wait.
      const waitStartedAt = performance.now()
      prepared = await prefetch
      this.notePrefetchWait(performance.now() - waitStartedAt, prepared)
    }
  }

  /**
   * Drip one prepared segment to the sink at its real frame cadence: build a
   * single PTS-ordered schedule of the segment's video + audio access units and
   * push each at `segmentStart + (pts - firstPts) / rate` wall-clock time,
   * sleeping between items with a drift-free absolute-time wait. RTP timestamps
   * come from the SAME `clock.stamp` / `audioClock.stamp` calls as before (the
   * clock itself carries the rate factor) — only delivery timing changes.
   * `resumeAfterPtsMs` (a resumed covering segment) paces only the items
   * strictly after the seek prefix, over the segment's REMAINING window.
   * Returns `true` if a seek/dispose/pause aborted pacing mid-segment (the
   * caller must stop without advancing the cursor).
   */
  private async paceSegment(
    prepared: PreparedSegment,
    gen: number,
    resumeAfterPtsMs: number | null = null,
  ): Promise<boolean> {
    // The rate this pacing pass runs at. It cannot drift mid-segment: any rate
    // CHANGE re-enters via seek() which bumps advanceToken (aborting this pass
    // through the gen guards), and setRate(0) aborts through the rate===0 guards.
    const rate = this.rate
    // Audio only at 1× — at any other rate the schedule is video-only (PCMU is
    // real-time speech; re-pacing it sounds wrong and the 8 kHz clock stays 1×).
    const audioPush = this.resolveAudioPush()
    const hasAudioSink = audioPush !== undefined && rate === 1
    // Merge video + (optional) audio into one stable, time-ordered schedule.
    // Stable sort: on a PTS tie, video precedes audio (preserves the historical
    // "video first" ordering and keeps the receiver's frame arrival deterministic).
    // A resumed segment (resumeAfterPtsMs !== null) schedules ONLY the items
    // strictly after the seek prefix — the prefix was already burst.
    const schedule: ScheduledItem[] = []
    for (const au of prepared.aus) {
      if (resumeAfterPtsMs === null || au.ptsMs > resumeAfterPtsMs)
        schedule.push({ ptsMs: au.ptsMs, video: au })
    }
    if (hasAudioSink) {
      for (const au of prepared.audio) {
        if (resumeAfterPtsMs === null || au.ptsMs > resumeAfterPtsMs)
          schedule.push({ ptsMs: au.ptsMs, audio: au })
      }
    }
    schedule.sort((a, b) => {
      if (a.ptsMs !== b.ptsMs) return a.ptsMs - b.ptsMs
      // Video before audio on a tie (a.video defined → -1).
      return (a.video ? 0 : 1) - (b.video ? 0 : 1)
    })
    // Step-state bookkeeping: pacing makes this segment the one under the
    // cursor so a pause mid-segment can frame-step from the last pushed frame.
    // On a resume the prefix already positioned the step cursor — recompute the
    // fed-frame index from the resume point instead of resetting it.
    this.currentSegment = {
      startMs: prepared.startMs,
      durMs: prepared.durMs,
      aus: prepared.aus,
    }
    let videoIdx = 0
    if (resumeAfterPtsMs === null) {
      this.lastFedVideoIdx = -1
    } else {
      while (videoIdx < prepared.aus.length && prepared.aus[videoIdx]!.ptsMs <= resumeAfterPtsMs) {
        videoIdx++
      }
      this.lastFedVideoIdx = videoIdx - 1
    }
    const firstVideoPtsMs = prepared.aus[0]?.ptsMs ?? 0
    // Media time already consumed inside this segment by the seek prefix (0 for
    // a fresh segment) — the remaining pace window shrinks by it.
    const consumedMs =
      resumeAfterPtsMs === null ? 0 : Math.max(0, resumeAfterPtsMs - firstVideoPtsMs)
    const remainingWindowMs = Math.max(0, prepared.durMs - consumedMs)
    if (schedule.length === 0) {
      // Nothing left to push (empty segment, or the prefix consumed it all):
      // still hold the remaining window so playback stays at the configured rate.
      return await this.sleepUntil(performance.now() + remainingWindowMs / rate, gen)
    }

    // Pacing baseline: the resume point when resuming (so the first remaining
    // AU lands after its real cadence gap), else the schedule's min PTS.
    const baselinePtsMs = resumeAfterPtsMs ?? schedule[0]!.ptsMs
    const segmentStartWall = performance.now()
    let pushedVideo = false
    for (const item of schedule) {
      // Delivery delay scales with rate: at 2× a 40 ms source gap is 20 ms of
      // wall time.
      const targetWall = segmentStartWall + (item.ptsMs - baselinePtsMs) / rate
      // Drift-free wait: re-derive remaining each iteration against the absolute
      // target so per-frame setTimeout error never accumulates across the segment.
      if (await this.sleepUntil(targetWall, gen)) return true
      // Re-check guards BEFORE each push — a seek/dispose/pause during the wait
      // must abort cleanly (mirror the loop's gen === advanceToken check).
      if (this.disposed || gen !== this.advanceToken || this.rate === 0) return true
      if (item.video) {
        this.deps.sink.pushAccessUnit(
          item.video.data,
          this.clock.stamp(item.video.ptsMs),
          item.video.codec,
        )
        pushedVideo = true
        // Media-time cursor: position reports track the FED frame, so the
        // playhead advances at rate × wall time automatically.
        this.lastFedVideoIdx = videoIdx++
        this.cursorMs = prepared.startMs + (item.video.ptsMs - firstVideoPtsMs)
      } else if (item.audio) {
        // Guarded above via hasAudioSink, but re-read defensively for the type.
        if (audioPush) audioPush(item.audio.data, this.audioClock.stamp(item.audio.ptsMs))
      }
    }
    if (pushedVideo) this.clockHasAdvanced = true
    // Hold the remaining tail of the segment window (last PTS → durMs) so the
    // total real time to pace ≈ (durMs − consumed)/rate and playback runs at
    // the configured rate (matches the old setTimeout(durMs) total at 1×).
    const segmentEndWall = segmentStartWall + remainingWindowMs / rate
    return await this.sleepUntil(segmentEndWall, gen)
  }

  /**
   * Drift-free absolute-time wait until `targetWall` (a `performance.now()`
   * value). Re-derives the remaining interval each tick and caps each individual
   * timeout so a long inter-frame gap can't delay seek/dispose responsiveness —
   * the loop re-checks `gen === advanceToken` between ticks. Returns `true` if a
   * dispose/seek/pause aborted the wait, so the caller stops pushing. (A rate
   * CHANGE aborts via the gen guard — setRate re-enters through seek(), which
   * bumps advanceToken; rate 0 is the direct pause abort.)
   */
  private async sleepUntil(targetWall: number, gen: number): Promise<boolean> {
    for (;;) {
      if (this.disposed || gen !== this.advanceToken || this.rate === 0) return true
      const remaining = targetWall - performance.now()
      if (remaining <= 0) return false // already due — push immediately to catch up
      const tick = Math.min(remaining, WAIT_TICK_MS)
      await new Promise<void>((resolve) => setTimeout(resolve, tick))
    }
  }

  /**
   * Forward-only lookahead: from `fromMs`, find the next segment to play —
   * skipping gaps forward and overlapping segments that start BEHIND the frontier
   * (corrupted/overlapping recordings) — then read + demux it. Returns its access
   * units, `"ended"` when there is no forward footage, or `null` when superseded
   * (disposed / a newer advance generation) mid-flight. Pure lookahead: never
   * mutates the cursor (the caller advances it on push).
   */
  private async prepareNext(
    fromMs: number,
    gen: number,
  ): Promise<PreparedSegment | 'ended' | null> {
    let probe = fromMs + 1
    let guard = 0
    while (guard++ < 2000) {
      const loc = await this.withTimeout(
        this.deps.locate({
          deviceId: this.deps.deviceId,
          profile: this.deps.profile,
          epochMs: probe,
        }),
      )
      if (this.disposed || gen !== this.advanceToken) return null
      if (loc.kind === 'gap') {
        if (loc.nearestEdgeMs == null) return 'ended'
        probe = loc.nearestEdgeMs // jump forward to the next footage edge
        continue
      }
      if (loc.startMs < fromMs) {
        // Overlapping segment starting behind the frontier — skip past its end.
        probe = loc.startMs + loc.durMs + 1
        continue
      }
      const loaded = await this.loadAus(loc.startMs, loc.durMs)
      if (loaded === null) return null
      return {
        startMs: loc.startMs,
        durMs: loc.durMs,
        aus: loaded.video,
        audio: loaded.audio,
        readMs: loaded.readMs,
        demuxMs: loaded.demuxMs,
        bytes: loaded.bytes,
      }
    }
    return 'ended'
  }

  /** Read + demux one segment's bytes into video (+ best-effort PCMU audio)
   *  access units. Keyed on `seekToken` so a fresh seek aborts an in-flight load
   *  (latest-wins). Returns null on abort. Audio demux failures yield [] (audio
   *  never blocks video). `wantAudio: false` skips the audio transcode entirely
   *  (paused scrubs would throw it away). */
  private async loadAus(
    startMs: number,
    durMs: number,
    wantAudio = true,
    onVideoReady?: (video: AccessUnit[]) => void,
  ): Promise<LoadedAus | null> {
    const token = this.seekToken
    const readStartedAt = performance.now()
    const bytes = await this.withTimeout(
      this.deps.readBytes({
        deviceId: this.deps.deviceId,
        profile: this.deps.profile,
        startMs,
      }),
    )
    const readMs = performance.now() - readStartedAt
    if (this.disposed || token !== this.seekToken) return null
    // Video and audio demux are independent reads over the same immutable
    // bytes. Running them serially made every recorded seek pay both costs
    // before the first frame could be fed; on ffmpeg fallback paths that was
    // several avoidable seconds. Audio remains best-effort.
    const demuxStartedAt = performance.now()
    const audioPromise: Promise<AudioAccessUnit[]> =
      wantAudio && this.deps.demuxAudio && this.resolveAudioPush() !== undefined
        ? this.withTimeout(this.deps.demuxAudio(bytes)).catch(() => [])
        : Promise.resolve([])
    const videoPromise = this.withTimeout(this.deps.demux(bytes)).then((demuxed) => {
      const video = this.repairPts(demuxed, startMs, durMs)
      if (!this.disposed && token === this.seekToken) onVideoReady?.(video)
      return video
    })
    const [video, audio] = await Promise.all([videoPromise, audioPromise])
    const demuxMs = performance.now() - demuxStartedAt
    if (this.disposed || token !== this.seekToken) return null
    return { video, audio, readMs, demuxMs, bytes: bytes.byteLength }
  }

  /**
   * Make one demuxed series fit the window the recorder measured for it, and
   * SAY SO when it did not — see `segment-pts-repair.ts` for why a gap wider
   * than `durMs` cannot be footage.
   *
   * This is the only guard between the file's stamps and `paceSegment`, which
   * sleeps every inter-AU delta out with no bound. Device 4374's segments put
   * their key frame 73 s before the frame after it inside a 9 955 ms window;
   * the loop slept, the cursor never moved off the seek target, and the only
   * evidence was a `recorded:play-census` line with `pacedAus=150 segments=1`.
   * A branch that silently drops work logs (repo rule) — and the log carries
   * `deviceId` through `onLog`'s tags, because "why is 4374 worse than 101" is
   * the only way this question is ever asked.
   *
   * Logged once per segment start per feeder: a broken camera should name every
   * distinct segment it damages, not repeat one on every scrub warm.
   */
  private repairPts(aus: AccessUnit[], startMs: number, durMs: number): AccessUnit[] {
    const result = repairSegmentPts(
      aus,
      durMs,
      (au) => au.ptsMs,
      (au, ptsMs) => ({ ...au, ptsMs }),
    )
    if (!result.repaired) return aus
    if (!this.ptsRepairLogged.has(startMs)) {
      if (this.ptsRepairLogged.size >= PTS_REPAIR_LOG_MEMORY) this.ptsRepairLogged.clear()
      this.ptsRepairLogged.add(startMs)
      this.deps.onLog?.('recorded:segment-pts-repaired', {
        startMs,
        durMs,
        aus: aus.length,
        discontinuities: result.discontinuities,
        collapsedMs: Math.round(result.collapsedMs),
        spanBeforeMs: Math.round(result.spanBeforeMs),
        spanAfterMs: Math.round(result.spanAfterMs),
      })
    }
    return [...result.aus]
  }

  private startPositionReports(): void {
    if (this.positionTimer) return
    this.positionTicks = 0
    this.positionTimer = setInterval(() => {
      if (this.disposed) return
      this.deps.onPosition(this.cursorMs)
      if (this.rate <= 0) return
      this.positionTicks += 1
      if (this.positionTicks % PLAY_CENSUS_INTERVAL_TICKS === 0) this.emitPlayCensus('tick')
    }, POSITION_INTERVAL_MS)
  }

  /** Tear down the ~1 Hz position interval so it stops reporting a stale cursor. */
  private stopPositionReports(): void {
    if (this.positionTimer) {
      clearInterval(this.positionTimer)
      this.positionTimer = null
    }
    this.emitPlayCensus('stop')
  }

  private notePacedSegment(prepared: PreparedSegment): void {
    const w = this.playCensus
    if (w.windowStartedAt === 0) w.windowStartedAt = performance.now()
    w.pacedAus += prepared.aus.length
    w.segments += 1
    if (prepared.readMs !== undefined) w.lastReadMs = prepared.readMs
    if (prepared.demuxMs !== undefined) w.lastDemuxMs = prepared.demuxMs
    if (prepared.bytes !== undefined) w.lastBytes = prepared.bytes
  }

  private notePrefetchWait(waitMs: number, next: PreparedSegment | 'ended' | null): void {
    const w = this.playCensus
    if (w.windowStartedAt === 0) w.windowStartedAt = performance.now()
    if (waitMs > w.prefetchWaitMsMax) w.prefetchWaitMsMax = waitMs
    if (next && next !== 'ended') {
      if (next.readMs !== undefined) w.lastReadMs = next.readMs
      if (next.demuxMs !== undefined) w.lastDemuxMs = next.demuxMs
      if (next.bytes !== undefined) w.lastBytes = next.bytes
    }
    if (waitMs <= PLAY_STALL_MS) return
    w.stalls += 1
    this.deps.onLog?.('recorded:play-stall', {
      waitMs: Math.round(waitMs),
      cursorMs: this.cursorMs,
      nextReadMs: next && next !== 'ended' ? Math.round(next.readMs ?? 0) : null,
      nextDemuxMs: next && next !== 'ended' ? Math.round(next.demuxMs ?? 0) : null,
      nextBytes: next && next !== 'ended' ? (next.bytes ?? null) : null,
    })
  }

  private emitPlayCensus(reason: PlayCensusReason): void {
    const w = this.playCensus
    if (w.segments === 0 && w.pacedAus === 0 && w.stalls === 0) {
      if (reason === 'stop') this.playCensus = emptyPlayCensus()
      return
    }
    this.deps.onLog?.('recorded:play-census', {
      reason,
      windowMs: Math.round(performance.now() - w.windowStartedAt),
      pacedAus: w.pacedAus,
      segments: w.segments,
      prefetchWaitMsMax: Math.round(w.prefetchWaitMsMax),
      stalls: w.stalls,
      lastReadMs: Math.round(w.lastReadMs),
      lastDemuxMs: Math.round(w.lastDemuxMs),
      lastBytes: w.lastBytes,
      cursorMs: this.cursorMs,
    })
    this.playCensus = emptyPlayCensus()
  }

  /**
   * Race a promise against a timeout, clearing the timer the moment the inner
   * promise settles so no open handle leaks or keeps the process alive.
   */
  private async withTimeout<T>(p: Promise<T>, timeoutMs: number = SEGMENT_TIMEOUT_MS): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('segment read timeout')), timeoutMs)
    })
    try {
      return await Promise.race([p, timeout])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * Drain the drag accumulator into the ONE aggregate line, then clear it.
   * Idempotent by construction: `scrubStats` is nulled here, so the second
   * caller (dispose after a commit `seek`) emits nothing.
   */
  private emitDragEnd(): void {
    const stats = this.scrubStats
    if (stats === null) return
    this.scrubStats = null
    const mark = this.scrubDemuxMark
    const demux = mark && this.deps.demuxTally ? this.deps.demuxTally.deltaSince(mark) : undefined
    this.scrubDemuxMark = null
    this.deps.onLog?.('scrub-feeder:drag-end', {
      dragId: this.scrubDragId,
      ...stats.toLogFields(performance.now() - this.scrubStartedAtMs, demux),
    })
  }

  /** Stop everything: invalidate in-flight work and tear down the position timer. */
  dispose(): void {
    // A drag abandoned by goLive/profile change still owes its aggregate: a
    // drag that produced no line reads exactly like a drag that never ran.
    if (this.scrubbing) this.emitDragEnd()
    this.disposed = true
    this.seekToken++
    this.advanceToken++
    // Leave scrub sub-mode: invalidate any in-flight scrub push (goLive/profile
    // change dispose the feeder mid-drag) and cancel the coalescing timer so no
    // scrub tick fires after teardown.
    this.scrubbing = false
    this.idleWarm = false
    this.scrubToken++
    this.scrubSegment = null
    // Prefetch state drops; the bumped scrubToken invalidates any in-flight
    // prefetch (its finally clears the in-flight flag). The fragment cache is
    // NOT cleared: when session-injected it outlives this feeder by design
    // (the next enterRecorded reuses it), and a private one dies with us.
    this.scrubPrevTarget = null
    this.scrubCursor = null
    this.scrubNoFootageLogged = false
    this.scrubParkLogged = false
    this.scrubDeadlineLogged = false
    this.scrubOversizeLogged = false
    this.scrubProfileLogged = false
    this.scrubPushedThisDrag = false
    this.scrubResolve = null
    this.scrubVelocity = null
    this.scrubLastSampleMs = null
    this.scrubVelRun = 0
    this.scrubOutstanding = []
    this.clearScrubAckTimeout()
    this.scrubPendingHint = null
    if (this.scrubTimer) {
      clearTimeout(this.scrubTimer)
      this.scrubTimer = null
    }
    this.stopPositionReports()
  }
}
