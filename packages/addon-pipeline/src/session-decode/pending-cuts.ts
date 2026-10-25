/**
 * The WRITE GAP between a frame's tile cut and the stores that answer for it —
 * and the bounded wait that closes it.
 *
 * ## What this exists to fix
 *
 * `handleCutTiles` runs at the instant the frame's `FrameResult` arrives
 * (measured e2e delivery→result: 66 ms avg, 125 ms p95). It finds the frame,
 * reads every subject's pixels in ONE synchronous turn — and only then awaits
 * N JPEG encodes before `tileStore.put` / `sceneStore.put`. A native-crop
 * request landing inside that window consults two empty stores and is told
 * `frame N released and no retained tile for this frame`, which is the SAME
 * sentence a frame that was never cut gets.
 *
 * That ambiguity is why one wire word (`worker-lease-gone`) covered two
 * unrelated failures. The measurement that separated them (2026-09-07, live
 * cluster) is a cross-camera one: the miss rate is FLAT at 14–38% across
 * cameras whose detection-bearing fraction spans 3.7%–99.7%. `dev:102` cuts a
 * tile on 99.7% of its inferred frames and still misses 19.5% — on that camera
 * "no retained tile for this frame" cannot mean "never cut". Misses onset at
 * ~100 ms (0.1% below that) and peak at 500–1000 ms, i.e. on the encode window,
 * not on any lifetime.
 *
 * ## Why a wait and not a bigger budget
 *
 * Nothing here is expiring: `holdOverflow` is 0 on every sampled session and
 * the subject store uses ~5 MB of its 64 MB. The pixels are not gone, they are
 * not written yet. Widening a retention window cannot move a request that is
 * EARLY, which is the trap this module is deliberately not falling into.
 *
 * ## The two properties that make waiting safe
 *
 * A crop is best-effort, so a waiter must never be able to wedge:
 *  - the cut settles in the worker's `finally`, so a THROWING encode still
 *    releases every waiter — it simply never wrote a tile;
 *  - a cut that never settles at all (a wedged encode, a worker mid-teardown)
 *    is abandoned by the WAITER at {@link PendingCutsOptions.waitMs}. The entry
 *    stays in flight on purpose: a timeout is the waiter giving up, never this
 *    module declaring the cut dead.
 *
 * Pure: no node-av, no IPC, no pixels — so both properties are unit-testable.
 */

/** What waiting on a frame's in-flight cut produced. */
export type PendingCutWait =
  /** No cut was in flight for this frame — nothing to wait for. */
  | 'none'
  /** The cut completed (or was cleared) while we waited. */
  | 'settled'
  /** The bound elapsed first; the cut is still in flight. */
  | 'timeout'

/** Constructor options for {@link PendingCuts}. */
export interface PendingCutsOptions {
  /**
   * How long a native-crop request will wait for an in-flight cut.
   *
   * Deliberately modest. A miss held too long stops being a fast, retryable
   * `null` and becomes an upstream TIMEOUT: the confirmation gate bounds each
   * crop attempt at 300 ms and the capture scheduler drops an enrichment
   * request older than 3 s. The bound wants to cover the encode window and
   * nothing more — widen it only once `cutLatencyMs` on the metrics line says
   * what that window actually is.
   */
  readonly waitMs: number
  /** Injectable clock (tests). Defaults to `Date.now`. */
  readonly now?: () => number
  /** How many recent cut latencies the percentiles are computed over. */
  readonly latencySamples?: number
}

/** Default number of recent cut latencies kept for the percentile report. */
export const DEFAULT_CUT_LATENCY_SAMPLES = 256

/** One cut in flight: when it started, and how a waiter learns it finished. */
interface InFlightCut {
  readonly startedAt: number
  readonly done: Promise<void>
  readonly finish: () => void
}

/**
 * The set of tile cuts currently between "I have this frame's pixels" and
 * "the stores can answer for it", plus the latency of the ones that finished.
 */
export class PendingCuts {
  private readonly waitMs: number
  private readonly now: () => number
  private readonly latencySampleCap: number
  private readonly cuts = new Map<number, InFlightCut>()
  /** Insertion-ordered ring of completed cut latencies (ms). */
  private readonly latencies: number[] = []

  constructor(options: PendingCutsOptions) {
    this.waitMs = Math.max(0, options.waitMs)
    this.now = options.now ?? Date.now
    this.latencySampleCap = Math.max(1, options.latencySamples ?? DEFAULT_CUT_LATENCY_SAMPLES)
  }

