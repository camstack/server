/**
 * Generic per-key async mutex.
 *
 * Extracted from the byte-for-byte-duplicated `withAudioSubLock` /
 * `withSessionLock` critical sections in `index.ts` (S2 refactor step —
 * zero behavior change). Both originals chained a critical section onto a
 * per-key tail promise so at-most-one section runs at a time per key while
 * different keys never block each other, and turned queued/new sections
 * into no-ops once a shutdown flag flipped. This class is that pattern,
 * generalized over the key type and the shutdown predicate so a single
 * implementation can back both lock instances.
 */

export interface KeyedAsyncLockDeps {
  /**
   * Polled at the moment a section's turn comes up (after its prior tail
   * settles). Once true, queued/new sections become no-ops instead of
   * running `fn` — mirrors `audioShuttingDown` / `sessionShuttingDown`.
   */
  readonly isShuttingDown: () => boolean
}

/**
 * Serializes critical sections per key. Different keys run fully
 * independently; the same key's sections run strictly one-at-a-time, in
 * FIFO order, regardless of whether an earlier section threw.
 */
export class KeyedAsyncLock<TKey> {
  private readonly tails = new Map<TKey, Promise<void>>()

  constructor(private readonly deps: KeyedAsyncLockDeps) {}

  /** Number of keys with a not-yet-drained chain. Test-seam / diagnostics only. */
  get size(): number {
    return this.tails.size
  }

  /**
   * Run `fn` exactly once, after the prior tail for `key` settles
   * regardless of its outcome. The returned promise is the caller-facing
   * promise (rejects iff `fn` rejected). Once `isShuttingDown()` is true,
   * queued/new sections become no-ops so they cannot resurrect state a
   * shutdown path already tore down.
   */
  run(key: TKey, fn: () => Promise<void>): Promise<void> {
    const prior = this.tails.get(key) ?? Promise.resolve()
    // Run `fn` exactly once, after `prior` settles regardless of its outcome.
    // `result` is the caller-facing promise (rejects iff `fn` rejected).
    // Once shutdown has begun, queued/new sections become no-ops so they
    // cannot resurrect state into whatever the shutdown path already cleared.
    const result = prior.then(
      () => (this.deps.isShuttingDown() ? undefined : fn()),
      () => (this.deps.isShuttingDown() ? undefined : fn()),
    )
    // Internal tail: same execution as `result`, but error-swallowed so a
    // throwing `fn` never breaks serialization for later sections.
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.tails.set(key, tail)
    // Drain: when THIS tail settles and it is still the current tail (no newer
    // work queued behind it), remove the entry to avoid unbounded growth.
    void tail.then(() => {
      if (this.tails.get(key) === tail) {
        this.tails.delete(key)
      }
    })
    return result
  }

  /**
   * Drop all queued tails (best-effort teardown — clearing only releases
   * references; in-flight sections resolve against the now-empty map
   * harmlessly).
   */
  clear(): void {
    this.tails.clear()
  }
}
