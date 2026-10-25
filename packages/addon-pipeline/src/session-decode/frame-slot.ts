/**
 * The decode-worker child's frame-lifecycle state machine, extracted from
 * `decode-worker-child.ts` (Epic C P2 Task 2 / I2) so it can be unit-tested
 * without node-av. Generic over any frame-like value with a `free()` — the
 * child instantiates `FrameSlot<NavFrame>`, tests instantiate `FrameSlot`
 * with a fake.
 *
 * Semantics (unchanged from the pre-extraction inline implementation):
 * - `publish` is a latest-wins, size-1 slot: a newly published frame frees
 *   whatever the slot held before, subject to a `minIntervalMs` throttle
 *   that drops (frees) the incoming frame instead of replacing the slot when
 *   one is already held and the throttle window hasn't elapsed.
 * - `pull` hands out the current slot's frame AND reserves it — the
 *   previously reserved frame (from an earlier `pull`) is freed, and the
 *   slot is cleared so the next `publish` repopulates it for the next pull.
 * This reserve-on-pull step is the fix locked in by : without
 *   it, `toBuffer(frameId)` racing the next decoded frame would see a freed
 *   frame and hit the stale-frameId guard, tearing the session down.
 * - `toBuffer(frameId)` resolves ONLY the currently reserved frame; a stale
 *   or unknown id returns `null` (the caller turns this into an
 * error-with-frameId — see Task 1 /).
 * - `free()` frees both the slot and the reserved frame (teardown).
 */

/** The minimal frame shape `FrameSlot` needs — no node-av dependency. */
export interface SlotFrame {
  readonly width: number
  readonly height: number
  free(): void
}

/** The metadata handed back to the caller when a frame becomes available. */
export interface FrameSlotReply {
  readonly frameId: number
  readonly timestamp: number
  readonly width: number
  readonly height: number
  /**
   * Wall clock at which the frame was SHOT — the session media clock's answer
   * (`media-clock.ts`), which for a frame replayed out of retained history is
   * seconds before it was decoded.
   *
   * It rides the SLOT rather than being remembered by the caller because a
   * frame may be published now and pulled later: a caller-side "last published"
   * field would hand a pull the metadata of a frame the fps throttle had since
   * refused, i.e. the wrong moment for the right frame.
   */
  readonly capturedAt: number
  /** True when the frame came out of the session's pre-roll catch-up burst. */
  readonly preRoll: boolean
}

/** A held frame plus the metadata needed to build a {@link FrameSlotReply}. */
interface HeldFrame<F extends SlotFrame> {
  readonly frameId: number
  readonly frame: F
  readonly timestamp: number
  readonly width: number
  readonly height: number
  readonly capturedAt: number
  readonly preRoll: boolean
}

function toReply<F extends SlotFrame>(held: HeldFrame<F>): FrameSlotReply {
  return {
    frameId: held.frameId,
    timestamp: held.timestamp,
    width: held.width,
    height: held.height,
    capturedAt: held.capturedAt,
    preRoll: held.preRoll,
  }
}

/** What the publisher knows about a frame beyond its pixels. */
export interface PublishMeta {
  /** The frame's own moment; defaults to the publish `timestamp`. */
  readonly capturedAt?: number
  /** True for a frame replayed out of the session's retained history. */
  readonly preRoll?: boolean
}

/**
 * Optional retention hook for a frame that {@link FrameSlot} is about to free
 * because a newer `pull` superseded it as the reserved frame. Returning `true`
 * TRANSFERS OWNERSHIP of `frame` to the callback (the slot must NOT free it);
 * returning `false` leaves the slot to free it as before. This is the single
 * seam the native-crop retention ring hooks (`native-frame-ring.ts`): only
 * DELIVERED frames (ones that carry a `frameId` the parent knows) flow through
 * it, and each such frame is handed over at the exact moment it would otherwise
 * be freed — so ownership is never duplicated. Absent → today's behaviour.
 */
export type RetainSupersededFn<F extends SlotFrame> = (frameId: number, frame: F) => boolean

/** Constructor options for {@link FrameSlot}. */
export interface FrameSlotOptions<F extends SlotFrame> {
  readonly retainSuperseded?: RetainSupersededFn<F>
}

/**
 * Latest-wins decoded-frame slot + reserved-for-`toBuffer` holder +
 * pending-pull flag. One instance per decode-worker child session.
 */
export class FrameSlot<F extends SlotFrame> {
  private readonly retainSuperseded?: RetainSupersededFn<F>

