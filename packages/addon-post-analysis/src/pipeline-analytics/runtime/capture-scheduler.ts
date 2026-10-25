/**
 * `CaptureScheduler` — THE single owner of capture pressure (refactor S3,
 * spec `2026-07-22-post-analysis-maintainability-refactor-design.md`, A7).
 *
 * Before S3, capture pressure on the retained-frame ring was the emergent sum
 * of 5 in-flight Sets + 1 FIFO + 1 bucket trick across 8 uncoordinated
 * native-fetch call sites — adding one cadence stampeded the ring ("frame
 * recycled before resolve", live regression 2026-07-22). This class makes the
 * pressure ONE number in ONE file:
 *
 *  • **Budget** — at most `maxInFlightPerDevice` (default 3) `exec`s run per
 *    device; excess requests queue in PRIORITY order (kind-derived default,
 *    `firstFrame` highest; explicit `priority` overrides), FIFO within a
 *    priority. Under NO contention (budget not reached) `exec` is invoked
 *    SYNCHRONOUSLY inside `request`, so uncontended behavior — captures,
 *    per-frame start order, media outputs — is identical to the pre-S3
 *    fire-and-forget call sites.
 *  • **Coalescing** — a request carrying a `coalesceKey` while another with
 *    the SAME key is queued or running JOINS it (same promise, no second
 *    exec). This REPLACES the RC-1 per-track in-flight-Set semantics: the old
 *    "skip while in flight" is now "join the in-flight request".
 *  • **Hold keys** — a request may additionally hold `holdKeys` active while
 *    queued/running WITHOUT dedupe. The per-frame BATCH media dispatch (one
 *    exec covering many tracks) publishes its per-`(device,kind,track)`
 *    coverage this way so the demand-side gates (`buildSnapshotTargets`,
 *    `collectFirstFrameRetries`) keep suppressing duplicate targets exactly
 *    as the legacy per-track flags did. `isKeyActive` answers both key kinds.
 *  • **Staleness drop** — a QUEUED request older than its `staleAfterMs`
 *    resolves `null` without exec, counted in metrics. This is what makes a
 *    late frame batch skipping N targets on an already-recycled handle VISIBLE
 *    (`droppedStale` / `maxQueueDepth` in the windowed line) instead of silent.
 *    Evaluated at dequeue AND at admission: a saturated lane never dequeues, so
 *    dequeue alone let expired entries accumulate forever.
 *  • **Admission bound** — the queue itself is capped per device
 *    (`maxQueuedPerDevice`). The budget bounds concurrent WORK and never
 *    bounded queued work; since queued closures pin ~0.7 MB frame copies, that
 *    gap was 2.28 GB of retained Buffers on the live hub. Over the cap the
 *    TAIL is shed — the entry this scheduler's own priority order already
 *    ranked last. See {@link CaptureScheduler.enqueue}.
 *  • **Cancel** — `cancelForTrack(trackId)` drops (resolves `null`) every
 *    QUEUED request of a closed track; a RUNNING exec is never interrupted.
 *    Wired from `TrackResidentState.close` via its `onClose` hook so every
 *    close mode + `closeDevice` funnels through one choke point.
 *  • **Metrics** — per-device windowed counters flushed as ONE aggregated
 *    info line per `logWindowMs` (default 60s), mirroring the
 *    `MediaCaptureLogAggregator` idiom: pure + timer-free, flushed
 *    opportunistically from the counter bumps themselves. Never one line per
 *    request.
 *
 * Timing is injectable (`now`) so the queueing/staleness/window logic is
 * testable without real clocks.
 */

import type { IScopedLogger } from '@camstack/types'

/** What a capture request is FOR — drives its default priority. */
export type CaptureKind =
  | 'firstFrame'
  | 'keyFrame'
  | 'thumbnail'
  | 'timeline'
  | 'lastFrame'
  | 'snapshot'
  | 'embed'
  | 'face'
  | 'plate'
  | 'confirm'
  | 'other'

