/**
 * How long a camera waits, after `attachCamera`, before a decoded frame
 * actually reaches the detection queue.
 *
 * The orchestrator already measures `session motion → attach latency` and it
 * is small — 11, 13 and 18 ms across three consecutive sessions on the same
 * camera. What nothing measured is the NEXT leg: from the attach to the first
 * frame the detector is given. An operator reporting "detection starts late"
 * is describing that leg, and answering them required reading the timestamps
 * of unrelated INFO lines and inferring — which produced a wrong first answer
 * (the absence of a `frame processed` line means the frame produced nothing
 * notable, not that no frame arrived).
 *
 * One number, once per attach, so a slow start is a value rather than an
 * inference.
 */

/** Pending attach marks, keyed by device. */
export class FirstDetectionFrameTimer {
  private readonly attachedAt = new Map<number, number>()

  /** A camera attached. Replaces any pending mark: the newest attach is the
   *  one the next frame belongs to. */
  markAttached(deviceId: number, nowMs: number): void {
    this.attachedAt.set(deviceId, nowMs)
  }

  /**
   * A decoded frame was admitted to the detection queue. Returns the elapsed
   * ms since the attach the FIRST time it is called after one, and `null`
   * every time after — so the caller logs once per attach, not once per frame.
   */
  takeLatency(deviceId: number, nowMs: number): number | null {
    const at = this.attachedAt.get(deviceId)
    if (at === undefined) return null
    this.attachedAt.delete(deviceId)
    // A clock that went backwards reports 0 rather than a negative duration:
    // the number is read as a latency, and a negative one is noise nobody can
    // act on.
    return Math.max(0, nowMs - at)
  }

  /** A camera detached with no frame ever admitted — drop the mark so the
   *  NEXT attach is not measured from this one. Returns whether one was
   *  pending, which is itself the interesting fact: a session that ran and
   *  fed the detector nothing. */
  forget(deviceId: number): boolean {
    return this.attachedAt.delete(deviceId)
  }
}