  constructor(options?: FrameSlotOptions<F>) {
    this.retainSuperseded = options?.retainSuperseded
  }

  private nextFrameId = 1
  private slot: HeldFrame<F> | null = null
  /**
   * The frame handed to the MOST RECENT `pull`, retained so a following
   * `toBuffer(frameId)` still resolves even though `publish` keeps advancing
   * the latest-wins `slot`. Freed when the next `pull` supersedes it (or on
   * `free()`).
   */
  private reserved: HeldFrame<F> | null = null
  private pendingPull = false
  /** Timestamp of the last frame admitted by the FPS throttle. */
  private lastPublishedAt: number | null = null
  /** Frames dropped by the `minIntervalMs` throttle (never entered the slot). */
  private throttledCount = 0
  /** Frames dropped by latest-wins (an unpulled slot frame superseded before delivery). */
  private supersededCount = 0

  /**
   * Total frames this slot has DROPPED before delivery — the sum of the
   * `minIntervalMs` throttle drops and the latest-wins (drop-older)
   * supersessions. Read by the decode-worker child for its `framesSkipped`
   * metric; purely additive, never affects slot behaviour.
   */
  get droppedCount(): number {
    return this.throttledCount + this.supersededCount
  }

  /**
   * Publish a newly decoded frame into the latest-wins slot, freeing
   * whatever the slot held before (the drop-older half of "latest-wins").
   * Returns the reply to send if a `pull` was pending (resolving it
   * immediately and reserving the frame); otherwise returns `null` and the
   * frame simply waits in the slot for the next `pull`.
   */
  publish(
    frame: F,
    timestamp: number,
    minIntervalMs: number,
    meta?: PublishMeta,
  ): FrameSlotReply | null {
    if (
      minIntervalMs > 0 &&
      this.lastPublishedAt !== null &&
      timestamp - this.lastPublishedAt < minIntervalMs
    ) {
      this.throttledCount++
      frame.free()
      return null
    }
    this.lastPublishedAt = timestamp
    const previous = this.slot
    const frameId = this.nextFrameId++
    this.slot = {
      frameId,
      frame,
      timestamp,
      width: frame.width,
      height: frame.height,
      capturedAt: meta?.capturedAt ?? timestamp,
      preRoll: meta?.preRoll ?? false,
    }
    if (previous) this.supersededCount++
    previous?.frame.free()
    if (this.pendingPull) {
      this.pendingPull = false
      return this.reserveSlot()
    }
    return null
  }

  /**
   * Hand out the newest slot frame and RESERVE it (freeing the previously
   * reserved frame), clearing the slot. Returns `null` if no frame has been
   * decoded yet — the caller should then call `markPendingPull()`.
   */
  pull(): FrameSlotReply | null {
    if (!this.slot) return null
    return this.reserveSlot()
  }

  /** Record that a pull is waiting for the next `publish` to resolve it. */
  markPendingPull(): void {
    this.pendingPull = true
  }

  /** The id of the frame the last `pull` delivered (the reserved one), or `null`. */
  get reservedFrameId(): number | null {
    return this.reserved?.frameId ?? null
  }

  /** The reserved frame for `frameId`, or `null` if unknown/stale. */
  toBuffer(frameId: number): F | null {
    if (!this.reserved || this.reserved.frameId !== frameId) return null
    return this.reserved.frame
  }

  /**
   * Free only the UNDELIVERED slot frame, keeping the reserved one (D652 drain):
   * after a drain no `pull` will ever take the slot frame, while the reserved
   * frame is one the parent may still read. Returns whether a frame was freed.
   */
  freeUndelivered(): boolean {
    const held = this.slot
    if (!held) return false
    held.frame.free()
    this.slot = null
    return true
  }

  /** Free both the slot and the reserved frame (teardown). */
  free(): void {
    this.slot?.frame.free()
    this.slot = null
    this.reserved?.frame.free()
    this.reserved = null
    this.lastPublishedAt = null
  }

  private reserveSlot(): FrameSlotReply {
    const held = this.slot
    if (!held) throw new Error('frame-slot: reserveSlot called with no slot held')
    const previousReserved = this.reserved
    this.reserved = held
    this.slot = null
    if (previousReserved) {
      // Offer the just-superseded DELIVERED frame to the retention hook; only
      // free it here if the hook declined ownership (kept === false).
      const kept =
        this.retainSuperseded?.(previousReserved.frameId, previousReserved.frame) ?? false
      if (!kept) previousReserved.frame.free()
    }
    return toReply(held)
  }
}