/**
 * Kind-derived default priorities (0 = highest). Explicit `priority` wins.
 *
 * `confirm` (S4) is the confirmation-gate re-detect crop: it GATES track birth
 * (the frame path awaits it), so it ranks WITH `firstFrame` at 0 — it must
 * jump every queued lower-priority capture. It DOES set a `staleAfterMs`, and
 * it must: priority 0 means it is inserted at the head, so an entry here that
 * cannot expire makes the whole lane unrecoverable — every later arrival is
 * inserted at the tail and shed on admission. Its deadline is the gate's own
 * `timeoutMs`, past which its caller has already discarded the answer; see the
 * `fetchCrop` note in `pipeline-analytics/index.ts`. `face`/`plate` (S4) are
 * enrichment gallery crops — same rank as `embed`: nice-to-have media that
 * must never displace the track-media ladder above.
 *
 * The admission cap sheds from the TAIL, so a `confirm` can only be shed when
 * every queued entry is priority 0 — and even then the outcome is safe rather
 * than fail-open: `fetchCrop` resolving `null` makes `evaluateBirth` return
 * `undecided(candidate, 'no-crop')`, which is a birth NOT confirmed. This note
 * used to say a dropped confirm would fail open; it does not, and that is what
 * makes shedding admissible at all.
 */
export const DEFAULT_CAPTURE_PRIORITY: Readonly<Record<CaptureKind, number>> = {
  firstFrame: 0,
  confirm: 0,
  keyFrame: 1,
  thumbnail: 2,
  timeline: 3,
  lastFrame: 3,
  snapshot: 3,
  embed: 4,
  face: 4,
  plate: 4,
  other: 4,
}

/** Canonical `deviceId:kind:trackId` key shared by coalescing requests and the
 *  demand-side `isKeyActive` gates (the RC-1 in-flight-Set replacement). */
export function captureCoalesceKey(deviceId: number, kind: CaptureKind, trackId: string): string {
  return `${deviceId}:${kind}:${trackId}`
}

/** What the per-frame batch media dispatch contains this frame. */
export interface FrameDispatchContent {
  readonly hasFirstFrame: boolean
  readonly hasThumbnail: boolean
  readonly hasLastFrame: boolean
  readonly hasSnapshot: boolean
}

/**
 * The ONE batched `captureForFrame` dispatch covers a mix of target kinds; its
 * scheduler priority derives from the highest-priority content it carries
 * (events / raster-fallback-only dispatches rank as `timeline`).
 */
export function deriveFrameDispatchKind(content: FrameDispatchContent): CaptureKind {
  if (content.hasFirstFrame) return 'firstFrame'
  if (content.hasThumbnail) return 'thumbnail'
  if (content.hasLastFrame) return 'lastFrame'
  if (content.hasSnapshot) return 'snapshot'
  return 'timeline'
}

/** A typed capture request. `exec` is the actual capture closure. */
export interface CaptureRequestInput<T> {
  readonly deviceId: number
  readonly trackId?: string
  readonly kind: CaptureKind
  /** Overrides the kind-derived default priority (lower = sooner). */
  readonly priority?: number
  /** Dedupe key: joins an identical queued/running request (same promise). */
  readonly coalesceKey?: string
  /** Queued longer than this → resolve `null` without exec (dropped stale). */
  readonly staleAfterMs?: number
  /** Extra keys held active (for `isKeyActive`) while queued/running, WITHOUT
   *  dedupe — the batch dispatch publishes per-track coverage through these. */
  readonly holdKeys?: readonly string[]
  readonly exec: () => Promise<T>
}

export interface CaptureSchedulerOptions {
  readonly logger: IScopedLogger
  /** Per-device concurrent-exec budget (default 3). */
  readonly maxInFlightPerDevice?: number
  /** Per-device QUEUE depth cap (default {@link DEFAULT_MAX_QUEUED_PER_DEVICE}).
   *  See {@link CaptureScheduler.enqueue} for why the queue needs its own
   *  bound and why the budget is not one. */
  readonly maxQueuedPerDevice?: number
  /** Aggregated metrics log window (default 60s). */
  readonly logWindowMs?: number
  /** Injectable clock (default `Date.now`). */
  readonly now?: () => number
  /**
   * Fired once per request this scheduler DROPS without exec-ing (stale
   * expiry or overflow shed) — never for a cancel, which is a track that
   * closed and wants nothing. The windowed counters aggregate the volume;
   * this callback carries the per-track identity the counters lose, so the
   * close path can say WHICH track starved and why (D276/B2).
   */
  readonly onDropped?: (drop: CaptureDropNotice) => void
  /**
   * Fired once per request that actually STARTS executing — the DENOMINATOR for
   * {@link CaptureSchedulerOptions.onDropped}.
   *
   * Without it a drop count is a bare numerator, and a bare numerator moves with
   * traffic: `droppedStale:70` out of `requested:100` and out of `requested:10000`
   * are opposite findings and read identically. A coalesced or cancelled request
   * fires neither callback on purpose — see {@link CaptureDropNotice}.
   */
  readonly onStarted?: (deviceId: number) => void
}

