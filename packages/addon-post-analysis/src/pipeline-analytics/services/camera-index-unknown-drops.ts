/**
 * The drops of `camera-index-unknown`, SUMMARISED.
 *
 * While the camera index has not answered (D49), every sensor state change
 * that no camera takes a row for is refused an evaluation — and on a cold
 * start with the device manager unreachable that includes every camera's
 * native `motion`, at bus rate. A branch that drops work says so, but here it
 * says it as a COUNT: one line per (device, cap) per window, the same pattern
 * as {@link SensorTransitionGate.takeDropSummary}.
 *
 * The window is short — the index refreshes every minute, so a gap is either
 * closing or it is an outage an operator needs to see soon.
 */

/** One minute: the camera index TTL, so each summary covers ~one rebuild. */
export const DEFAULT_INDEX_UNKNOWN_SUMMARY_WINDOW_MS = 60_000

/** One (device, cap) row of a drop summary. */
export interface CameraIndexUnknownDropCount {
  readonly deviceId: number
  readonly capName: string
  readonly count: number
}

export class CameraIndexUnknownDrops {
  private readonly drops = new Map<string, CameraIndexUnknownDropCount>()
  private windowStartedAt: number
  private readonly windowMs: number

  constructor(options: { readonly nowMs: number; readonly windowMs?: number }) {
    this.windowStartedAt = options.nowMs
    this.windowMs = options.windowMs ?? DEFAULT_INDEX_UNKNOWN_SUMMARY_WINDOW_MS
  }

  record(deviceId: number, capName: string): void {
    const key = `${deviceId}:${capName}`
    const prior = this.drops.get(key)
    this.drops.set(key, { deviceId, capName, count: (prior?.count ?? 0) + 1 })
  }

  /**
   * The window's drops, sorted by `(deviceId, capName)`, once the window has
   * elapsed; [] before that or when nothing dropped. Taking resets the window.
   */
  takeSummary(nowMs: number): readonly CameraIndexUnknownDropCount[] {
    if (nowMs - this.windowStartedAt < this.windowMs) return []
    this.windowStartedAt = nowMs
    if (this.drops.size === 0) return []
    const out = [...this.drops.values()].sort(
      (a, b) => a.deviceId - b.deviceId || a.capName.localeCompare(b.capName),
    )
    this.drops.clear()
    return out
  }
}
