/**
 * Demand-driven gate for the native-frame lease capture (see
 * `decode-worker-child.ts` `captureNativeFrame`).
 *
 * Eagerly downloading EVERY delivered frame from the GPU at native resolution
 * is sustained memory-bandwidth burn a small host (N100) cannot afford when
 * nothing consumes the leases — live 2026-07-16: dev 103 ran 24 native-4K
 * downloads/s with `nativeCropHits:0` for hours, and two such sessions
 * saturated the box (load ~9 on 4 cores) until delivered fps collapsed to 0.
 *
 * The gate keeps capture ON only while there is plausible demand:
 * - `arm()` at dial start — the FIRST track of a fresh on-motion session gets
 *   native-quality media before any crop request has been seen;
 * - `arm()` on every native-crop request — post-analysis snapshot crops and
 *   the detail plane re-arm it continuously while tracks are active;
 * - `arm()` on every `markInferred` — the runner admitted the frame to
 *   detection and will lazy-`toBuffer` it after the next pull supersedes the
 *   reserved slot; without this, a quiet always-on camera closed the gate
 *   after `activityMs` and every marked supersede was freed
 *   (`toBuffer miss — released`);
 * - after `windowMs` without demand it closes and per-frame downloads stop
 *   for UNMARKED frames (a later crop request simply misses once — the
 *   caller's designed detection-frame-crop fallback — and re-arms the gate
 *   for the retry). A marked frame still captures when the gate is cold.
 *
 * `windowMs: 0` disables gating entirely (always active — the legacy eager
 * behaviour).
 */
export class LeaseActivityGate {
  private armedUntil = 0
  private disabledUntil = 0

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Open (or slide) the demand window from now. A no-op while disabled. */
  arm(): void {
    if (this.windowMs === 0) return
    this.armedUntil = this.now() + this.windowMs
  }

  /**
   * Force the gate closed regardless of demand for `cooldownMs` — for a
   * download path that has PROVEN broken (an add/receive failure). Rebuilding
   * the vaapi filtergraph per failing frame both leaks (node-av reclaims hw
   * pools only by process exit) and burns GPU churn, so a broken path must stay
   * off. Overrides `windowMs: 0` too.
   *
   * ## Why this is a COOLDOWN and not a latch
   *
   * It was a latch (`disable()`), held until {@link reset} — i.e. until the next
   * DIAL. On a continuously recording camera a dial lasts hours, so two EIO
   * `hwdownload` failures killed the native lease for the whole session and
   * every detail dispatch's rung-1 crop missed for as long as it ran. That is
   * the 93-97% `nativeCropMisses` measured on 2026-08-08: dev 618 had 24 dials
   * disabled in a single day, and dev 592 serviced ~15 crop requests/s for
   * 500 s with a `leaseOffered` delta of exactly 0 — `arm()` firing constantly
   * against a gate that could never reopen.
   *
   * The OOM guard the latch existed for is preserved by the cooldown's LENGTH,
   * not by its permanence: one filtergraph rebuild per cooldown instead of one
   * per frame. The caller escalates `cooldownMs` on repeated failures, so a
   * genuinely broken dial converges on the old behaviour while a transient GPU
   * fault recovers on its own.
   *
   * A later call always wins, even a shorter one: the caller escalates
   * monotonically, and "the most recent failure decides" is the only rule that
   * stays true if it ever stops.
   */
  disableFor(cooldownMs: number): void {
    this.disabledUntil = this.now() + cooldownMs
  }

  /** New dial: clear the cooldown AND any stale demand (caller re-arms explicitly). */
  reset(): void {
    this.disabledUntil = 0
    this.armedUntil = 0
  }

  /** Whether lease capture should run for the current frame. */
  get active(): boolean {
    if (this.now() < this.disabledUntil) return false
    if (this.windowMs === 0) return true
    return this.now() < this.armedUntil
  }
}