/** One dropped-without-exec request (see {@link CaptureSchedulerOptions.onDropped}). */
export interface CaptureDropNotice {
  readonly deviceId: number
  readonly trackId?: string
  readonly kind: CaptureKind
  readonly cause: 'stale' | 'overflow'
}

/** Windowed per-device counters (also snapshot-readable via `counters`). */
export interface CaptureSchedulerCounters {
  readonly requested: number
  readonly started: number
  readonly completed: number
  readonly failed: number
  readonly coalesced: number
  readonly droppedStale: number
  /** Shed at ADMISSION because the lane's queue was already full. Distinct
   *  from `droppedStale`: stale means "we looked and it had expired", overflow
   *  means "we never had room to look". */
  readonly droppedOverflow: number
  readonly cancelled: number
  readonly maxQueueDepth: number
}

type CaptureCounter = Exclude<keyof CaptureSchedulerCounters, 'maxQueueDepth'>

interface MetricsWindow {
  sinceMs: number
  requested: number
  started: number
  completed: number
  failed: number
  coalesced: number
  droppedStale: number
  droppedOverflow: number
  cancelled: number
  maxQueueDepth: number
}

/** A queued (over-budget) request, type-erased behind start/drop closures so
 *  no unsafe resolve/reject members are stored. */
interface QueuedCapture {
  readonly trackId: string | undefined
  readonly kind: CaptureKind
  readonly priority: number
  readonly enqueuedAt: number
  readonly staleAfterMs: number | undefined
  /** Begin the exec (budget slot already reserved by the pump loop). */
  readonly start: () => void
  /** Resolve the caller's promise with `null` without ever exec-ing. */
  readonly drop: () => void
}

interface DeviceLane {
  inFlight: number
  readonly queue: QueuedCapture[]
}

const DEFAULT_MAX_IN_FLIGHT_PER_DEVICE = 3
const DEFAULT_LOG_WINDOW_MS = 60_000

/**
 * Per-device QUEUE depth cap.
 *
 * 24 is 8 budget-fulls deep: enough that a normal burst (a frame with media
 * targets on several tracks at once, plus the enrichment ladder) never sheds,
 * and small enough that a saturated lane's pinned frames stay a bounded cost.
 * At ~0.7 MB per pinned detection frame that is <=17 MB per camera instead of
 * the unbounded growth measured at 2.28 GB of `arrayBuffers` fleet-wide.
 */
const DEFAULT_MAX_QUEUED_PER_DEVICE = 24

/** One `capture queue full` line per device per this interval. The condition
 *  holds for as long as the lane is saturated; one line per shed request would
 *  be thousands. What the line REPORTS is the whole interval's shed count, not
 *  the one call that happened to break the throttle — see {@link OverflowWindow}. */
const OVERFLOW_WARN_THROTTLE_MS = 60_000

/**
 * Per-device accumulator behind the throttled `capture queue full` warn.
 *
 * A shed happens one entry at a time (each admission over the cap pops exactly
 * one tail), so the line used to report `shed: 1` — every time, forever, because
 * that is the count of the CALL and not of the CONDITION. Measured on the live
 * hub 2026-08-30: 272 `capture queue full` lines in 24 h against 6 415 sheds the
 * scheduler's own `droppedOverflow` counter recorded over ~17 h — the warn
 * under-reported the loss by ~24×, and the number an operator read off it was
 * two orders of magnitude too small to look like the starvation it was. The
 * throttle stays (a line per shed would be thousands); the COUNT becomes the
 * interval's, which is what a per-window summary means.
 */
