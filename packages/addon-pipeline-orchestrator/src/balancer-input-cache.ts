/**
 * Short-TTL memo for the reads a session dispatch needs BEFORE it can choose a
 * node.
 *
 * `dispatchDetectionSession` performs five awaits purely to feed the balancer —
 * agent load (one RPC per online runner), the node cap and weight maps, and the
 * chosen node's enabled inference devices + their session caps. Measured at
 * 832 ms on the motion path, all of it inside the blind ramp between motion and
 * the first inferenced frame. None of those five answers changes meaningfully
 * inside one motion event.
 *
 * So they are read on a timer instead of on the doorbell. A dispatch that finds
 * a fresh answer reads memory; a dispatch that finds nothing cached does
 * exactly what it did before (an inline read), because a cold cache must never
 * be the reason a camera fails to dispatch. A read that THROWS with a stale
 * answer in hand returns the stale answer for the same reason — a momentarily
 * unreachable agent must not cost the whole dispatch.
 *
 * Deliberately not a general-purpose cache: no size policy beyond dropping keys
 * nobody has asked for lately, no negative caching, no cross-process sharing.
 */

import { raceBudget } from './dispatch-timing.js'

/** Default freshness window for a balancer input. */
export const DEFAULT_BALANCER_INPUT_TTL_MS = 10_000

/**
 * What {@link TtlMemo.getWithin} answered with. `stale` means the read did not
 * land inside the budget (or failed) and the LAST KNOWN value — possibly one
 * that {@link TtlMemo.invalidate} declared wrong — was served instead; `ageMs`
 * is how old that value's read is, so the line that reports it can say so.
 */
export interface MemoAnswer<V> {
  readonly value: V
  readonly stale: boolean
  readonly ageMs: number
}

/**
 * How long an unused key survives a {@link TtlMemo.refreshAll}. Keys are node
 * ids; a node that stops receiving dispatches (removed, disabled, renamed)
 * must not be re-read forever by the background refresh.
 */
const DEFAULT_IDLE_EVICT_FACTOR = 5

/** One cached answer plus the clocks that decide its fate. */
interface MemoEntry<V> {
  readonly value: V
  /** When the underlying read that produced `value` resolved. */
  readonly readAt: number
  /** When a caller last asked for this key — drives idle eviction. */
  readonly usedAt: number
}

/**
 * Why `load` is being called (D650 pre-ship): `miss` — a `get` found nothing
 * fresh and a dispatch is WAITING on the answer; `refresh` — the background
 * refresher, which nothing awaits. A read may wait for a slow node on a miss;
 * on a refresh it must be BOUNDED, or one departed node keeps a loop alive for
 * as long as its key is held (D3).
 */
export type MemoRead = 'miss' | 'refresh'

export interface TtlMemoOptions<K, V> {
  /** The real read. Called on a miss, on a stale hit (`miss`), and by the refresher (`refresh`). */
  readonly load: (key: K, read: MemoRead) => Promise<V>
  /** Freshness window. Defaults to {@link DEFAULT_BALANCER_INPUT_TTL_MS}. */
  readonly ttlMs?: number
  /** Clock seam for tests. Defaults to `Date.now`. */
  readonly now?: () => number
}

/**
 * A per-key, time-bounded memo whose miss path is the caller's original read.
 *
 * Concurrent `get`s for the same key share ONE in-flight read, so a burst of
 * cameras firing together cannot multiply the RPC fan-out that the cache exists
 * to remove.
 */
export class TtlMemo<K, V> {
  private readonly entries = new Map<K, MemoEntry<V>>()
  private readonly inFlight = new Map<K, Promise<V>>()
  /**
   * Per-key invalidation counter. A read stores its result only if the key's
   * generation is still the one it started under, so a read already in flight
   * when {@link invalidate} lands cannot resurrect the value that was just
   * declared wrong.
   */
  private readonly generations = new Map<K, number>()
  /**
   * The last value ANY read produced for a key, kept across
   * {@link invalidate}. Never served by {@link get}; it is the bounded fallback
   * of {@link getWithin} alone (D441) — a caller that would rather balance on a
   * snapshot a few seconds old than wait seconds for the re-read.
   */
  private readonly lastKnown = new Map<K, MemoEntry<V>>()
  private readonly ttlMs: number
  private readonly now: () => number

