/**
 * Pure, side-effect-free coalescing / stale-while-revalidate / bounded-pool
 * primitives for the snapshot wrapper.
 *
 * These are extracted from `SnapshotAddon` so the decision logic is unit-testable
 * without instantiating the addon (no camera, no ffmpeg, no tRPC). The addon wires
 * them to its cache + ladder; this module owns only the mechanics:
 *
 *   - {@link decideSnapshotServe} — the pure serve/refresh decision (fresh cache vs
 *     stale-while-revalidate vs cold blocking capture) keyed off the cached frame
 *     age, the per-device max-age, and whether the caller forced a refresh.
 *   - {@link Semaphore} — a counting semaphore bounding concurrent grabs.
 *   - {@link SingleFlight} — de-dupes concurrent captures for the same key and
 *     retains a SETTLED success for a short hold window so a mount burst collapses
 *     into one capture.
 *   - {@link raceForResult} — races a promise against a wait bound without
 *     cancelling the promise (the loser keeps running in the background).
 */

// -- Tunables ----------------------------------------------------------

/**
 * Retain a SETTLED single-flight capture this long so a grid-mount burst of
 * `getSnapshot` calls (and a row of refresh buttons) collapses into ONE capture
 * instead of one dial per tile. Only success outcomes are held — a null/failed
 * capture expires immediately so a transiently-unreachable camera is retried on
 * the next call rather than pinned blank for the window.
 */
export const COALESCE_MS = 4_000

/**
 * Stale-while-revalidate: when a cached frame exists but is past its max-age,
 * start the refresh and wait at most this long for it to land before returning
 * the STALE frame (the refresh keeps running and populates the cache for the
 * next poll). Keeps a grid mount painting instantly from cache.
 */
export const SWR_STALE_WAIT_MS = 2_500

/**
 * Cold path (no cached frame) or a forced refresh: wait up to this long for a
 * fresh capture. On a cold miss there is nothing to fall back to, so we block
 * (bounded) on the capture; on a forced refresh with a stale frame available we
 * still prefer a fresh one but cap the wait, falling back to stale on timeout.
 */
export const SWR_COLD_WAIT_MS = 10_000

/**
 * Max simultaneous ffmpeg keyframe grabs — the WRAPPER path, the common case for
 * cameras with no vendor snapshot URL. A 20-cam grid mount spawns at most this
 * many ffmpeg processes; the rest serve cached frames (SWR) or queue.
 *
 * Raised 3 → 6 on 2026-08-12 (operator): a 17-camera cold start serialised
 * into 6 waves and the client-side "image displayed" clustering matched the
 * pool exactly (p90 10.8 s). Measured client-side after the raise — if the
 * hub shows decode pressure, this is the first knob to lower.
 */
export const MAX_CONCURRENT_GRABS = 6

/**
 * Max simultaneous cheap native snapshot fetches (vendor HTTP/ONVIF). Higher than
 * the ffmpeg bound because a native fetch is a lightweight HTTP round-trip, not a
 * decode pipeline.
 */
export const MAX_CONCURRENT_NATIVE = 6

// -- Serve decision ----------------------------------------------------

/**
 * Serve either the fresh cache directly, or start/join a refresh and wait a
 * bounded time. `await-refresh` always runs (or joins) the single flight;
 * `waitMs` bounds how long the caller waits before, when `staleFallback` is set
 * and a cached frame exists, returning the stale frame while the refresh
 * continues in the background.
 */
export type SnapshotServeDecision =
  | { readonly kind: 'serve-cache' }
  | { readonly kind: 'await-refresh'; readonly waitMs: number; readonly staleFallback: boolean }

export interface SnapshotServeInputs {
  readonly now: number
  /** Epoch ms of the cached frame, or null when nothing is cached. */
  readonly cachedAt: number | null
  /** Effective per-device max cache age in ms (battery-aware default or override). */
  readonly effectiveMaxAgeMs: number
  /** Caller forced a refresh (UI refresh button) — bypass the freshness gate. */
  readonly force: boolean
}

/**
 * Pure serve/refresh decision.
 *
 *   - fresh cache + !force            -> serve-cache
 *   - stale cache + !force            -> SWR: wait SWR_STALE_WAIT_MS, then stale
 *   - no cache   + !force             -> cold: wait SWR_COLD_WAIT_MS, no fallback
 *   - force (cache present or not)    -> prefer fresh: wait SWR_COLD_WAIT_MS,
 *                                       fall back to stale only if a frame exists
 */
