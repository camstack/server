/**
 * A global cap on concurrent gateway pushes (D869). A reconcile pass, a
 * restart-time burst or a house of covers moving together must not open a
 * hundred simultaneous connections to Amazon's Event Gateway: pushes beyond
 * the cap wait their turn, in order, and none is dropped.
 */
export const GATEWAY_PUSH_CONCURRENCY = 4

export class ConcurrencyLimiter {
  private active = 0
  private readonly waiting: Array<() => void> = []

  constructor(private readonly limit: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.limit) {
      await new Promise<void>((resolve) => {
        this.waiting.push(resolve)
      })
    }
    this.active += 1
    try {
      return await task()
    } finally {
      this.active -= 1
      this.waiting.shift()?.()
    }
  }

  /** Tasks running right now. */
  get inFlight(): number {
    return this.active
  }
}
