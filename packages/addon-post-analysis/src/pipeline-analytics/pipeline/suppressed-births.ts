/**
 * How many rejected ids a device remembers AFTER the tracker stopped carrying
 * them. An id's `leaving` / zone-exit events fire for a track that is absent
 * from the frame by definition — the frame it is lost or a few frames later —
 * so the event path must still recognise it once `retain` dropped it. Track ids
 * are never reused; the bound only caps memory on a phantom-heavy camera.
 */
export const RETIRED_REJECTIONS_PER_DEVICE = 256

/**
 * Memory of births the confirmation gate rejected, per device.
 *
 * The gate runs AFTER the TrackStore upsert, and it has to: the upsert's
 * position count is what distinguishes a true birth from a tracker
 * resurrection. So a rejected birth has already been written by the time the
 * verdict exists. It correctly gets no `start`, no media and no notification —
 * but the record stayed, and surfaced in `listRecentTracks`. On 2026-07-31 six
 * full-frame phantoms on device 101 in nine minutes were every one of them
 * suppressed AND listed.
 *
 * Retracting once is not enough. The tracker keeps carrying a rejected id for
 * as long as the phantom persists — 27 seconds in the worst measured case — and
 * every later frame would write it straight back. So the rejection is
 * remembered until the id stops being tracked, and only then forgotten.
 *
 * Kept as its own module because the state is the part with real risk: forget
 * too early and the phantom returns, never forget and a camera producing
 * phantoms continuously grows this set for the process's lifetime.
 */
export class SuppressedBirthRegistry {
  private readonly byDevice = new Map<string, Set<string>>()
  /** Rejected ids the tracker no longer carries, oldest first (bounded). */
  private readonly retired = new Map<string, Set<string>>()
  /** Rejected ids whose per-frame skip has already been reported once. */
  private readonly skipReported = new Map<string, Set<string>>()

  /** Record that this birth was rejected; later frames must not re-upsert it. */
  reject(deviceKey: string, trackId: string): void {
    let ids = this.byDevice.get(deviceKey)
    if (!ids) {
      ids = new Set<string>()
      this.byDevice.set(deviceKey, ids)
    }
    ids.add(trackId)
  }

  isRejected(deviceKey: string, trackId: string): boolean {
    return this.byDevice.get(deviceKey)?.has(trackId) === true
  }

  /**
   * True when an event naming this id must be dropped: the birth was rejected,
   * whether the tracker still carries the id or already let it go. A rejected
   * birth is a track that never existed — it has no `left`, no zone exit.
   */
  suppressesEvents(deviceKey: string, trackId: string): boolean {
    return this.isRejected(deviceKey, trackId) || this.retired.get(deviceKey)?.has(trackId) === true
  }

  /**
   * True the FIRST time a rejected id's frame work is skipped (so the host logs
   * one line per id, not one per frame); false afterwards.
   */
  firstSkip(deviceKey: string, trackId: string): boolean {
    let ids = this.skipReported.get(deviceKey)
    if (!ids) {
      ids = new Set<string>()
      this.skipReported.set(deviceKey, ids)
    }
    if (ids.has(trackId)) return false
    ids.add(trackId)
    return true
  }

  /**
   * Forget every rejected id the tracker is no longer carrying.
   *
   * Called once per frame with the ids present THIS frame. An id absent from
   * that set can never be upserted again, so it leaves the live set — but it
   * moves to the bounded retired memory, because its `leaving` / zone-exit
   * events fire exactly when it is absent (`suppressesEvents`).
   */
  retain(deviceKey: string, currentTrackIds: ReadonlySet<string>): void {
    const reported = this.skipReported.get(deviceKey)
    if (reported) {
      for (const id of reported) {
        if (!currentTrackIds.has(id)) reported.delete(id)
      }
      if (reported.size === 0) this.skipReported.delete(deviceKey)
    }
    const ids = this.byDevice.get(deviceKey)
    if (!ids) return
    for (const id of ids) {
      if (currentTrackIds.has(id)) continue
      ids.delete(id)
      this.retire(deviceKey, id)
    }
    if (ids.size === 0) this.byDevice.delete(deviceKey)
  }

  private retire(deviceKey: string, trackId: string): void {
    let ids = this.retired.get(deviceKey)
    if (!ids) {
      ids = new Set<string>()
      this.retired.set(deviceKey, ids)
    }
    ids.add(trackId)
    while (ids.size > RETIRED_REJECTIONS_PER_DEVICE) {
      const oldest = ids.values().next()
      if (oldest.done === true) break
      ids.delete(oldest.value)
    }
  }

  /** Rejected ids currently held for a device — diagnostics and tests. */
  size(deviceKey: string): number {
    return this.byDevice.get(deviceKey)?.size ?? 0
  }

  /** Drop a device's memory wholesale (device removed / pipeline reset). */
  clearDevice(deviceKey: string): void {
    this.byDevice.delete(deviceKey)
    this.skipReported.delete(deviceKey)
    this.retired.delete(deviceKey)
  }
}
