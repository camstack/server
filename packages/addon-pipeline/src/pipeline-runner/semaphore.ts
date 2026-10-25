/**
 * Counting semaphore with FIFO waiter queue. Used by the runner to bound
 * concurrent inference invocations across all attached cameras.
 *
 * The concurrency limit is **mutable** via `resize()` so the
 * pipeline-runner addon can hot-reload `maxConcurrentInferences` without
 * tearing down and restarting the runner. In-flight permits are
 * preserved: shrinking the limit just lowers the headroom until existing
 * releases catch up; growing it wakes pending waiters immediately.
 */
export class Semaphore {
  private _concurrency: number
  private _available: number
  private readonly waiters: Array<() => void> = []

  constructor(concurrency: number) {
    this._concurrency = concurrency
    this._available = concurrency
  }

  get concurrency(): number {
    return this._concurrency
  }

  get available(): number {
    return this._available
  }

  /**
   * Change the concurrency limit at runtime. Growing wakes as many
   * pending waiters as possible without exceeding the new headroom;
   * shrinking simply caps `_available` to `max(0, _available + delta)`.
   * In-flight permits are never revoked — the excess will drain
   * naturally as existing callers release.
   */
  resize(newConcurrency: number): void {
    if (newConcurrency < 1) throw new Error('Semaphore: concurrency must be >= 1')
    const delta = newConcurrency - this._concurrency
    this._concurrency = newConcurrency
    this._available = Math.max(0, this._available + delta)
    // If we just grew, wake as many waiters as new headroom allows.
    while (this._available > 0 && this.waiters.length > 0) {
      const next = this.waiters.shift()
      if (next) next()
    }
  }

  async acquire(): Promise<() => void> {
    if (this._available > 0) {
      this._available--
      return () => this.release()
    }

    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        this._available--
        resolve(() => this.release())
      })
    })
  }

  private release(): void {
    this._available++
    const next = this.waiters.shift()
    if (next) next()
  }
}
