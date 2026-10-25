/**
 * What the cameras are doing RIGHT NOW, as the digest producer needs to know it.
 *
 * Two facts and nothing else:
 *
 *  1. **when motion was last seen** on each camera — this is what OPENS and
 *     EXTENDS a motion window;
 *  2. **which tracks are still open** — this is the track-close barrier's input.
 *
 * Both are fed in-process from the notification centre's existing intake hooks
 * (`onObjectEventPersisted` for the first, `onTrackClosed` for the second), so
 * this module subscribes to nothing, emits nothing and owns no timer. The
 * producer asks it questions on its own tick.
 *
 * ## Why the open-track map is GLOBAL and not per rule
 *
 * Rules overlap: three rules can name the same camera. A per-rule map would
 * hold three entries for one track and would have to be reconciled on every
 * rule edit — and a rule that gained a camera mid-window would start with an
 * empty barrier for it and render past a subject still walking. One map keyed
 * by trackId, filtered by the rule's cameras at read time, cannot drift.
 *
 * ## Everything here is bounded
 *
 * A track that never closes (a resident stationary object, a crash between the
 * open and the close hook) would otherwise pin a barrier open forever and its
 * entry would live in this map for the life of the process. {@link sweep}
 * drops entries older than {@link OPEN_TRACK_MAX_AGE_MS} and returns how many
 * it dropped, so the producer can put the number on a log line instead of the
 * map growing in silence.
 */

/** How long a track may stay "open" here before it is assumed lost. Six hours:
 *  longer than any real passage, shorter than a night. */
export const OPEN_TRACK_MAX_AGE_MS = 6 * 3600_000

/** Hard ceiling on the map, so a pathological producer cannot exhaust the heap
 *  between two sweeps. Oldest entries go first. */
const OPEN_TRACK_MAX_ENTRIES = 5_000

interface OpenTrack {
  readonly deviceId: number
  /** When this track was FIRST observed here — its window membership test. */
  readonly openedAtMs: number
}

/**
 * What one camera has seen since the last window closed on it.
 *
 * BOTH ends are kept, and the first one is the load-bearing half: the producer
 * only asks on its tick, so a window derived from the LAST motion alone would
 * open wherever the tick happened to land — up to a whole tick after the motion
 * that should have opened it, and permanently so on a camera that never goes
 * quiet. `firstMotionMs` is what makes a window start where the activity did.
 */
interface DeviceMotion {
  readonly firstMotionMs: number
  readonly lastMotionMs: number
}

/** The motion window a rule currently holds open. */
export interface RuleMotionState {
  readonly openedAtMs: number
  readonly lastMotionMs: number
}

export class NcSummaryCollector {
  private readonly openTracks = new Map<string, OpenTrack>()
  /** First+last motion per camera SINCE that camera's last window close. The
   *  union across a rule's cameras is what opens and keeps a window alive. */
  private readonly motionByDevice = new Map<number, DeviceMotion>()
  /** Per-rule motion window. Absent = no window open for that rule. */
  private readonly motionByRule = new Map<string, RuleMotionState>()

  /**
   * Motion was observed on a camera. Called once per persisted object event —
   * the cheapest true signal of "something is happening" this process has.
   *
   * `trackId` is optional because the slim event projection omits it; an event
   * without one still counts as motion, it simply contributes no barrier entry.
   */
  observeMotion(input: {
    readonly deviceId: number
    readonly atMs: number
    readonly trackId?: string
  }): void {
    const previous = this.motionByDevice.get(input.deviceId)
    this.motionByDevice.set(
      input.deviceId,
      previous === undefined
        ? { firstMotionMs: input.atMs, lastMotionMs: input.atMs }
        : {
            firstMotionMs: Math.min(previous.firstMotionMs, input.atMs),
            lastMotionMs: Math.max(previous.lastMotionMs, input.atMs),
          },
    )
    if (input.trackId === undefined) return
    if (this.openTracks.has(input.trackId)) return
    if (this.openTracks.size >= OPEN_TRACK_MAX_ENTRIES) this.evictOldest()
    this.openTracks.set(input.trackId, {
      deviceId: input.deviceId,
      openedAtMs: input.atMs,
    })
  }

  /** A track closed — the tracker's own single close point. */
  observeTrackClosed(trackId: string): void {
    this.openTracks.delete(trackId)
  }

  /**
   * The span of motion across these cameras since their last window close, or
   * null when none of them has seen any.
   */
  motionAcross(deviceIds: readonly number[]): DeviceMotion | null {
    let first = Number.MAX_SAFE_INTEGER
    let last = 0
    for (const deviceId of deviceIds) {
      const seen = this.motionByDevice.get(deviceId)
      if (seen === undefined) continue
      if (seen.firstMotionMs < first) first = seen.firstMotionMs
      if (seen.lastMotionMs > last) last = seen.lastMotionMs
    }
    return last === 0 ? null : { firstMotionMs: first, lastMotionMs: last }
  }

