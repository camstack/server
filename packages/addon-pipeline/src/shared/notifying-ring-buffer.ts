import { RingBuffer } from '@camstack/types'

/**
 * A {@link RingBuffer} that can notify a single blocked consumer the moment an
 * item commits — the server side of the `pullFrames`/`pullHandles` long-poll.
 *
 * The decoder's `onFrame`/`onFrameHandle` callback drives `push()`; a consumer
 * that finds the ring momentarily empty calls {@link waitForItem} and is woken
 * on the very next `push()` (a real commit signal) rather than spinning at
 * ~1kHz on `setTimeout(…,1)`. If nothing commits it resolves after `waitMs`,
 * and {@link cancel} (session teardown) resolves any in-flight wait promptly so
 * a blocked long-poll never waits out `waitMs` on destroy.
 *
 * Semantics are otherwise identical to `RingBuffer`: fixed capacity,
 * latest-wins overwrite when full, FIFO `drain`.
 */
export class NotifyingRingBuffer<T> {
  private readonly ring: RingBuffer<T>
  private readonly waiters = new Set<() => void>()

  constructor(capacity: number) {
    this.ring = new RingBuffer<T>(capacity)
  }

  get size(): number {
    return this.ring.size
  }

  push(item: T): void {
    this.ring.push(item)
    this.wakeAll()
  }

  drain(maxCount: number): T[] {
    return this.ring.drain(maxCount)
  }

  /**
   * Resolve as soon as an item commits to the ring, or after `waitMs`,
   * whichever comes first. Returns immediately when items are already present
   * or `waitMs <= 0` (legacy immediate-return). {@link cancel} also resolves an
   * in-flight wait.
   */
  async waitForItem(waitMs: number): Promise<void> {
    if (this.ring.size > 0 || waitMs <= 0) return
    await new Promise<void>((resolve) => {
      let settled = false
      const finish = (): void => {
        if (settled) return
        settled = true
        this.waiters.delete(wake)
        clearTimeout(timer)
        resolve()
      }
      const wake = (): void => finish()
      const timer = setTimeout(finish, waitMs)
      // Don't keep the event loop alive solely for this poll-backoff timer.
      if (typeof timer.unref === 'function') timer.unref()
      this.waiters.add(wake)
    })
  }

  /**
   * Cancel every in-flight {@link waitForItem} — called on session teardown so
   * a blocked long-poll returns promptly instead of waiting out `waitMs`.
   */
  cancel(): void {
    this.wakeAll()
  }

  private wakeAll(): void {
    if (this.waiters.size === 0) return
    const pending = [...this.waiters]
    this.waiters.clear()
    for (const wake of pending) wake()
  }
}
