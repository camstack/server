/**
 * When may a battery camera re-probe its accessories on a natural wake?
 *
 * The kernel prunes a vanished accessory only after a SECOND complete probe
 * with an advanced `lastProbedAt` (`AccessoryShrinkGate`, D49), and a battery
 * camera probes once at adoption — so a ghost accessory (a PIR switch the
 * camera never had) would survive until a provider restart. A wake is the one
 * free moment to read the ability table again.
 *
 * The window is consumed only by a probe that RAN (`lastProbedAt` advanced). A
 * probe that was skipped (camera asleep again) or failed leaves `lastProbedAt`
 * alone, so the next first-hand wake may retry — but not before
 * `ACCESSORY_REPROBE_RETRY_MS`.
 */
import type { SleepCommitSource } from './sleep-state-decision.js'

export const ACCESSORY_REPROBE_WINDOW_MS = 6 * 60 * 60_000
export const ACCESSORY_REPROBE_RETRY_MS = 10 * 60_000

/**
 * A wake the camera itself (or our own look at it) reported. `hub-reconcile`
 * and `hub-summary` come from the parent's periodic sweep, which lags the real
 * state by minutes: a probe driven by one can log in and WAKE a standalone UDP
 * battery camera that fell asleep again, so they never trigger a re-probe.
 */
export function isFirstHandWake(reason: SleepCommitSource): boolean {
  return reason === 'simple-event' || reason === 'sleep-poll' || reason === 'confirmed-wake'
}

export class AccessoryReprobeWindow {
  #lastAttemptAt = 0
  #inFlight = false

  /**
   * True (and the attempt is recorded) when the last probe that ran is older
   * than the window, the last attempt is older than the retry gap, and none is
   * in flight.
   */
  tryBegin(now: number, lastProbedAt: number): boolean {
    if (this.#inFlight) return false
    if (now - lastProbedAt < ACCESSORY_REPROBE_WINDOW_MS) return false
    if (this.#lastAttemptAt > 0 && now - this.#lastAttemptAt < ACCESSORY_REPROBE_RETRY_MS) {
      return false
    }
    this.#lastAttemptAt = now
    this.#inFlight = true
    return true
  }

  end(): void {
    this.#inFlight = false
  }
}
