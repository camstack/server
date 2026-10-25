/**
 * MotionOnsetRegistry — the reference instant the birth-latency proxy is
 * measured FROM (D409).
 *
 * One entry per device: the timestamp of the last motion RISING EDGE, and how
 * many birth decisions have been taken since it. Nothing else. It is read on
 * the frame path, so it is two `Map` operations and no clock of its own — the
 * caller supplies every timestamp, exactly as `DeferredBirthRegistry` next door
 * does, and for the same reason (a module that reads the clock cannot be tested
 * against one).
 *
 * **Why the RISING edge and not the last motion sample.** The question is "when
 * did something start happening on this camera", so the sample stream's
 * heartbeats are noise: an onset refreshed every 5 s while motion stays on
 * would measure the distance to the last heartbeat, which is bounded by the
 * heartbeat and therefore says nothing. Only the off→on transition moves it.
 *
 * **Why a burst is never CLOSED here.** A falling edge is deliberately not
 * modelled. The proxy wants "the most recent instant something began", and a
 * subject that walks in, stops, and is only then detected has a burst that
 * closed before its birth — a closed burst is still the right reference. What
 * stops a stale reference from being quoted is the WINDOW, applied by
 * `buildBirthDecisionRecord` (`MAX_BIRTH_LATENCY_PROXY_MS`), not a state
 * machine here. One mechanism, in one place.
 *
 * Measurement only. Nothing gates on this and nothing about a track changes
 * because of it.
 */

interface MotionBurst {
  readonly onsetAtMs: number
  /** Birth decisions already counted against this burst. */
  births: number
}

export class MotionOnsetRegistry {
  private readonly byDevice = new Map<number, MotionBurst>()

  /**
   * Motion went off→on at `atMs`. Opens a new burst, discarding the previous
   * one's birth count — a new burst is a new subject population.
   */
  noteRisingEdge(deviceId: number, atMs: number): void {
    this.byDevice.set(deviceId, { onsetAtMs: atMs, births: 0 })
  }

  /** The open burst's onset, or `null` for a device with no reference. */
  onsetFor(deviceId: number): number | null {
    return this.byDevice.get(deviceId)?.onsetAtMs ?? null
  }

  /**
   * Count one birth decision against this device's burst and return its 0-based
   * index — `null` when there is no burst to count it against.
   *
   * Index 0 is the only index at which the burst plausibly belongs to the same
   * subject as the birth; the ledger records the index rather than filtering
   * here, so the reader can see how often it is not 0.
   */
  noteBirth(deviceId: number): number | null {
    const burst = this.byDevice.get(deviceId)
    if (burst === undefined) return null
    const index = burst.births
    burst.births += 1
    return index
  }

  /** Drop a device's reference (device removed / pipeline reset). */
  forgetDevice(deviceId: number): void {
    this.byDevice.delete(deviceId)
  }
}
