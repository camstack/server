/**
 * Rest for a camera that could not answer a native snapshot.
 *
 * The wrapper is polled — grids, cards, the media plane — and every miss used
 * to be followed by another ISAPI/CGI dial on the next poll. On a camera that
 * is already struggling ("Camera retro casa" answered HTTP 503 to 68
 * native dials in one hour on 2026-09-05) that is the load that keeps it
 * struggling. So a miss earns a rest window during which the native provider
 * is NOT dialled: the request falls through to the stream-broker frame grab
 * and the stale cache, which cost the camera nothing. The window doubles with
 * consecutive misses and is capped; the first frame that lands ends it.
 *
 * Generic on purpose: every vendor's native provider sits behind this one
 * wrapper, so one ledger here covers them all (D62 spirit: one owner).
 * `force` bypasses it — an operator's deliberate wake is never held back.
 */

export interface NativeSnapshotFatigueOptions {
  /** Rest after the first miss. */
  readonly baseMs?: number
  /** Longest rest a streak can earn. */
  readonly maxMs?: number
}

export interface FatigueVerdict {
  readonly streak: number
  readonly restMs: number
}

interface FatigueEntry {
  streak: number
  restingUntil: number
}

export const NATIVE_SNAPSHOT_REST_BASE_MS = 10_000
export const NATIVE_SNAPSHOT_REST_MAX_MS = 300_000

export class NativeSnapshotFatigue {
  private readonly baseMs: number
  private readonly maxMs: number
  private readonly entries = new Map<number, FatigueEntry>()

  constructor(options: NativeSnapshotFatigueOptions = {}) {
    this.baseMs = options.baseMs ?? NATIVE_SNAPSHOT_REST_BASE_MS
    this.maxMs = options.maxMs ?? NATIVE_SNAPSHOT_REST_MAX_MS
  }

  /** The instant the rest ends, or `null` when the camera may be dialled now. */
  restingUntil(deviceId: number, now: number): number | null {
    const entry = this.entries.get(deviceId)
    if (entry === undefined || entry.restingUntil <= now) return null
    return entry.restingUntil
  }

  /** A dial that did not produce a frame — thrown or answered `null`. */
  recordFailure(deviceId: number, now: number): FatigueVerdict {
    const streak = (this.entries.get(deviceId)?.streak ?? 0) + 1
    const restMs = Math.min(this.maxMs, this.baseMs * 2 ** (streak - 1))
    this.entries.set(deviceId, { streak, restingUntil: now + restMs })
    return { streak, restMs }
  }

  /** A frame landed: the camera is answering again. */
  recordSuccess(deviceId: number): void {
    this.entries.delete(deviceId)
  }

  forget(deviceId: number): void {
    this.entries.delete(deviceId)
  }
}
