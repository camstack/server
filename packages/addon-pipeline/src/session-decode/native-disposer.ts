/**
 * The ONE door every native dispose / close in the decode worker goes through
 * (D652).
 *
 * Once the worker is exiting, the decode loop may still be inside libav for up
 * to `WORKER_EXIT_FLUSH_BOUND_MS`, and freeing a demuxer, decoder, filtergraph
 * or scaler under it is a use-after-free that crashes the process before its
 * last lines leave. Process exit reclaims all of it anyway. So from the moment
 * the exit begins this door REFUSES — every call site, direct or reached
 * indirectly (a GPU-filter degrade, a filter rebuild, a re-dial cleanup) — and
 * says so at debug.
 *
 * A source scan of "what the exit function calls" could be fooled by one level
 * of indirection; a single refusing door cannot.
 */

/** What a refused dispose reports — the name of the thing left to process exit. */
export type NativeDisposeRefusedSink = (what: string) => void

export class NativeDisposer {
  private refusing = false
  private refused = 0

  constructor(private readonly onRefused?: NativeDisposeRefusedSink) {}

  /** From now on nothing native is disposed (the worker is exiting). Idempotent. */
  refuseFromNowOn(): void {
    this.refusing = true
  }

  get isRefusing(): boolean {
    return this.refusing
  }

  /** Disposes refused since {@link refuseFromNowOn} — diagnostics and tests. */
  get refusedCount(): number {
    return this.refused
  }

  /**
   * Run `dispose` unless the worker is exiting. `what` names the object for the
   * refusal line. Returns whether it ran — a caller that dropped its reference
   * either way loses nothing: an unrun dispose is reclaimed by process exit.
   */
  run(what: string, dispose: () => void): boolean {
    if (this.refusing) {
      this.refused += 1
      this.onRefused?.(what)
      return false
    }
    dispose()
    return true
  }
}
