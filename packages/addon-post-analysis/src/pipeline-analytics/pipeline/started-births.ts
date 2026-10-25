/**
 * Memory of births whose ritual has already RUN, per device+source.
 *
 * A birth is a decision, and a decision is taken once. Until 2026-09-07 it
 * could be taken twice, on camera 101 it routinely was, and the second vote
 * won:
 *
 *   04:59:38.335Z  confirmation gate: birth confirmed  {trackId=f585b2ee…
 *                  className=animal bestScore=0.7068}
 *   04:59:38.335Z  track started                       {trackId=f585b2ee…}
 *   04:59:38.821Z  confirmation gate: birth suppressed (false positive)
 *                  {trackId=f585b2ee… className=animal}     ← no bestScore:
 *                  the second crop held no compatible detection AT ALL
 *   04:59:38.821Z  birth suppressed — track record retracted
 *
 * TWO conditions have to meet, and both are structural:
 *
 *  1. `processFrame` reads `lastActiveTrackIds` at the top and writes it at the
 *     bottom, and AWAITS the confirmation gate in between (a crop round trip to
 *     the frame's node plus a re-detection: 130–490 ms measured on this camera,
 *     against 100 ms frame spacing). Several frames are therefore in flight at
 *     once and each of them sees the same fresh id as unjudged.
 *  2. The other birth discriminator, `positionsCount > 1`, does not close the
 *     gap either: a COASTED frame deliberately appends no position
 *     (`TrackStore.upsert`, `matched: false`), so a track the full-frame pass
 *     cannot see — which is the entire premise of the small-subject recovery —
 *     keeps exactly one position for as long as it coasts, and
 *     `classifyTrackAppearance` keeps answering `birth`.
 *
 * So the id that has already been born is remembered HERE, and both halves of
 * the birth path consult it: it is not offered to the gate again, and a verdict
 * that arrives for it anyway cannot retract it. Same lifetime discipline as
 * {@link SuppressedBirthRegistry} — held while the tracker still carries the
 * id, forgotten the frame it stops.
 */
export class StartedBirthRegistry {
  private readonly byDevice = new Map<string, Set<string>>()

  /** Record that this id's birth ritual ran — `start`, firstFrame, the lot. */
  markStarted(deviceKey: string, trackId: string): void {
    let ids = this.byDevice.get(deviceKey)
    if (!ids) {
      ids = new Set<string>()
      this.byDevice.set(deviceKey, ids)
    }
    ids.add(trackId)
  }

  hasStarted(deviceKey: string, trackId: string): boolean {
    return this.byDevice.get(deviceKey)?.has(trackId) === true
  }

  /**
   * Forget every started id the tracker is no longer carrying. Called once per
   * frame with the ids present THIS frame — an id the tracker has dropped can
   * never be re-offered as a birth, so holding it serves nothing.
   */
  retain(deviceKey: string, currentTrackIds: ReadonlySet<string>): void {
    const ids = this.byDevice.get(deviceKey)
    if (!ids) return
    for (const id of ids) {
      if (!currentTrackIds.has(id)) ids.delete(id)
    }
    if (ids.size === 0) this.byDevice.delete(deviceKey)
  }

  /** Started ids currently held for a device — diagnostics and tests. */
  size(deviceKey: string): number {
    return this.byDevice.get(deviceKey)?.size ?? 0
  }

  /** Drop a device's memory wholesale (device removed / pipeline reset). */
  clearDevice(deviceKey: string): void {
    this.byDevice.delete(deviceKey)
  }
}
