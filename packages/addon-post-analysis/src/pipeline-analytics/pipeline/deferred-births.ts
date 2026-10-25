/**
 * Births the confirmation gate could not decide, held for another look.
 *
 * The twin of {@link SuppressedBirthRegistry}, and deliberately shaped like it:
 * a per-device map with a per-frame `retain()` that forgets ids the tracker no
 * longer carries. An id absent from the current frame can never be decided, so
 * holding it only leaks.
 *
 * What it adds is the two numbers a retry needs in order to terminate: how many
 * attempts a birth has had, and when the FIRST one was. `firstSeenMs` is never
 * refreshed — refreshing it on each attempt would push the deadline out on
 * every retry, and a birth on a camera with a persistent crop failure would
 * defer forever instead of falling through to the fallback.
 */
interface DeferredBirth {
  readonly firstSeenMs: number
  attempts: number
}

export class DeferredBirthRegistry {
  private readonly byDevice = new Map<string, Map<string, DeferredBirth>>()

  /** Record an undecided attempt. The first call registers; later calls count. */
  defer(deviceKey: string, trackId: string, nowMs: number): void {
    let ids = this.byDevice.get(deviceKey)
    if (!ids) {
      ids = new Map<string, DeferredBirth>()
      this.byDevice.set(deviceKey, ids)
    }
    const existing = ids.get(trackId)
    if (existing) existing.attempts += 1
    else ids.set(trackId, { firstSeenMs: nowMs, attempts: 1 })
  }

  isDeferred(deviceKey: string, trackId: string): boolean {
    return this.byDevice.get(deviceKey)?.has(trackId) === true
  }

  attemptsFor(deviceKey: string, trackId: string): number {
    return this.byDevice.get(deviceKey)?.get(trackId)?.attempts ?? 0
  }

  /** Ms since the FIRST attempt, or 0 for an id this registry never saw. */
  elapsedMs(deviceKey: string, trackId: string, nowMs: number): number {
    const entry = this.byDevice.get(deviceKey)?.get(trackId)
    return entry ? nowMs - entry.firstSeenMs : 0
  }

  /** A verdict finally arrived — stop tracking it. */
  resolve(deviceKey: string, trackId: string): void {
    const ids = this.byDevice.get(deviceKey)
    if (!ids) return
    ids.delete(trackId)
    if (ids.size === 0) this.byDevice.delete(deviceKey)
  }

  /**
   * True when this birth has had enough tries, or waited long enough.
   *
   * Either bound ends the deferral: attempts alone would let a camera whose
   * frames arrive slowly hold a birth for minutes, and elapsed alone would let
   * a fast camera burn dozens of inference calls on one hopeless box.
   */
  exhausted(
    deviceKey: string,
    trackId: string,
    nowMs: number,
    maxAttempts: number,
    maxDeferralMs: number,
  ): boolean {
    const entry = this.byDevice.get(deviceKey)?.get(trackId)
    if (!entry) return false
    return entry.attempts >= maxAttempts || nowMs - entry.firstSeenMs >= maxDeferralMs
  }

  /** Every id awaiting a verdict on this device. */
  deferredIds(deviceKey: string): readonly string[] {
    const ids = this.byDevice.get(deviceKey)
    return ids ? [...ids.keys()] : []
  }

  /**
   * Forget every deferred id the tracker is no longer carrying.
   *
   * Called once per frame with the ids present THIS frame — the same contract
   * as the suppressed registry's `retain`.
   */
  retain(deviceKey: string, currentTrackIds: ReadonlySet<string>): void {
    const ids = this.byDevice.get(deviceKey)
    if (!ids) return
    for (const id of [...ids.keys()]) {
      if (!currentTrackIds.has(id)) ids.delete(id)
    }
    if (ids.size === 0) this.byDevice.delete(deviceKey)
  }

  /** Deferred ids currently held for a device — diagnostics and tests. */
  size(deviceKey: string): number {
    return this.byDevice.get(deviceKey)?.size ?? 0
  }

  /** Drop a device's memory wholesale (device removed / pipeline reset). */
  clearDevice(deviceKey: string): void {
    this.byDevice.delete(deviceKey)
  }
}
