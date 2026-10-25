/**
 * Paced replay scheduler for source-RTP pre-buffer bursts.
 *
 * Shared by BOTH join paths — the WebRTC session (`webrtc/session.ts`) and the
 * RTSP restreamer (`rtsp/rtsp-restreamer.ts`). It lives here, above both, on
 * purpose: the RTSP path spent months blasting its burst synchronously while
 * the identical failure was already described and fixed one directory over.
 * A second pacer is how the two diverged; there is one.
 *
 * The broker's "instant start" replays the buffered GOP (from the most recent
 * keyframe) into a freshly-connected session. Blasting that burst in
 * one synchronous loop (651–2273 packets, ~0.8–2.7 MB measured live) overruns
 * the peer's socket/jitter buffers — packets dropped mid-burst leave the
 * decoder without a complete GOP, so nothing renders until the camera's NEXT
 * live IDR (2–4.5 s later, one full GOP interval). Spreading the same burst
 * over a few hundred milliseconds is imperceptible to the viewer but survives
 * phone/4G socket buffers.
 *
 * Design:
 *  - The first chunk is sent synchronously in `start()` so the bootstrap
 *    begins on the triggering packet, exactly like the old code.
 *  - Subsequent chunks go out on a short timer cadence (default 5 ms) and
 *    never block the event loop.
 *  - Chunk size scales with burst size targeting a full replay within
 *    ~250–400 ms; tiny bursts (≤ `singleShotMax`) stay single-shot.
 *  - LIVE packets arriving while the replay is in flight are appended to the
 *    tail via `enqueue()` — total packet order is preserved (replay first,
 *    then live), which the old synchronous burst guaranteed implicitly.
 *  - `abort()` cancels the pending timer (session close / source rebind). It is
 *    safe to call from INSIDE `send` — the RTSP path aborts there when the
 *    peer's socket backlogs mid-burst — and the current chunk stops at once.
 *
 * Pure scheduling logic — no werift/session dependency — so the chunking and
 * abort behaviour is unit-testable in isolation (timer injectable).
 */

export interface PacedReplayTuning {
  /** Bursts at or below this size are sent synchronously in one shot. */
  readonly singleShotMax: number
  /** Delay between paced chunk sends (ms). */
  readonly tickMs: number
  /** Target wall-clock duration for draining the initial burst (ms). */
  readonly targetDurationMs: number
  /** Never send fewer than this many packets per tick (keeps small-medium
   *  bursts snappy instead of stretching them to the full target window). */
  readonly minChunkSize: number
  /** Never send more than this many packets per tick — the per-tick cap is
   *  what protects the peer's socket buffers, so huge bursts trade a slight
   *  duration overrun for a bounded instantaneous rate. */
  readonly maxChunkSize: number
}

export const PACED_REPLAY_DEFAULTS: PacedReplayTuning = {
  singleShotMax: 64,
  tickMs: 5,
  targetDurationMs: 300,
  minChunkSize: 32,
  maxChunkSize: 128,
}

type CancelTimer = () => void
type ScheduleTimer = (fn: () => void, ms: number) => CancelTimer

const defaultSchedule: ScheduleTimer = (fn, ms) => {
  const t = setTimeout(fn, ms)
  return () => clearTimeout(t)
}

export interface PacedReplayOptions {
  readonly tuning?: Partial<PacedReplayTuning>
  /** Injectable timer for tests. Must return a cancel function. */
  readonly schedule?: ScheduleTimer
  /** Injectable clock for tests. */
  readonly now?: () => number
}

export interface PacedReplayStats {
  /** Size of the initial replay burst. */
  readonly packets: number
  /** Live packets appended mid-replay via `enqueue()`. */
  readonly enqueuedLive: number
  /** Packets for which `send` returned true. */
  readonly sent: number
  /** Number of chunk sends performed (including the synchronous first). */
  readonly chunks: number
  /** Packets per tick used for this burst. */
  readonly chunkSize: number
  /** Wall-clock ms from `start()` to completion/abort. */
  readonly durationMs: number
  readonly aborted: boolean
}

/**
 * Compute the per-tick chunk size for a burst of `total` packets: enough to
 * drain within `targetDurationMs` at one chunk per `tickMs`, clamped to
 * [minChunkSize, maxChunkSize]. Bursts ≤ `singleShotMax` are one chunk.
 */