  constructor(private readonly opts: TtlMemoOptions<K, V>) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_BALANCER_INPUT_TTL_MS
    this.now = opts.now ?? Date.now
  }

  /** Number of keys currently held. Test/diagnostic seam. */
  get size(): number {
    return this.entries.size
  }

  /**
   * The value for `key`: from memory when fresh, otherwise from `load`.
   *
   * Throws only when the read fails AND nothing is cached — i.e. exactly where
   * the un-cached code threw before.
   */
  async get(key: K): Promise<V> {
    const at = this.now()
    const entry = this.entries.get(key)
    if (entry) this.entries.set(key, { ...entry, usedAt: at })
    if (entry && at - entry.readAt < this.ttlMs) return entry.value
    try {
      return await this.read(key, 'miss')
    } catch (err: unknown) {
      // A stale answer beats no dispatch. Nothing cached ⇒ the original throw.
      if (entry) return entry.value
      throw err
    }
  }

  /**
   * The value for `key` within `budgetMs`: from memory when fresh, from `load`
   * when the read lands in time, and otherwise the LAST KNOWN value —
   * invalidated or not — with its age (D441).
   *
   * Three properties, each pinned by a test:
   *  - a read that overruns the budget is NOT abandoned: it keeps running and
   *    stores its result for the next caller, so a stale answer is served at
   *    most once per read;
   *  - a COLD key waits for the read past the budget, because a cold cache must
   *    never be the reason a camera fails to dispatch (the `get` contract);
   *  - a read that FAILS with a last-known value in hand serves it as stale.
   */
  async getWithin(key: K, budgetMs: number): Promise<MemoAnswer<V>> {
    const at = this.now()
    const entry = this.entries.get(key)
    if (entry) this.entries.set(key, { ...entry, usedAt: at })
    if (entry && at - entry.readAt < this.ttlMs) {
      return { value: entry.value, stale: false, ageMs: at - entry.readAt }
    }
    const fallback = this.lastKnown.get(key)
    const pending = this.read(key, 'miss')
    if (fallback === undefined) {
      return { value: await pending, stale: false, ageMs: 0 }
    }
    const outcome = await raceBudget(pending, budgetMs)
    if (outcome.kind === 'settled') return { value: outcome.value, stale: false, ageMs: 0 }
    return { value: fallback.value, stale: true, ageMs: this.now() - fallback.readAt }
  }

  /**
   * Declare the cached answer for `key` WRONG — not merely old.
   *
   * The caller has just changed the thing being cached (an attach or a detach
   * moves agent load), so freshness is no longer the question: the value is
   * known to be out of date and must never be served, however recently it was
   * read. The next `get` reads through, and a read already in flight is
   * abandoned rather than allowed to store a pre-change answer.
   */
  invalidate(key: K): void {
    this.entries.delete(key)
    this.inFlight.delete(key)
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1)
  }

  /**
   * Force a read for `key`, discarding the result on failure. For the
   * background refresher — never awaited by a dispatch, never throws. Unlike
   * {@link refreshAll} this populates a key that is not currently held, which
   * is what re-warms a key immediately after {@link invalidate}.
   */
  async refresh(key: K): Promise<void> {
    await this.read(key, 'refresh').catch(() => undefined)
  }

  /**
   * Re-read every key still in use and drop the ones nobody has asked for in
   * `idleFactor × ttl`. Never throws.
   */
  async refreshAll(): Promise<void> {
    const at = this.now()
    const idleLimit = this.ttlMs * DEFAULT_IDLE_EVICT_FACTOR
    const keys: K[] = []
    for (const [key, entry] of this.entries) {
      if (at - entry.usedAt >= idleLimit) {
        this.entries.delete(key)
        continue
      }
      keys.push(key)
    }
    await Promise.all(keys.map((key) => this.refresh(key)))
  }

  /** Drop everything — used on shutdown so no stale state survives. */
  clear(): void {
    this.entries.clear()
    this.inFlight.clear()
    this.generations.clear()
    this.lastKnown.clear()
  }

  /**
   * One shared in-flight read per key; stores the result on success. A
   * refresh that finds a miss's read in flight joins it — the waiting caller
   * chose to wait, and the refresher never awaits the promise it is handed.
   */
  private read(key: K, mode: MemoRead): Promise<V> {
    const existing = this.inFlight.get(key)
    if (existing) return existing
    const generation = this.generations.get(key) ?? 0
    const pending = this.opts
      .load(key, mode)
      .then((value) => {
        const at = this.now()
        const prior = this.entries.get(key)
        const stored: MemoEntry<V> = { value, readAt: at, usedAt: prior?.usedAt ?? at }
        // The last-known slot takes every read: a pre-change answer is still
        // the newest one anybody has, and it is only ever served as `stale`.
        this.lastKnown.set(key, stored)
        // Invalidated while this read was in flight ⇒ the value it returns
        // predates the change that invalidated it. Hand it to THIS caller (it
        // is no worse than what they would have read un-cached) but never store
        // it for the next one.
        if ((this.generations.get(key) ?? 0) !== generation) return value
        this.entries.set(key, stored)
        return value
      })
      .finally(() => {
        if (this.inFlight.get(key) === pending) this.inFlight.delete(key)
      })
    this.inFlight.set(key, pending)
    return pending
  }
}
