// =============================================================================
// DisposerChain — minimal LIFO cleanup registry used to back
// `AddonContext.addDisposer`.
//
// Owned by whoever constructs an AddonContext (the addon host on the
// hub, the worker host in forks). At shutdown / restart the host calls
// `dispose()` once; this drains the chain in LIFO order so resources
// registered later (which may depend on earlier ones) tear down first.
//
// Errors thrown by individual disposers are logged via the optional
// onError callback but never abort the rest of the chain — partial
// cleanup is always better than half-stopped state on the next restart.
// =============================================================================

export type DisposerFn = () => void | Promise<void>

export interface DisposerChainOptions {
  /** Logged when an individual disposer throws. Defaults to console.error. */
  onError?: (err: unknown, index: number) => void
}

export class DisposerChain {
  private disposers: DisposerFn[] = []
  private disposed = false
  private readonly onError: (err: unknown, index: number) => void

  constructor(opts: DisposerChainOptions = {}) {
    this.onError =
      opts.onError ??
      ((err, index) => {
        // eslint-disable-next-line no-console
        console.error(`[DisposerChain] disposer #${index} threw`, err)
      })
  }

  /**
   * Register a teardown callback. Returns an unregister function so
   * callers can drop a single disposer without disposing the whole
   * chain.
   *
   * If the chain has already been disposed, the callback runs immediately
   * (sync) — this matches the “register-after-shutdown” edge case where
   * an addon's late initialization races with kernel restart.
   */
  add(fn: DisposerFn): () => void {
    if (this.disposed) {
      try {
        const result = fn()
        if (result && typeof (result as Promise<void>).then === 'function') {
          ;(result as Promise<void>).catch((err) => this.onError(err, -1))
        }
      } catch (err) {
        this.onError(err, -1)
      }
      return () => undefined
    }

    this.disposers.push(fn)
    return () => {
      const idx = this.disposers.indexOf(fn)
      if (idx >= 0) this.disposers.splice(idx, 1)
    }
  }

  /** True after `dispose()` has been called at least once. */
  get isDisposed(): boolean {
    return this.disposed
  }

  /** Number of disposers currently registered. */
  get size(): number {
    return this.disposers.length
  }

  /**
   * Run every registered disposer in LIFO order. Idempotent: subsequent
   * calls do nothing. Awaits async disposers so callers can sequence
   * shutdown → restart correctly.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    // Snapshot + clear so concurrent `add()` from a disposer can't
    // re-enter the same array we're draining.
    const drain = this.disposers.slice().toReversed()
    this.disposers = []

    for (let i = 0; i < drain.length; i++) {
      const fn = drain[i]!
      try {
        const result = fn()
        if (result && typeof (result as Promise<void>).then === 'function') {
          await result
        }
      } catch (err) {
        this.onError(err, drain.length - 1 - i)
      }
    }
  }
}