export function decideSnapshotServe(input: SnapshotServeInputs): SnapshotServeDecision {
  const { now, cachedAt, effectiveMaxAgeMs, force } = input
  const hasFrame = cachedAt !== null
  const fresh = hasFrame && now - cachedAt < effectiveMaxAgeMs
  if (!force && fresh) return { kind: 'serve-cache' }
  if (force) return { kind: 'await-refresh', waitMs: SWR_COLD_WAIT_MS, staleFallback: hasFrame }
  if (hasFrame) return { kind: 'await-refresh', waitMs: SWR_STALE_WAIT_MS, staleFallback: true }
  return { kind: 'await-refresh', waitMs: SWR_COLD_WAIT_MS, staleFallback: false }
}

// -- Bounded concurrency -----------------------------------------------

/**
 * A counting semaphore. `run` acquires a permit, awaits `fn`, and releases the
 * permit (even if `fn` throws), so at most `max` `fn`s run concurrently. Waiters
 * are served FIFO.
 */
export class Semaphore {
  private available: number
  private readonly waiters: Array<() => void> = []

  constructor(max: number) {
    if (!Number.isInteger(max) || max < 1) {
      throw new Error(`Semaphore max must be a positive integer, got ${String(max)}`)
    }
    this.available = max
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  private async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1
      return this.makeReleaser()
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve))
    // Resolved by a releaser that handed its permit straight over — no
    // decrement here (the permit was never returned to the pool).
    return this.makeReleaser()
  }

  private makeReleaser(): () => void {
    let released = false
    return () => {
      if (released) return
      released = true
      const next = this.waiters.shift()
      if (next) {
        next() // hand the permit to the next waiter; available stays put
        return
      }
      this.available += 1
    }
  }
}

// -- Single-flight with hold window ------------------------------------

/**
 * One in-flight capture per key. A settled SUCCESS is retained for `holdMs` so a
 * burst collapses into one capture; a settled failure/empty expires immediately
 * so the next caller retries. Concurrent callers ALWAYS join the running flight
 * regardless of eventual outcome.
 */
class Flight<T> {
  readonly promise: Promise<T>
  settledAt: number | null = null
  hold = false

  constructor(factory: () => Promise<T>, now: () => number, holdWorthy: (value: T) => boolean) {
    this.promise = (async () => {
      try {
        const value = await factory()
        this.hold = holdWorthy(value)
        return value
      } catch (err) {
        this.hold = false
        throw err
      } finally {
        this.settledAt = now()
      }
    })()
  }
}

export class SingleFlight<T> {
  private readonly flights = new Map<string, Flight<T>>()

  /**
   * @param holdMs      how long a settled hold-worthy result is reused
   * @param holdWorthy  predicate deciding whether a settled value is worth holding
   *                    (e.g. a successful capture with a real frame)
   * @param now         clock injection for tests
   */
  constructor(
    private readonly holdMs: number,
    private readonly holdWorthy: (value: T) => boolean,
    // NB: wrap rather than capture `Date.now` by reference — a captured
    // reference resolves to the real clock even under a Date mock (vitest
    // fake timers), which would freeze the hold window in tests.
    private readonly now: () => number = () => Date.now(),
  ) {}

  run(key: string, factory: () => Promise<T>): Promise<T> {
    const existing = this.flights.get(key)
    if (existing && this.isReusable(existing)) return existing.promise
    const flight = new Flight<T>(factory, this.now, this.holdWorthy)
    this.flights.set(key, flight)
    return flight.promise
  }

  /** Drop every held flight whose key starts with `prefix` (e.g. `"<deviceId>:"`). */
  invalidatePrefix(prefix: string): void {
    for (const key of [...this.flights.keys()]) {
      if (key.startsWith(prefix)) this.flights.delete(key)
    }
  }

  clear(): void {
    this.flights.clear()
  }

  private isReusable(flight: Flight<T>): boolean {
    if (flight.settledAt === null) return true // still running — always join
    if (!flight.hold) return false // settled but not hold-worthy — retry
    return this.now() - flight.settledAt < this.holdMs
  }
}

// -- Bounded wait ------------------------------------------------------

export type RaceOutcome<T> =
  | { readonly settled: true; readonly value: T }
  | { readonly settled: false }

/**
 * Race `promise` against a `timeoutMs` bound WITHOUT cancelling it — on timeout
 * the promise keeps running (its result lands in the cache for the next poll).
 * Rejections propagate: if `promise` rejects before the timeout, this rejects.
 * The caller passes a promise that never rejects (a settled outcome union) when
 * background continuation must stay unhandled-safe.
 */
export function raceForResult<T>(promise: Promise<T>, timeoutMs: number): Promise<RaceOutcome<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<RaceOutcome<T>>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs)
  })
  const settled = promise.then((value): RaceOutcome<T> => ({ settled: true, value }))
  return Promise.race([settled, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}
