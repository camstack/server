/**
 * Per-frame cutter bindings — handle key → the requester that can cut this
 * frame's subject tiles and END ITS HOLD in the decode worker.
 *
 * Deliberately NOT the node-wide `NativeCropRegistry`. That one is an LRU
 * capped at 256 and shared by every camera to serve LATE cross-process crops;
 * on the live hub it sits pinned at its cap, so an entry's lifetime depends on
 * how busy the OTHER cameras are. Ending a frame's hold is a per-frame
 * lifecycle event and cannot be allowed to depend on that.
 *
 * A binding ends exactly once, by one of three events:
 *  - `take` — the frame's result arrived; the caller cuts its tiles (an empty
 *    cut still releases the hold);
 *  - `drop` — the runner let the frame go without a result (superseded in the
 *    latest-wins queue, an inference error, a timeout); the hold is released
 *    at once. Before 2026-09-06 a dropped frame kept its hold until 256 later
 *    bindings had evicted it — at 40% queue drops that was three pinned
 *    frames per second per camera, the worker's 8-slot hold overflowed on
 *    three of every four admits (`holdOverflow:1029` of `leaseAdmitted:1383`),
 *    and every read that came more than a second after its frame failed;
 *  - the bound — a result that never comes back (a shed, a detach mid-flight)
 *    is evicted oldest-first and released, so `holdOverflow` in the worker
 *    keeps meaning "the runner stopped answering", not "the runner forgot".
 */
import type { FrameHandle } from '@camstack/types'
import type { NativeCropRequester } from '../session-decode/session-decode-pump.js'

/** The per-frame binding key — the same identity the retention handle carries. */
export function frameCutterKey(handle: FrameHandle): string {
  return `${handle.shmId}#${handle.slot}#${handle.seq}`
}

export class FrameCutterBinding {
  private readonly map = new Map<string, NativeCropRequester>()

  constructor(private readonly max: number) {}

  /** Bind at delivery. Re-binding the same handle replaces without stranding the first. */
  bind(handle: FrameHandle, cutter: NativeCropRequester): void {
    const key = frameCutterKey(handle)
    this.map.delete(key)
    this.map.set(key, cutter)
    while (this.map.size > this.max) {
      const oldest = this.map.keys().next().value
      if (oldest === undefined) break
      const stale = this.map.get(oldest)
      this.map.delete(oldest)
      release(stale)
    }
  }

  /** Consume the binding for a frame whose result arrived. `undefined` when already ended. */
  take(handle: FrameHandle): NativeCropRequester | undefined {
    const key = frameCutterKey(handle)
    const cutter = this.map.get(key)
    this.map.delete(key)
    return cutter
  }

  /**
   * End the hold of a frame the runner let go without a result. A no-op for a
   * frame whose result already consumed the binding, so the two paths cannot
   * double-release.
   */
  drop(handle: FrameHandle): void {
    release(this.take(handle))
  }

  get size(): number {
    return this.map.size
  }
}

function release(cutter: NativeCropRequester | undefined): void {
  try {
    cutter?.release()
  } catch {
    // Best-effort: the worker may already be gone.
  }
}
