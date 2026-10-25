/**
 * When the exporter must send a FULL authoritative announce rather than let an
 * unchanged structure short-circuit.
 *
 * A gap is any moment after which the hub can no longer vouch for what Home
 * Assistant holds: the first pass after a start (the receiver may have been
 * running while this addon was down), a broker link that was just opened, an
 * announce or state push that was not delivered. The next pass after a gap is
 * a full resync, once, whatever its reason — an event-debounced pass included,
 * which would otherwise skip on an identical fingerprint and leave the
 * receiver unrepaired until the periodic pass.
 *
 * Passes for 'boot', 'link-restored' and 'periodic' are full by their nature.
 */

/** Reasons whose pass is a full resync whether or not a gap was noted. */
const ALWAYS_FULL: ReadonlySet<string> = new Set(['boot', 'link-restored', 'periodic'])

export class ResyncGate {
  private gap = true
  private lastReason: string | null = 'start'

  /** Note that the receiver may be out of step; the next pass will be full. */
  markGap(reason: string): void {
    this.gap = true
    this.lastReason = reason
  }

  /** `true` while a gap is waiting for a pass. */
  pending(): boolean {
    return this.gap
  }

  /** Why the gap was opened (for the log line). */
  gapReason(): string | null {
    return this.gap ? this.lastReason : null
  }

  /**
   * Called once at the start of a pass. Returns whether the pass is a full
   * resync and consumes the gap noted so far; a gap noted DURING the pass is
   * kept for the next one.
   */
  take(reason: string): boolean {
    const full = this.gap || ALWAYS_FULL.has(reason)
    this.gap = false
    this.lastReason = null
    return full
  }
}