interface OverflowWindow {
  /** Start of the CURRENT reporting interval — the device's first shed, then
   *  the instant of each emitted line. It is what `windowSec` measures. */
  sinceMs: number
  /** Every entry shed since {@link sinceMs}, reported and then reset to 0. */
  shed: number
  /** When the last line was emitted (the throttle clock). */
  lastWarnAt: number
}

export class CaptureScheduler {
  private readonly logger: IScopedLogger
  private readonly budget: number
  private readonly maxQueued: number
  private readonly windowMs: number
  private readonly now: () => number
  private readonly lanes = new Map<number, DeviceLane>()
  /** coalesceKey → the promise every joiner shares (queued or running). */
  private readonly coalesced = new Map<string, Promise<unknown>>()
  /** holdKey → refcount of queued/running requests holding it. */
  private readonly heldKeys = new Map<string, number>()
  private readonly windows = new Map<number, MetricsWindow>()
  /** Per-device throttle + shed accumulator for the `capture queue full` warn. */
  private readonly overflowWindows = new Map<number, OverflowWindow>()
  private readonly onDropped: ((drop: CaptureDropNotice) => void) | undefined
  private readonly onStarted: ((deviceId: number) => void) | undefined

  constructor(options: CaptureSchedulerOptions) {
    this.logger = options.logger
    this.budget = options.maxInFlightPerDevice ?? DEFAULT_MAX_IN_FLIGHT_PER_DEVICE
    this.maxQueued = Math.max(1, options.maxQueuedPerDevice ?? DEFAULT_MAX_QUEUED_PER_DEVICE)
    this.windowMs = options.logWindowMs ?? DEFAULT_LOG_WINDOW_MS
    this.now = options.now ?? Date.now
    this.onDropped = options.onDropped
    this.onStarted = options.onStarted
  }

  /** Report one request that began executing (never throws into the pump). */
  private noteStarted(deviceId: number): void {
    if (this.onStarted === undefined) return
    try {
      this.onStarted(deviceId)
    } catch {
      /* an observer must never break scheduling */
    }
  }

  /** Report one dropped-without-exec entry (never throws into the pump). */
  private noteDropped(deviceId: number, entry: QueuedCapture, cause: 'stale' | 'overflow'): void {
    if (this.onDropped === undefined) return
    try {
      this.onDropped({
        deviceId,
        ...(entry.trackId !== undefined ? { trackId: entry.trackId } : {}),
        kind: entry.kind,
        cause,
      })
    } catch {
      /* an observer must never break scheduling */
    }
  }

  /**
   * Schedule a capture. Under budget the exec starts SYNCHRONOUSLY (identical
   * to the pre-S3 direct call); over budget it queues by priority. Returns the
   * exec's promise, the joined in-flight promise (coalesce hit), or `null`
   * when the request was dropped (stale) or cancelled (track closed).
   */
  request<T>(input: CaptureRequestInput<T>): Promise<T | null> {
    this.bump(input.deviceId, 'requested')
    if (input.coalesceKey !== undefined) {
      const existing = this.coalesced.get(input.coalesceKey)
      if (existing !== undefined) {
        this.bump(input.deviceId, 'coalesced')
        // Documented type boundary: every requester of one coalesceKey shares
        // the same (device, kind, track) capture and therefore the same result
        // type by construction; the shared map erases T.
        return existing as Promise<T | null>
      }
    }
    const lane = this.lane(input.deviceId)
    const promise: Promise<T | null> =
      lane.inFlight < this.budget ? this.start(lane, input) : this.enqueue(lane, input)
    this.acquireKeys(input, promise)
    promise.then(
      () => this.releaseKeys(input),
      () => this.releaseKeys(input),
    )
    return promise
  }

  /** True while ANY queued/running request coalesces on or holds `key` — the
   *  demand-side gate that replaced the per-track in-flight flag reads. */
  isKeyActive(key: string): boolean {
    return this.coalesced.has(key) || (this.heldKeys.get(key) ?? 0) > 0
  }

  /**
   * Drop every QUEUED request of a closed track (each resolves `null`, exec
   * never runs). RUNNING execs are never interrupted — they settle and release
   * their budget slot / keys normally. Returns the number cancelled.
   */
  cancelForTrack(trackId: string): number {
    let cancelled = 0
    for (const [deviceId, lane] of this.lanes) {
      for (let i = lane.queue.length - 1; i >= 0; i -= 1) {
        const entry = lane.queue[i]
        if (entry === undefined || entry.trackId !== trackId) continue
        lane.queue.splice(i, 1)
        this.bump(deviceId, 'cancelled')
        entry.drop()
        cancelled += 1
      }
    }
    return cancelled
  }