  /**
   * How many of this rule's cameras still have a track open that STARTED inside
   * the window — the barrier's count.
   *
   * The `openedAtMs >= sinceMs` test is what stops a track that began hours
   * before the window from holding it: that track is not part of this digest,
   * and waiting for it would make a rule with one resident object undeliverable.
   */
  openTrackCount(deviceIds: readonly number[], sinceMs: number): number {
    const wanted = new Set(deviceIds)
    let count = 0
    for (const open of this.openTracks.values()) {
      if (wanted.has(open.deviceId) && open.openedAtMs >= sinceMs) count += 1
    }
    return count
  }

  /** The ids behind {@link openTrackCount} — for the log line when the barrier
   *  is broken, because "2 tracks" is not diagnosable and two ids are. */
  openTrackIds(deviceIds: readonly number[], sinceMs: number): readonly string[] {
    const wanted = new Set(deviceIds)
    const out: string[] = []
    for (const [trackId, open] of this.openTracks) {
      if (wanted.has(open.deviceId) && open.openedAtMs >= sinceMs) out.push(trackId)
    }
    return out
  }

  /** The rule's currently open motion window, or null. */
  motionWindow(ruleId: string): RuleMotionState | null {
    return this.motionByRule.get(ruleId) ?? null
  }

  /**
   * Bring a rule's motion window up to date against the observed motion.
   *
   * Opening and extending are the SAME operation seen from two states, so they
   * are one function: a rule with no window that sees motion opens one at that
   * instant; a rule with a window that sees newer motion extends it. Motion
   * older than the window's own `lastMotionMs` changes nothing, which makes
   * this idempotent and safe to call on every tick.
   */
  refreshMotionWindow(ruleId: string, deviceIds: readonly number[]): RuleMotionState | null {
    const motion = this.motionAcross(deviceIds)
    if (motion === null) return this.motionByRule.get(ruleId) ?? null
    const existing = this.motionByRule.get(ruleId)
    if (existing === undefined) {
      // Opens where the ACTIVITY started, not where the tick landed.
      const opened: RuleMotionState = {
        openedAtMs: motion.firstMotionMs,
        lastMotionMs: motion.lastMotionMs,
      }
      this.motionByRule.set(ruleId, opened)
      return opened
    }
    if (motion.lastMotionMs <= existing.lastMotionMs) return existing
    const extended: RuleMotionState = {
      ...existing,
      lastMotionMs: motion.lastMotionMs,
    }
    this.motionByRule.set(ruleId, extended)
    return extended
  }

  /**
   * Forget a rule's window — called once it has been produced (or abandoned).
   *
   * A camera whose last motion is at or before the close is cleared outright:
   * it is quiet, and the next window should wait for it to move again. A camera
   * still busy keeps its mark, and its `firstMotionMs` is CLAMPED to the close
   * — which is what makes back-to-back windows on a permanently busy camera
   * contiguous instead of overlapping. Without the clamp the next window would
   * re-open at the original first motion and re-deliver the same passage.
   */
  closeMotionWindow(ruleId: string, atMs: number): void {
    this.motionByRule.delete(ruleId)
    for (const [deviceId, seen] of this.motionByDevice) {
      if (seen.lastMotionMs <= atMs) {
        this.motionByDevice.delete(deviceId)
        continue
      }
      if (seen.firstMotionMs < atMs) {
        this.motionByDevice.set(deviceId, { ...seen, firstMotionMs: atMs })
      }
    }
  }

  /** Drop rules that no longer exist, so a deleted rule cannot leak a window. */
  retainRules(ruleIds: readonly string[]): void {
    const alive = new Set(ruleIds)
    for (const ruleId of Array.from(this.motionByRule.keys())) {
      if (!alive.has(ruleId)) this.motionByRule.delete(ruleId)
    }
  }

  /**
   * Drop tracks that were never closed. @returns how many were abandoned — a
   * number that belongs on a log line, because a non-zero one means the close
   * hook is missing closes and every barrier is silently degraded.
   */
  sweep(nowMs: number): number {
    let dropped = 0
    for (const [trackId, open] of this.openTracks) {
      if (nowMs - open.openedAtMs > OPEN_TRACK_MAX_AGE_MS) {
        this.openTracks.delete(trackId)
        dropped += 1
      }
    }
    return dropped
  }

  /** Observability — the producer puts this on its tick line. */
  stats(): {
    readonly openTracks: number
    readonly cameras: number
    readonly windows: number
  } {
    return {
      openTracks: this.openTracks.size,
      cameras: this.motionByDevice.size,
      windows: this.motionByRule.size,
    }
  }

  private evictOldest(): void {
    let oldestId: string | null = null
    let oldestAt = Number.MAX_SAFE_INTEGER
    for (const [trackId, open] of this.openTracks) {
      if (open.openedAtMs < oldestAt) {
        oldestAt = open.openedAtMs
        oldestId = trackId
      }
    }
    if (oldestId !== null) this.openTracks.delete(oldestId)
  }
}