  /** Cuts currently in flight (tests / metrics). */
  get inFlight(): number {
    return this.cuts.size
  }

  /**
   * A cut for `frameId` has started. Call BEFORE the first `await` in the cut,
   * so no request can observe the gap this module exists to cover.
   *
   * A duplicate id should never occur (frame ids are monotonic); settling the
   * prior entry rather than replacing it keeps any waiter on it from hanging.
   */
  begin(frameId: number): void {
    this.settle(frameId)
    let finish = (): void => {}
    const done = new Promise<void>((resolve) => {
      finish = resolve
    })
    this.cuts.set(frameId, { startedAt: this.now(), done, finish })
  }

  /**
   * The cut for `frameId` is over — the stores now hold whatever it produced.
   * Call from the cut's `finally`, so a throwing encode releases waiters too.
   * Idempotent.
   */
  settle(frameId: number): void {
    const cut = this.cuts.get(frameId)
    if (!cut) return
    this.cuts.delete(frameId)
    this.noteLatency(this.now() - cut.startedAt)
    cut.finish()
  }

  /**
   * Wait for `frameId`'s cut to land, bounded.
   *
   * `none` means there was nothing in flight, and the caller must NOT read that
   * as "wait exhausted" — it is the ordinary answer for a frame whose cut has
   * already finished or never ran.
   */
  async waitFor(frameId: number): Promise<PendingCutWait> {
    const cut = this.cuts.get(frameId)
    if (!cut) return 'none'
    if (this.waitMs === 0) return 'timeout'
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.waitMs)
      // Never hold the event loop open for a best-effort crop.
      timer.unref?.()
    })
    try {
      return await Promise.race([cut.done.then((): PendingCutWait => 'settled'), expired])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Release every waiter and forget every in-flight cut — re-dial and teardown.
   * A waiter left behind here would outlive the worker that could settle it.
   */
  clear(): void {
    for (const cut of this.cuts.values()) cut.finish()
    this.cuts.clear()
  }

  /**
   * The `percentile`-th cut latency in ms over the retained samples, or `null`
   * when nothing has completed yet. `null` rather than 0: a worker that has cut
   * nothing and a worker that cuts instantly must not read the same.
   */
  latencyMs(percentile: number): number | null {
    if (this.latencies.length === 0) return null
    const sorted = [...this.latencies].sort((a, b) => a - b)
    const clamped = Math.min(100, Math.max(0, percentile))
    const index = Math.min(sorted.length - 1, Math.ceil((clamped / 100) * sorted.length) - 1)
    return sorted[Math.max(0, index)] ?? null
  }

  private noteLatency(ms: number): void {
    this.latencies.push(Math.max(0, ms))
    while (this.latencies.length > this.latencySampleCap) this.latencies.shift()
  }
}

/** What a tile-store serve needs from its caller, so the sequence stays pure. */
export interface TileServeSource<T> {
  /** Is anything retained for this frame RIGHT NOW (cheap, synchronous)? */
  hasRetained(): boolean
  /** Cut the requested rectangle out of whatever is retained, or `null`. */
  serve(): Promise<T | null>
}

/** The outcome of one tile-tier serve, with what the wait contributed. */
export interface TileServeAttempt<T> {
  readonly served: T | null
  readonly wait: PendingCutWait
  /**
   * The serve produced pixels ONLY because we waited for an in-flight cut —
   * i.e. this request would have been a miss before this module existed. This
   * is the counter that makes the whole write-gap hypothesis falsifiable: if it
   * stays near zero, the misses were never a timing race and the answer lies in
   * which frames get cut at all.
   */
  readonly resolvedByWait: boolean
}

/**
 * Serve a frame's retained tiles, waiting for an in-flight cut ONLY when
 * waiting could change the answer.
 *
 * The order is the whole point. Anything already retained is served at once —
 * a cut in flight for a LATER subject of the same frame must not delay a
 * request the stores can already answer. Only an empty store consults
 * {@link PendingCuts}, and only then is a success attributable to the wait.
 */
export async function attemptTileServe<T>(
  pending: PendingCuts,
  frameId: number,
  source: TileServeSource<T>,
): Promise<TileServeAttempt<T>> {
  if (source.hasRetained()) {
    return { served: await source.serve(), wait: 'none', resolvedByWait: false }
  }
  const wait = await pending.waitFor(frameId)
  const served = await source.serve()
  return { served, wait, resolvedByWait: served !== null && wait === 'settled' }
}