  /** Drop ALL queued requests and reset lanes/keys/windows (addon dispose).
   *  Running execs settle against their captured lane objects harmlessly. */
  clear(): void {
    for (const [deviceId, lane] of this.lanes) {
      for (const entry of lane.queue.splice(0, lane.queue.length)) {
        this.bump(deviceId, 'cancelled')
        entry.drop()
      }
    }
    this.lanes.clear()
    this.coalesced.clear()
    this.heldKeys.clear()
    this.windows.clear()
    // The shed accumulator too: carrying it across a dispose would attribute a
    // previous incarnation's losses to the first shed of the next one.
    this.overflowWindows.clear()
  }

  /** Snapshot of the CURRENT window's counters (tests/ops introspection). */
  counters(deviceId: number): CaptureSchedulerCounters | undefined {
    const w = this.windows.get(deviceId)
    if (w === undefined) return undefined
    return {
      requested: w.requested,
      started: w.started,
      completed: w.completed,
      failed: w.failed,
      coalesced: w.coalesced,
      droppedStale: w.droppedStale,
      droppedOverflow: w.droppedOverflow,
      cancelled: w.cancelled,
      maxQueueDepth: w.maxQueueDepth,
    }
  }

  /** Current queue depth for a device (0 when idle). */
  queueDepth(deviceId: number): number {
    return this.lanes.get(deviceId)?.queue.length ?? 0
  }

  /** Currently running execs for a device. */
  inFlight(deviceId: number): number {
    return this.lanes.get(deviceId)?.inFlight ?? 0
  }

  // ── Internals ────────────────────────────────────────────────────────

  private lane(deviceId: number): DeviceLane {
    const existing = this.lanes.get(deviceId)
    if (existing !== undefined) return existing
    const created: DeviceLane = { inFlight: 0, queue: [] }
    this.lanes.set(deviceId, created)
    return created
  }

  /** Reserve a budget slot and invoke exec SYNCHRONOUSLY. */
  private start<T>(lane: DeviceLane, input: CaptureRequestInput<T>): Promise<T | null> {
    lane.inFlight += 1
    this.bump(input.deviceId, 'started')
    this.noteStarted(input.deviceId)
    const settle = (): void => {
      lane.inFlight -= 1
      this.pump(input.deviceId, lane)
    }
    let result: Promise<T>
    try {
      result = input.exec()
    } catch (err) {
      this.bump(input.deviceId, 'failed')
      settle()
      return Promise.reject(err)
    }
    return result.then(
      (value) => {
        this.bump(input.deviceId, 'completed')
        settle()
        return value
      },
      (err: unknown) => {
        this.bump(input.deviceId, 'failed')
        settle()
        throw err
      },
    )
  }

