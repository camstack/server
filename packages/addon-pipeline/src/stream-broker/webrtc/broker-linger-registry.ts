/**
 * BrokerLingerRegistry — bounded post-session warmth for view-serving
 * brokers.
 *
 * ## Why
 *
 * Brokers dial on demand and suspend ~5 s after the last consumer detaches
 * (`SUSPEND_GRACE_MS`), and the RTP pre-buffer ring resets with the dial. A
 * remote viewer's dominant access pattern — open a camera, close it, reopen
 * one-to-two minutes later (every cold-connect cluster in the production
 * `embed:webrtc-timing` data shows exactly this shape) — therefore re-pays
 * the whole cold path on each open: background re-dial, empty ring, no
 * instant-start GOP replay, next-IDR wait (2–4.5 s).
 *
 * Holding a ghost `onEncodedData` subscription for a linger window after the
 * LAST WebRTC session on a broker closes keeps the dial and the ring warm
 * for precisely the brokers someone actually watched. A re-open inside the
 * window connects against a warm source: instant-start replay fires, no
 * dial, no IDR wait.
 *
 * ## Why not an always-warm tier instead
 *
 * Warming the remote-facing tier fleet-wide costs one PERMANENT extra RTSP
 * session per camera (many cameras cap concurrent RTSP sessions) and buys
 * nothing for cameras never viewed remotely. The linger is self-expiring
 * and bounded by "cameras viewed in the last few minutes": per held broker,
 * one RTSP socket + one GOP of ring RAM (~0.5–2 MB), zero decode, zero
 * inference impact.
 */

type Unsubscribe = () => void

export interface BrokerLingerRegistryOptions {
  /** How long a broker stays warm after its last session closes. */
  readonly lingerMs?: number
  /**
   * Attach the ghost demand subscription for a broker. Returns the release
   * function, or `null` when the broker no longer exists (hold becomes a
   * no-op).
   */
  readonly subscribe: (brokerId: string) => Unsubscribe | null
}

/** Matches the observed reopen gaps (1–2 min) with headroom; well under the
 *  "operator walked away" scale where warmth would be waste. */
const DEFAULT_LINGER_MS = 3 * 60_000

interface LingerHold {
  readonly unsubscribe: Unsubscribe
  timer: ReturnType<typeof setTimeout>
}

export class BrokerLingerRegistry {
  private readonly lingerMs: number
  private readonly subscribe: (brokerId: string) => Unsubscribe | null
  private readonly holds = new Map<string, LingerHold>()

  constructor(options: BrokerLingerRegistryOptions) {
    this.lingerMs = options.lingerMs ?? DEFAULT_LINGER_MS
    this.subscribe = options.subscribe
  }

  /**
   * Start (or restart) the linger window for a broker that just lost its
   * last session. Re-holding an already-held broker re-arms the timer
   * without stacking a second ghost subscription.
   */
  hold(brokerId: string): void {
    const existing = this.holds.get(brokerId)
    if (existing) {
      clearTimeout(existing.timer)
      existing.timer = this.armTimer(brokerId)
      return
    }
    const unsubscribe = this.subscribe(brokerId)
    if (unsubscribe === null) return
    this.holds.set(brokerId, { unsubscribe, timer: this.armTimer(brokerId) })
  }

  /** Release the hold NOW — a new session attached, the real subscription
   *  carries the demand from here. No-op when nothing is held. */
  cancel(brokerId: string): void {
    const hold = this.holds.get(brokerId)
    if (!hold) return
    clearTimeout(hold.timer)
    this.holds.delete(brokerId)
    this.release(hold)
  }

  /** Release every hold (server shutdown). */
  stop(): void {
    for (const [brokerId, hold] of this.holds) {
      clearTimeout(hold.timer)
      this.holds.delete(brokerId)
      this.release(hold)
    }
  }

  private armTimer(brokerId: string): ReturnType<typeof setTimeout> {
    const timer = setTimeout(() => {
      const hold = this.holds.get(brokerId)
      if (!hold) return
      this.holds.delete(brokerId)
      this.release(hold)
    }, this.lingerMs)
    timer.unref?.()
    return timer
  }

  private release(hold: LingerHold): void {
    try {
      hold.unsubscribe()
    } catch {
      // The broker may already be torn down — the hold is gone either way.
    }
  }
}
