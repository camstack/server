/**
 * When may a battery camera re-probe its accessories on a natural wake?
 *
 * The kernel prunes a vanished accessory only after a SECOND complete probe
 * with an advanced `lastProbedAt` (`AccessoryShrinkGate`, D49), and a battery
 * camera probes once at adoption — so a ghost accessory (a PIR switch the
 * camera never had) would survive until a provider restart. A wake is the one
 * free moment to read the ability table again; this window keeps that to once
 * per `ACCESSORY_REPROBE_WINDOW_MS`, never overlapping, never issuing a wake.
 */

export const ACCESSORY_REPROBE_WINDOW_MS = 6 * 60 * 60_000

export class AccessoryReprobeWindow {
  #lastAttemptAt = 0
  #inFlight = false

  /**
   * True (and the attempt is recorded) when the last complete probe AND the
   * last attempt are both older than the window and none is in flight. An
   * attempt counts even when it fails, so a camera whose probe keeps failing
   * is still tried at most once per window.
   */
  tryBegin(now: number, lastProbedAt: number): boolean {
    if (this.#inFlight) return false
    const last = Math.max(lastProbedAt, this.#lastAttemptAt)
    if (now - last < ACCESSORY_REPROBE_WINDOW_MS) return false
    this.#lastAttemptAt = now
    this.#inFlight = true
    return true
  }

  end(): void {
    this.#inFlight = false
  }
}
