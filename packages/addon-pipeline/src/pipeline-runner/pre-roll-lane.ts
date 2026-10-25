/**
 * The one queue in this runner that is NOT latest-only.
 *
 * `FrameQueue` keeps the newest frame and drops the rest, and that is right for
 * everything live: inference must always run on the freshest pixels, and a
 * backlog of live frames is a backlog of answers nobody wants. It is exactly
 * wrong for a catch-up burst, where the whole value is in the OLD frames — the
 * subject who was already in view before motion fired. Pushing a pre-roll burst
 * through the live queue leaves one frame of it, which is one of the three
 * gates that kills the pre-roll today.
 *
 * So history gets a FIFO of its own, bounded by frame COUNT (each entry holds
 * queue-owned pixels, so the bound is the RAM bound) and drained strictly
 * behind live. It refuses rather than evicting: the burst upstream already
 * chose which frames to send under its own budget
 * (`session-decode/pre-roll-burst.ts`), and silently throwing one away here
 * would drop work a second time, in a place with no idea what it was worth.
 */

/** A frame the lane owns, plus whatever the caller pairs with it. */
export interface PreRollLaneOptions<T> {
  /** Maximum entries held. Reached ⇒ {@link PreRollLane.enqueue} refuses. */
  readonly capacity: number
  /**
   * Detaches queue-owned storage from the (possibly borrowed) source. Same
   * retention boundary as `FrameQueue`'s: an entry is held past the reader's
   * next read, so the pixels must be copied here or they are silently
   * corrupted.
   */
  readonly clone: (item: T) => T
  /** Releases an entry the lane drops on {@link PreRollLane.clear}. */
  readonly dispose?: (item: T) => void
}

export class PreRollLane<T> {
  private readonly items: T[] = []
  private readonly capacity: number
  private readonly clone: (item: T) => T
  private readonly dispose?: (item: T) => void
  private _refused = 0

  constructor(options: PreRollLaneOptions<T>) {
    this.capacity = Math.max(0, options.capacity)
    this.clone = options.clone
    this.dispose = options.dispose
  }

  /** Append one entry. `false` ⇒ the lane is full and the caller must log it. */
  enqueue(item: T): boolean {
    if (this.items.length >= this.capacity) {
      this._refused++
      return false
    }
    this.items.push(this.clone(item))
    return true
  }

  /** Oldest first — the point of the lane. */
  dequeue(): T | undefined {
    return this.items.shift()
  }

  get size(): number {
    return this.items.length
  }

  /** Entries refused because the lane was full, for the session's report line. */
  get refused(): number {
    return this._refused
  }

  clear(): void {
    for (const item of this.items) this.dispose?.(item)
    this.items.length = 0
  }
}
