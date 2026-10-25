/**
 * One-frame grace for a late `markInferred` IPC.
 *
 * Admission for delivered frame N is decided when pull N+1 supersedes it
 * (`FrameSlot.reserveSlot` → `retainSuperseded`). The contract says the runner
 * sends `markInferred(N)` before that pull, and IPC order usually keeps it.
 * When the mark lands AFTER the supersede, today's path has already freed N:
 * a later lazy detection `toBuffer(N)` misses with `marked=true leaseFrames=0`
 * — the reserved-slot one-frame margin only covers the NEWEST id, not an id
 * already handed to retention and declined.
 *
 * This hold parks the just-superseded frame WITHOUT downloading it (no GPU→RAM
 * burn for a frame that may never be marked). A matching mark takes it for
 * lease capture; the next supersede (or `clear`) discards it. At most one
 * frame per worker.
 */
export class PendingMarkHold<F extends { free(): void }> {
  private held: { readonly frameId: number; readonly frame: F } | null = null

  /** Id currently parked, or `null`. */
  get frameId(): number | null {
    return this.held?.frameId ?? null
  }

  /** 0 or 1 — exposed for metrics / tests. */
  get size(): number {
    return this.held ? 1 : 0
  }

  /**
   * Park `frame` awaiting a possible late mark. Frees any previous pending
   * (that id lost the mark race). Takes ownership of `frame`.
   */
  park(frameId: number, frame: F): void {
    this.discard()
    this.held = { frameId, frame }
  }

  /** Peek without taking — lazy `toBuffer` while still pending. */
  get(frameId: number): F | null {
    if (!this.held || this.held.frameId !== frameId) return null
    return this.held.frame
  }

  /** Take ownership if `frameId` matches; otherwise leave pending alone. */
  take(frameId: number): F | null {
    if (!this.held || this.held.frameId !== frameId) return null
    const frame = this.held.frame
    this.held = null
    return frame
  }

  /** Free the pending frame if any. Returns whether something was freed. */
  discard(): boolean {
    if (!this.held) return false
    this.held.frame.free()
    this.held = null
    return true
  }

  /** Teardown alias. */
  clear(): void {
    this.discard()
  }
}
