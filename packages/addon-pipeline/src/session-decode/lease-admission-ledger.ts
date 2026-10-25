/**
 * WHICH delivered frames get a native RAM lease, and the accounting that proves
 * the answer is safe.
 *
 * ## The idea
 *
 * A native-crop request always names a `frameId`, and the only way a `frameId`
 * leaves the runner is on a `FrameHandle` riding an INFERENCE RESULT. Frames
 * the runner delivered but never admitted to its detection queue (the two-plane
 * governor's `minIntervalMs`, or a non-`active` phase) therefore cannot be named
 * by anyone. Retaining a full native copy of them — ~24.9 MB each at 4K — buys
 * nothing.
 *
 * So the runner MARKS the frames it enqueued for inference
 * (`markInferred(frameId)` on the existing worker channel, sent before the next
 * `pull`), and in `inferred` mode only marked frames are admitted.
 *
 * ## Why the ledger also runs in `all` mode
 *
 * The paragraph above is a claim about the whole cluster's call graph — every
 * caller that can name a frame, including the event-media captures
 * (keyFrame / snapshot / thumbnail). Reading the code says it holds; a number
 * from production is what makes it true. {@link noteCropRequest} counts every
 * crop request naming a frame that was never marked, in BOTH modes, so the
 * premise is measured on live traffic BEFORE the filter is switched on, and
 * stays measured afterwards. A non-zero `leaseUnmarkedCrops` on the metrics
 * line is the signal to put the cluster back on `all`.
 *
 * ## The newest delivered frame is never at risk — the previous one can be
 *
 * Admission is decided in `FrameSlot.reserveSlot()`, on the frame the PREVIOUS
 * pull delivered, at the moment the next pull supersedes it. The NEWEST
 * delivered frame is the slot's `reserved` frame — `handleNativeCrop` /
 * lazy `toBuffer` resolve it through `FrameSlot.toBuffer`, not through the
 * lease — so it is croppable whether or not it was ever marked.
 *
 * That margin does NOT cover a late mark for the frame just superseded: if
 * `markInferred(N)` lands after pull N+1, N was already declined and freed,
 * and a later lazy `toBuffer(N)` misses with `marked=true`. That race is closed
 * by a one-frame pending-mark hold (park the native surface until the mark or
 * the next supersede), not by the reserved slot.
 */
import type { NativeLeaseAdmission } from '@camstack/types'

/**
 * How many recent frame ids the marked window remembers.
 *
 * It has to outlive the lease TTL comfortably: a mark is consulted once at
 * admission (within one frame of arriving) and then again by every crop request
 * for that frame, which can land a full TTL later. 1024 ids is ~40 s at 25 fps
 * on the busiest camera and costs a few tens of KB.
 */
export const DEFAULT_MARK_WINDOW = 1024

/** Constructor options for {@link LeaseAdmissionLedger}. */
export interface LeaseAdmissionLedgerOptions {
  readonly mode: NativeLeaseAdmission
  /** Marked-id window size. Defaults to {@link DEFAULT_MARK_WINDOW}. */
  readonly capacity?: number
}

/**
 * The marked-frame window plus the offered/admitted/unmarked-crop counters for
 * ONE decode worker. Pure and node-av-free so the filter is unit-testable.
 */
export class LeaseAdmissionLedger {
  private readonly mode: NativeLeaseAdmission
  private readonly capacity: number
  /** Insertion-ordered so the oldest mark is `keys().next()` — a FIFO window. */
  private readonly marked = new Set<number>()
  private markedTotal = 0
  private offeredCount = 0
  private admittedCount = 0
  private unmarkedCropCount = 0

  constructor(options: LeaseAdmissionLedgerOptions) {
    this.mode = options.mode
    this.capacity = Math.max(1, options.capacity ?? DEFAULT_MARK_WINDOW)
  }

  /**
   * Marks RECEIVED since the worker started.
   *
   * Not a curiosity: in `all` mode every other counter looks identical whether
   * the mark signal is working or has silently stopped arriving, and
   * {@link unmarkedCrops} reads 0 in BOTH cases — an empty marked window
   * answers "was this frame inferred?" with "I cannot say", which is correctly
   * not counted as evidence. So a premise measured while `marks` is 0 measures
   * nothing. This is the counter that tells the two apart.
   */
  get marks(): number {
    return this.markedTotal
  }

  /** Frames offered to the retention hook since the worker started. */
  get offered(): number {
    return this.offeredCount
  }

  /** Frames the ledger let through to the lease store. */
  get admitted(): number {
    return this.admittedCount
  }

  /**
   * Crop requests naming a frame inside the tracked window that was never
   * marked. **This is the premise counter**: any value above 0 means something
   * can ask for a frame the runner never sent to inference, and `inferred` is
   * dropping frames that someone wants.
   */
  get unmarkedCrops(): number {
    return this.unmarkedCropCount
  }

  /** Marks currently remembered (tests / bound checks). */
  get markedSize(): number {
    return this.marked.size
  }

  /**
   * The runner is DONE with `frameId` before the worker ever leased it — its
   * result came back (or it was dropped) before the next pull superseded it.
   * Withdrawing the mark makes the supersede decline the frame, so it is
   * freed at once instead of leased after its own release and pinned until
   * the bound evicts it. Measured 2026-09-06: on every busy worker
   * `leaseReleaseMisses ≈ leaseAdmitted` and `holdOverflow ≈ admitted − 8`.
   */
  unmark(frameId: number): void {
    this.marked.delete(frameId)
  }

  /** Whether `frameId` is inside the remembered marked window. */
  isMarked(frameId: number): boolean {
    return this.marked.has(frameId)
  }

  /**
   * Same keep rule as {@link admit}, without counting. Used to park a
   * just-superseded frame for a late mark without burning an offered/declined
   * sample that a later promote would double-count.
   */
  wouldAdmit(frameId: number): boolean {
    return this.mode === 'all' || this.marked.has(frameId)
  }

  /** The runner admitted `frameId` to its detection queue. */
  mark(frameId: number): void {
    this.markedTotal++
    this.marked.delete(frameId)
    this.marked.add(frameId)
    while (this.marked.size > this.capacity) {
      const oldest = this.marked.values().next().value
      if (oldest === undefined) break
      this.marked.delete(oldest)
    }
  }

  /**
   * Should this delivered frame get a native lease? `true` in `all` mode
   * always; in `inferred` mode only when the runner marked it. Counts both
   * either way, so the saving is visible on the metrics line in both modes.
   */
  admit(frameId: number): boolean {
    this.offeredCount++
    const keep = this.mode === 'all' || this.marked.has(frameId)
    if (keep) this.admittedCount++
    return keep
  }

  /**
   * Record a native-crop request for `frameId`. Returns `true` when that frame
   * was never marked AND is recent enough for the window to be sure of it —
   * a frame older than the oldest remembered mark is UNKNOWABLE, not evidence,
   * and is deliberately not counted (over-reporting here would read as a broken
   * premise and send the next session chasing nothing).
   */
  noteCropRequest(frameId: number): boolean {
    if (this.marked.has(frameId)) return false
    const oldest = this.marked.values().next().value
    if (oldest === undefined || frameId < oldest) return false
    this.unmarkedCropCount++
    return true
  }
}
