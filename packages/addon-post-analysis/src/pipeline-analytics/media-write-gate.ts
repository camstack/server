/**
 * Reversible writer gate for storage maintenance. `pause()` closes admission
 * first, then waits for writes already admitted to settle; callers never
 * mutate device bindings or analytics configuration to quiesce media.
 */
export class MediaWriteGate {
  private paused = false
  private active = 0
  private readonly drainedWaiters: Array<() => void> = []

  async run<T>(write: () => Promise<T>): Promise<T> {
    if (this.paused) throw new Error('event-media writes are paused for storage migration')
    this.active++
    try {
      return await write()
    } finally {
      this.active--
      if (this.active === 0) {
        for (const resolve of this.drainedWaiters.splice(0)) resolve()
      }
    }
  }

  pause(): Promise<void> {
    this.paused = true
    if (this.active === 0) return Promise.resolve()
    return new Promise((resolve) => this.drainedWaiters.push(resolve))
  }

  resume(): void {
    this.paused = false
  }
}
