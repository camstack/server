import type { DecodedFrame } from '@camstack/types'

/**
 * Latest-frame-only buffer. Keeps only the most recent item, dropping all
 * older items immediately. This ensures inference always runs on the
 * freshest available frame, never accumulating a backlog regardless of
 * inference latency.
 *
 * ## Buffer ownership (Phase 5 / D9 Task 7b)
 *
 * Frames arrive from the shm frame plane via a `FrameRingReader`, whose
 * `FrameRead.pixels` is **borrowed** — a view onto the reader's reusable
 * scratch buffer, valid only until that reader's next read (see
 * `@camstack/shm-ring`'s `FrameRead` contract). Both queue consumers retain
 * the frame PAST the next read:
 *
 *   - the **motion** queue is drained by the scheduler's `tick`, not by the
 *     poller that read the frame — and the poller drains a burst of handles
 *     per poll, so even handle #2's read would clobber handle #1's pixels;
 *   - the **detection** queue is drained asynchronously after a semaphore wait
 *     and a 10s–100s ms inference.
 *
 * In both cases holding the borrowed buffer is silent corruption. So
 * `enqueue` runs the queue's injected `clone` function which copies the
 * pixels into queue-owned storage at the retention boundary. The queue is
 * latest-only (capacity 1), so this is exactly one allocation per *queued*
 * frame — bounded by the scheduler/inference cadence, NOT per *read* frame.
 * The high-frequency per-read allocation that failed the D9 perf gate is
 * eliminated; this bounded copy-on-retain is the correct cost.
 *
 * The generic parameter `T` lets the detection path queue a
 * `{ frame, handle }` entry (Task 7 — propagating the `FrameHandle`
 * through to the inference-result event), while the motion path keeps
 * queueing bare `DecodedFrame`s. Each instance provides its own
 * `clone` so the inner pixel buffer is detached at the same retention
 * boundary regardless of the wrapping entry shape.
 */
/**
 * Why a queued item was let go: a newer one took its place (latest-wins), or
 * the queue was emptied (a detach or a session close). The first is the
 * queue's design; the second is work thrown away (D652).
 */
export type FrameQueueDisposeReason = 'superseded' | 'cleared'

export class FrameQueue<T = DecodedFrame> {
  private latest: T | null = null
  private _droppedFrames = 0
  private readonly clone: (item: T) => T
  private readonly dispose?: (item: T, reason: FrameQueueDisposeReason) => void

  /**
   * `clone` runs on every {@link enqueue} to detach a queue-owned copy from
   * the (possibly borrowed) source — required by the D9 Task 7b ownership
   * contract above. Motion call sites pass {@link ownFrame}; the detection
   * path passes a clone that copies its inner frame's pixel buffer.
   */
  constructor(
    readonly maxSize: number,
    clone: (item: T) => T,
    dispose?: (item: T, reason: FrameQueueDisposeReason) => void,
  ) {
    this.clone = clone
    this.dispose = dispose
  }

  enqueue(item: T): void {
    if (this.latest !== null) {
      this._droppedFrames++
      this.dispose?.(this.latest, 'superseded')
    }
    // Copy the borrowed shm scratch pixels into queue-owned storage — the
    // frame is retained past the reader's next read (see the class doc).
    this.latest = this.clone(item)
  }

  dequeue(): T | undefined {
    const item = this.latest ?? undefined
    this.latest = null
    return item
  }

  get size(): number {
    return this.latest !== null ? 1 : 0
  }

  get droppedFrames(): number {
    return this._droppedFrames
  }

  /** The queued item, without taking it. */
  peek(): T | undefined {
    return this.latest ?? undefined
  }

  clear(): void {
    if (this.latest !== null) this.dispose?.(this.latest, 'cleared')
    this.latest = null
  }
}

/**
 * Return a copy of `frame` whose `data` is queue-owned — a detached
 * `Buffer.from` of the (possibly borrowed) source pixels. Every other field is
 * a plain value and is carried through unchanged; any extra non-`DecodedFrame`
 * property the runner pins on a frame (e.g. `_enqueuedAt`) is preserved by the
 * spread so downstream timing accounting is unaffected.
 */
export function ownFrame(frame: DecodedFrame): DecodedFrame {
  return { ...frame, data: Buffer.from(frame.data) }
}