export function computeReplayChunkSize(total: number, tuning: PacedReplayTuning): number {
  if (total <= tuning.singleShotMax) return Math.max(total, 1)
  const maxTicks = Math.max(1, Math.floor(tuning.targetDurationMs / tuning.tickMs))
  const ideal = Math.ceil(total / maxTicks)
  return Math.min(tuning.maxChunkSize, Math.max(tuning.minChunkSize, ideal))
}

/**
 * One in-flight paced replay. Create per burst; not reusable after
 * completion or abort.
 */
export class PacedRtpReplay<T> {
  private readonly send: (item: T) => boolean
  private readonly onDone: (stats: PacedReplayStats) => void
  private readonly tuning: PacedReplayTuning
  private readonly schedule: ScheduleTimer
  private readonly now: () => number

  private queue: T[] = []
  private cancelTimer: CancelTimer | null = null
  private started = false
  private finished = false
  private startedAt = 0
  private chunkSize = 0
  private initialPackets = 0
  private enqueuedLive = 0
  private sentCount = 0
  private chunkCount = 0

  constructor(
    send: (item: T) => boolean,
    onDone: (stats: PacedReplayStats) => void,
    options?: PacedReplayOptions,
  ) {
    this.send = send
    this.onDone = onDone
    this.tuning = { ...PACED_REPLAY_DEFAULTS, ...options?.tuning }
    this.schedule = options?.schedule ?? defaultSchedule
    this.now = options?.now ?? Date.now
  }

  /** True while packets remain to be drained (live packets must be enqueued,
   *  not sent directly, to preserve order). */
  get active(): boolean {
    return this.started && !this.finished
  }

  /**
   * Begin the replay: sends the first chunk synchronously, then paces the
   * rest. Calling `start` more than once is a no-op.
   */
  start(initial: readonly T[]): void {
    if (this.started) return
    this.started = true
    this.startedAt = this.now()
    this.initialPackets = initial.length
    this.queue = [...initial]
    this.chunkSize = computeReplayChunkSize(initial.length, this.tuning)
    this.drainChunk()
  }

  /**
   * Append a live packet behind the still-queued replay tail. No-op (returns
   * false) when the replay is not active — the caller must then send the
   * packet directly.
   */
  enqueue(item: T): boolean {
    if (!this.active) return false
    this.queue.push(item)
    this.enqueuedLive++
    return true
  }

  /** Visit every still-queued item (probe time only; no allocation). */
  forEachQueued(visit: (item: T) => void): void {
    for (const item of this.queue) visit(item)
  }

  /** Cancel the replay: pending packets are dropped, `onDone` fires with
   *  `aborted: true`. Safe to call multiple times / before `start`. */
  abort(): void {
    if (this.finished) return
    // Aborting before start(): mark finished so a late start() no-ops.
    if (!this.started) {
      this.started = true
      this.startedAt = this.now()
    }
    this.finish(true)
  }

  private drainChunk(): void {
    if (this.finished) return
    this.chunkCount++
    const n = Math.min(this.chunkSize, this.queue.length)
    for (let i = 0; i < n; i++) {
      // `send` may abort us (a backlogged socket, a session that went away).
      // `finish` empties the queue, so continuing the chunk would read past
      // its end and hand `send` an undefined item.
      if (this.finished) return
      if (this.send(this.queue[i]!)) this.sentCount++
    }
    this.queue = this.queue.slice(n)
    if (this.queue.length === 0) {
      this.finish(false)
      return
    }
    this.cancelTimer = this.schedule(() => {
      this.cancelTimer = null
      this.drainChunk()
    }, this.tuning.tickMs)
  }

  private finish(aborted: boolean): void {
    if (this.finished) return
    this.finished = true
    if (this.cancelTimer) {
      this.cancelTimer()
      this.cancelTimer = null
    }
    this.queue = []
    this.onDone({
      packets: this.initialPackets,
      enqueuedLive: this.enqueuedLive,
      sent: this.sentCount,
      chunks: this.chunkCount,
      chunkSize: this.chunkSize,
      durationMs: this.now() - this.startedAt,
      aborted,
    })
  }
}
