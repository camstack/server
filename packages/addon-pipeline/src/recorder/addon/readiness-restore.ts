/**
 * Readiness-gated restore queue — the reusable, transport-free core of boot
 * restore. Copied from the old recorder
 * (`addon-pipeline/src/recorder/readiness-restore.ts`) verbatim.
 *
 * A set of keyed items must each run an async `attempt` that depends on one or
 * more capabilities being ready. Instead of waiting ONCE for N seconds (always
 * potentially too short, and brittle if a dependency restarts), the queue is
 * EVENT-DRIVEN: it (re)drains every pending item each time a readiness signal
 * fires. An `attempt` that throws keeps its item pending — to be retried by the
 * next readiness signal. There is NO timer, NO backoff, NO polling: the caller
 * wires `subscribeReady` to the kernel `ReadinessRegistry`
 * (`onCapabilityStateChange`), which is the single source of truth and the
 * actual "retry" mechanism.
 *
 * Re-entrancy: a readiness signal that arrives WHILE a drain is in flight sets a
 * rerun flag so the drain repeats once it finishes — a dependency that becomes
 * ready mid-drain is never missed. Each item succeeds AT MOST ONCE (removed from
 * the pending set on success).
 *
 * Drain is bounded-parallel. A serial `for await` made one unpublished camera
 * (measured: hall `high` not published) block every other writer for tens of
 * seconds; the first pin landed at t0+223 s. Overlap does not change the
 * event-driven contract — it only stops one slow failure from being a queue.
 */
/** In-flight restore attempts. Attach is RPC-bound, not disk-bound. */
export const RESTORE_DRAIN_CONCURRENCY = 8

export async function runBounded<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return
  const queue = [...items]
  const lanes = Math.max(1, Math.min(concurrency, queue.length))
  const lane = async (): Promise<void> => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      await worker(item)
    }
  }
  await Promise.all(Array.from({ length: lanes }, () => lane()))
}

export interface ReadinessRestoreDeps<K, V> {
  /** Subscribe to readiness signals; returns an unsubscribe fn. The handler is
   *  invoked on every relevant `ready` transition. */
  subscribeReady(handler: () => void): () => void
  /** Attempt one item. Resolve = done (item removed). Throw = defer (item kept
   *  pending, retried on the next readiness signal). */
  attempt(key: K, value: V): Promise<void>
  /** Optional: observe a deferred attempt (e.g. log). */
  onDefer?(key: K, value: V, err: unknown): void
  /**
   * Max overlapping attempts during a drain. Default
   * {@link RESTORE_DRAIN_CONCURRENCY}.
   *
   * A FUNCTION when the bound is adaptive: it is read once at the top of every
   * drain, so a node under fork pressure narrows the next drain instead of
   * re-attempting the same too-large batch (`spawn-pressure.ts`). It is not
   * read mid-drain — a batch that started at 8 finishes at 8, because
   * cancelling work already in flight is not backing off, it is thrashing.
   */
  concurrency?: number | (() => number)
}

export class ReadinessRestore<K, V> {
  private readonly pending = new Map<K, V>()
  private draining = false
  private rerun = false
  private unsub: (() => void) | null = null

  constructor(private readonly deps: ReadinessRestoreDeps<K, V>) {}

  private get concurrency(): number {
    const declared = this.deps.concurrency
    const value = typeof declared === 'function' ? declared() : declared
    return Math.max(1, value ?? RESTORE_DRAIN_CONCURRENCY)
  }

  /** Seed the pending set, subscribe to readiness, and drain once immediately
   *  (covers the already-ready case). Returns when the first drain settles. */
  async start(items: Iterable<readonly [K, V]>): Promise<void> {
    for (const [k, v] of items) this.pending.set(k, v)
    if (this.unsub === null) {
      this.unsub = this.deps.subscribeReady(() => {
        void this.drain()
      })
    }
    await this.drain()
  }

  /** Add (or replace) one pending item without re-subscribing. Does NOT drain. */
  add(key: K, value: V): void {
    this.pending.set(key, value)
  }

  /** Remove one pending item (e.g. the camera was disabled before it attached). */
  remove(key: K): void {
    this.pending.delete(key)
  }

  /** Unsubscribe from readiness. Call on shutdown. */
  stop(): void {
    this.unsub?.()
    this.unsub = null
    this.pending.clear()
  }

  get pendingCount(): number {
    return this.pending.size
  }

  hasPending(key: K): boolean {
    return this.pending.has(key)
  }

  /** Attempt every still-pending item; repeat once if a readiness signal arrived
   *  mid-flight. Re-entrant and self-coalescing. Overlapping up to
   *  {@link ReadinessRestoreDeps.concurrency}. */
  async drain(): Promise<void> {
    if (this.draining) {
      this.rerun = true
      return
    }
    if (this.pending.size === 0) return
    this.draining = true
    try {
      do {
        this.rerun = false
        const batch = Array.from(this.pending)
        await runBounded(batch, this.concurrency, async ([key, value]) => {
          if (!this.pending.has(key)) return
          try {
            await this.deps.attempt(key, value)
            this.pending.delete(key)
          } catch (err: unknown) {
            this.deps.onDefer?.(key, value, err)
          }
        })
      } while (this.rerun && this.pending.size > 0)
    } finally {
      this.draining = false
    }
  }
}