  /**
   * Queue an over-budget request (priority-ordered, FIFO within priority),
   * under a BOUND enforced here rather than at dequeue.
   *
   * ## Why the queue needs its own bound
   *
   * `staleAfterMs` is evaluated in {@link pump}, and `pump` only touches the
   * queue while `inFlight < budget`. A lane that stays saturated therefore
   * never inspects its queue at all — nothing expires, nothing is shed, and the
   * queue grows for as long as the pressure lasts. The budget bounds concurrent
   * WORK; it has never bounded queued work.
   *
   * That gap is not theoretical: the per-frame batch dispatch PINS a ~0.7 MB
   * copy of the detection frame BEFORE queueing (so ring recycling cannot
   * invalidate it), and the queued closure holds that copy alive. Measured on
   * the live hub, `hub/pipeline-analytics` ran at rss=3911MB with heapUsed only
   * 153MB and arrayBuffers=2281MB — 2.28 GB of JS-reachable Buffers, roughly
   * 3 200 pinned frames, in a runner whose heap limit is 1216 MB. The call site
   * that pins them says the cost is "bounded by the lane"; it was not.
   *
   * Two things happen on the way in, in this order:
   *
   *  1. **expire what is already dead.** Entries past their `staleAfterMs` are
   *     dropped now. They were doomed the moment they expired; `pump` simply
   *     never got to look. This is the reclaim that costs nothing.
   *  2. **shed the least important.** Still over the cap, the TAIL goes — the
   *     queue is ordered by priority, so the tail is by construction the work
   *     this scheduler already ranked last. Whether that is the newcomer or an
   *     older low-priority entry is decided by the same ordering that decides
   *     execution, so a `firstFrame` never loses its place to an `embed`.
   */
  private enqueue<T>(lane: DeviceLane, input: CaptureRequestInput<T>): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
      const entry: QueuedCapture = {
        trackId: input.trackId,
        kind: input.kind,
        priority: input.priority ?? DEFAULT_CAPTURE_PRIORITY[input.kind],
        enqueuedAt: this.now(),
        staleAfterMs: input.staleAfterMs,
        start: () => {
          this.start(lane, input).then(resolve, reject)
        },
        drop: () => resolve(null),
      }
      this.dropExpired(input.deviceId, lane)
      this.insertByPriority(lane, entry)
      this.shedToCap(input.deviceId, lane)
      const w = this.window(input.deviceId)
      if (lane.queue.length > w.maxQueueDepth) w.maxQueueDepth = lane.queue.length
    })
  }

  /**
   * Drop every queued entry already past its `staleAfterMs`.
   *
   * An entry without one is never expired here — and that is a real hazard, not
   * a convenience: combined with {@link insertByPriority} + {@link shedToCap},
   * an unexpirable entry near the HEAD makes a saturated lane unrecoverable,
   * because every later arrival lands at the tail and is shed on admission.
   * `confirm` was the case that bit (see the `fetchCrop` note in
   * `pipeline-analytics/index.ts`); `keyFrame` is the one kind that still omits
   * a deadline, and it may, because nothing abandons it — a late keyFrame can
   * still be served from the worker's scene-tile store and lands for real.
   */
  private dropExpired(deviceId: number, lane: DeviceLane): void {
    const nowMs = this.now()
    for (let i = lane.queue.length - 1; i >= 0; i -= 1) {
      const entry = lane.queue[i]
      if (entry === undefined) continue
      if (entry.staleAfterMs === undefined || nowMs - entry.enqueuedAt <= entry.staleAfterMs) {
        continue
      }
      lane.queue.splice(i, 1)
      this.bump(deviceId, 'droppedStale')
      this.noteDropped(deviceId, entry, 'stale')
      entry.drop()
    }
  }

  /**
   * Shed from the tail (lowest priority, newest within it) until the lane is at
   * its cap. Loud: a capture that is dropped rather than merely late is a
   * missing thumbnail or first frame, and silence would read as "never asked".
   *
   * The warn is throttled but its `shed` count is NOT the throttled call's — it
   * is every entry shed since the last line. See {@link OverflowWindow}.
   */
  private shedToCap(deviceId: number, lane: DeviceLane): void {
    let shed = 0
    while (lane.queue.length > this.maxQueued) {
      const victim = lane.queue.pop()
      if (victim === undefined) break
      this.bump(deviceId, 'droppedOverflow')
      this.noteDropped(deviceId, victim, 'overflow')
      victim.drop()
      shed += 1
    }
    if (shed === 0) return
    const nowMs = this.now()
    const window = this.overflowWindow(deviceId, nowMs)
    window.shed += shed
    if (nowMs - window.lastWarnAt < OVERFLOW_WARN_THROTTLE_MS) return
    const reported = window.shed
    const sinceMs = window.sinceMs
    window.shed = 0
    window.sinceMs = nowMs
    window.lastWarnAt = nowMs
    this.logger.warn('capture queue full — shedding the lowest-priority captures for this camera', {
      tags: { deviceId },
      meta: {
        shed: reported,
        // Without the span the count is unreadable: 387 shed is a catastrophe
        // over one minute and unremarkable over an hour.
        windowSec: Math.round((nowMs - sinceMs) / 1000),
        cap: this.maxQueued,
        queueDepth: lane.queue.length,
        // HOW MUCH OF THE LANE CAN NEVER EXPIRE. A lane that sheds while part
        // of it is unexpirable is not busy, it is WEDGED: those entries are
        // reclaimable by nothing but a dequeue that a saturated lane never
        // performs, so every arrival behind them is shed on admission for as
        // long as they sit there. It took three hours of log correlation to
        // establish that once (`confirm`, 2026-08-30); this number says it in
        // one line. A healthy shedding lane reports 0.
        unexpirable: lane.queue.reduce(
          (total, entry) => total + (entry.staleAfterMs === undefined ? 1 : 0),
          0,
        ),
        inFlight: lane.inFlight,
        budget: this.budget,
      },
    })
  }

  /** The device's shed accumulator, created on first shed. A device that has
   *  never overflowed carries no entry — and its first shed reports
   *  immediately, because the condition is new. */
  private overflowWindow(deviceId: number, nowMs: number): OverflowWindow {
    const existing = this.overflowWindows.get(deviceId)
    if (existing !== undefined) return existing
    const created: OverflowWindow = {
      sinceMs: nowMs,
      shed: 0,
      lastWarnAt: Number.NEGATIVE_INFINITY,
    }
    this.overflowWindows.set(deviceId, created)
    return created
  }

  private insertByPriority(lane: DeviceLane, entry: QueuedCapture): void {
    let index = lane.queue.length
    while (index > 0) {
      const previous = lane.queue[index - 1]
      if (previous === undefined || previous.priority <= entry.priority) break
      index -= 1
    }
    lane.queue.splice(index, 0, entry)
  }

  /** Start queued requests while budget allows, dropping stale ones. */
  private pump(deviceId: number, lane: DeviceLane): void {
    while (lane.inFlight < this.budget && lane.queue.length > 0) {
      const entry = lane.queue.shift()
      if (entry === undefined) return
      if (entry.staleAfterMs !== undefined && this.now() - entry.enqueuedAt > entry.staleAfterMs) {
        this.bump(deviceId, 'droppedStale')
        this.noteDropped(deviceId, entry, 'stale')
        entry.drop()
        continue
      }
      entry.start()
    }
  }

  private acquireKeys<T>(input: CaptureRequestInput<T>, promise: Promise<T | null>): void {
    if (input.coalesceKey !== undefined) this.coalesced.set(input.coalesceKey, promise)
    for (const key of input.holdKeys ?? []) {
      this.heldKeys.set(key, (this.heldKeys.get(key) ?? 0) + 1)
    }
  }

  private releaseKeys<T>(input: CaptureRequestInput<T>): void {
    if (input.coalesceKey !== undefined) this.coalesced.delete(input.coalesceKey)
    for (const key of input.holdKeys ?? []) {
      const count = this.heldKeys.get(key)
      if (count === undefined) continue
      if (count <= 1) this.heldKeys.delete(key)
      else this.heldKeys.set(key, count - 1)
    }
  }

  private window(deviceId: number): MetricsWindow {
    const existing = this.windows.get(deviceId)
    if (existing !== undefined) return existing
    const created: MetricsWindow = {
      sinceMs: this.now(),
      requested: 0,
      started: 0,
      completed: 0,
      failed: 0,
      coalesced: 0,
      droppedStale: 0,
      droppedOverflow: 0,
      cancelled: 0,
      maxQueueDepth: 0,
    }
    this.windows.set(deviceId, created)
    return created
  }

  /** Bump one counter; opportunistically flush the device's window once the
   *  log interval elapsed (MediaCaptureLogAggregator idiom — no timer). */
  private bump(deviceId: number, counter: CaptureCounter): void {
    const w = this.window(deviceId)
    w[counter] += 1
    const nowMs = this.now()
    if (nowMs - w.sinceMs < this.windowMs) return
    this.windows.delete(deviceId)
    this.logger.info('capture scheduler (window)', {
      tags: { deviceId },
      meta: {
        windowSec: Math.round((nowMs - w.sinceMs) / 1000),
        requested: w.requested,
        started: w.started,
        completed: w.completed,
        failed: w.failed,
        coalesced: w.coalesced,
        droppedStale: w.droppedStale,
        droppedOverflow: w.droppedOverflow,
        cancelled: w.cancelled,
        maxQueueDepth: w.maxQueueDepth,
        queueDepth: this.queueDepth(deviceId),
        inFlight: this.inFlight(deviceId),
      },
    })
  }
}
