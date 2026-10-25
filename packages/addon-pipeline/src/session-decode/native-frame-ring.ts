/**
 * Bounded native-frame retention ring for the decode-worker child (native-res
 * crop feature).
 *
 * ## Why this exists
 *
 * Detection runs on a DOWNSCALED frame: the worker GPU-crop+scales every
 * decoded frame to the ≤640-wide detection geometry and downloads ONLY that
 * small result (`decode-worker-child.ts` `toBuffer`). The full-resolution
 * surface is otherwise freed the moment the next frame is pulled, so every
 * downstream crop (face embed, best-face thumbnail, event/snapshot media) is
 * capped at detection resolution.
 *
 * Bboxes are known only AFTER detection has run on the shipped small frame, so
 * the native surface of frame N must survive until frame N's ROIs are cropped.
 * This ring is that bounded survival window: a SHORT, HARD-CAPPED map from the
 * worker frameId to the retained native frame. A native-crop request looks the
 * frameId up here; a miss (surface already evicted) is FREE — the caller falls
 * back to today's detection-frame crop.
 *
 * ## Single-ownership discipline (the leak guard)
 *
 * Retaining GPU surfaces has leaked the VAAPI surface pool here before (see
 * `decode-worker-child.ts` `hwFilter`/`closeInput`). This ring NEVER duplicates
 * a frame's ownership: it receives a frame at the exact moment `FrameSlot` would
 * otherwise free it (the reserve-supersession point), so a frame is owned by
 * exactly one of {the latest-wins slot, the reserved holder, this ring} at any
 * time — never two. Eviction past the hard cap frees the oldest immediately;
 * `clear()` frees every retained frame (called on every re-dial via
 * `closeInput` and on teardown, mirroring the `hwFilter` dispose rigor). There
 * is therefore no `frame.clone()`/refcount aliasing to reason about.
 *
 * Generic over the same minimal {@link SlotFrame} shape as `FrameSlot`, so it is
 * unit-testable without node-av.
 */
import type { SlotFrame } from './frame-slot.js'

/**
 * A hard-capped, insertion-ordered map from worker frameId → retained frame.
 * `capacity <= 0` disables retention entirely (every `retain` frees immediately
 * and returns false) — the safe "keep the ring off" knob.
 */
export class NativeFrameRing<F extends SlotFrame> {
  /** Insertion-ordered (Map preserves insertion order) frameId → frame. */
  private readonly frames = new Map<number, F>()

  constructor(private readonly capacity: number) {}

  /** Number of frames currently retained (for tests / metrics). */
  get size(): number {
    return this.frames.size
  }

  /**
   * Take ownership of `frame` under `frameId`. Frees the oldest retained frame
   * when the cap is exceeded (FIFO by frameId insertion). Returns `true` when
   * the ring took ownership (caller MUST NOT free), `false` when retention is
   * disabled (`capacity <= 0`) and the caller still owns/should free the frame.
   */
  retain(frameId: number, frame: F): boolean {
    if (this.capacity <= 0) return false
    // A duplicate frameId should never occur (frameIds are monotonic), but free
    // the prior holder defensively rather than leak it.
    const existing = this.frames.get(frameId)
    if (existing) existing.free()
    this.frames.set(frameId, frame)
    while (this.frames.size > this.capacity) {
      const oldestKey = this.frames.keys().next().value
      if (oldestKey === undefined) break
      const oldest = this.frames.get(oldestKey)
      this.frames.delete(oldestKey)
      oldest?.free()
    }
    return true
  }

  /** The retained frame for `frameId`, or `null` if never retained / already evicted. */
  get(frameId: number): F | null {
    return this.frames.get(frameId) ?? null
  }

  /** Free and drop every retained frame. Idempotent (re-dial + teardown call it). */
  clear(): void {
    for (const frame of this.frames.values()) frame.free()
    this.frames.clear()
  }
}
