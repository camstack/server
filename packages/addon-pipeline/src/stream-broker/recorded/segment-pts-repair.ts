/**
 * segment-pts-repair — make a recorded segment's media timeline fit the window
 * the recorder measured for it.
 *
 * ## Why this exists
 *
 * The feeder paces access units by the PTS deltas it reads out of a `.m4s` it
 * did not write, and it sleeps those deltas out with no bound. That is fine as
 * long as the file's stamps mean what they say. On device 4374 (a Dreame robot
 * behind an `rfc4571` relay) they stopped meaning it: every segment written
 * between 20:31:20 and 20:38:35 on 2026-09-06 carries its first — key — frame
 * at PTS 0 and every following frame between +53 s and +101 s, growing ~2.3 s
 * per 10 s segment. `ffprobe` on `1788719780000-9955-1259868.m4s`:
 *
 * ```
 * duration=83.360900          # the recorder measured durMs=9955
 * packet,0.000000,K__         # the IDR
 * packet,73.494500,___        # the next frame, 73.5 s "later"
 * ...
 * packet,83.340500,___        # 150 packets spanning a correct 9.85 s
 * ```
 *
 * The frames are all there and correctly spaced among themselves; only the
 * offset between the key frame and the rest is fabricated. `paceSegment` read
 * that as "the next frame is due in 65 s", slept, and the operator watched a
 * frozen picture until the player was torn down —
 * `recorded:play-census {deviceId=4374 reason=stop pacedAus=150 segments=1
 * cursorMs=1788719788356}`, the cursor never having moved off the seek target.
 * Scrubbing kept working because a scrub decodes ONE key frame per position and
 * never consults an inter-frame delta.
 *
 * ## The rule
 *
 * **A segment's media timeline must fit the window the recorder measured for
 * it.** `durMs` is already the authority everywhere else in the feeder — the
 * cursor arithmetic (`startMs + (ptsMs - firstPtsMs)`), `clampIntoSegment`, and
 * the forward lookahead's `prepareNext(startMs + durMs)` all read it — so an
 * inter-AU gap LARGER than `durMs` is provably not footage: no segment can hold
 * more silence than it holds time. Such a gap is collapsed to the segment's own
 * median cadence and the caller is told, so the fault is logged per camera
 * rather than slept out in silence.
 *
 * A gap that still fits the window is left exactly as it is: a camera that
 * really stalled for 4 s inside a 10 s segment recorded 4 s of stall, and the
 * viewer must see it that way.
 */

/** Reads the stamp off one access unit. */
export type PtsReader<T> = (au: T) => number
/** Rebuilds one access unit with a new stamp; the payload must ride through. */
export type PtsWriter<T> = (au: T, ptsMs: number) => T

/** What a repair pass did, for the caller's log line. */
export interface SegmentPtsRepair<T> {
  /** The series to pace — the input array itself when nothing was wrong. */
  readonly aus: readonly T[]
  /** True when at least one stamp was rewritten. */
  readonly repaired: boolean
  /** How many inter-AU gaps could not fit the declared window. */
  readonly discontinuities: number
  /** Total milliseconds of fabricated gap removed. */
  readonly collapsedMs: number
  /** `last - first` before the repair. */
  readonly spanBeforeMs: number
  /** `last - first` after it. */
  readonly spanAfterMs: number
}

function median(values: readonly number[]): number {
  const sorted = values.toSorted((a, b) => a - b)
  const mid = sorted.length >> 1
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
}

function untouched<T>(aus: readonly T[], read: PtsReader<T>): SegmentPtsRepair<T> {
  const first = aus[0]
  const last = aus[aus.length - 1]
  const span = first !== undefined && last !== undefined ? read(last) - read(first) : 0
  return {
    aus,
    repaired: false,
    discontinuities: 0,
    collapsedMs: 0,
    spanBeforeMs: span,
    spanAfterMs: span,
  }
}

/**
 * Rewrite the stamps of `aus` so no inter-AU gap exceeds `durMs`, the window
 * the recorder measured for this segment.
 *
 * Returns the INPUT array unchanged (same identity, so a healthy segment costs
 * nothing) when there is nothing to repair, when there are fewer than two units
 * to compare, or when `durMs` is not a usable window — with no declared window
 * there is no authority to judge a gap against, and inventing one would be
 * worse than pacing what the file says.
 */
export function repairSegmentPts<T>(
  aus: readonly T[],
  durMs: number,
  read: PtsReader<T>,
  write: PtsWriter<T>,
): SegmentPtsRepair<T> {
  if (aus.length < 2 || !Number.isFinite(durMs) || durMs <= 0) return untouched(aus, read)

  const gaps: number[] = []
  let faults = 0
  for (let i = 1; i < aus.length; i++) {
    const prev = aus[i - 1]
    const cur = aus[i]
    if (prev === undefined || cur === undefined) return untouched(aus, read)
    const gap = read(cur) - read(prev)
    gaps.push(gap)
    if (gap > durMs) faults++
  }
  if (faults === 0) return untouched(aus, read)

  // The cadence a collapsed gap becomes: this segment's own median healthy
  // spacing. With no healthy gap left to measure (every stamp is a fault) the
  // only honest cadence is an even spread across the declared window.
  const healthy = gaps.filter((g) => g <= durMs)
  const cadenceMs = healthy.length > 0 ? median(healthy) : durMs / gaps.length

  const first = aus[0]
  if (first === undefined) return untouched(aus, read)
  const repaired: T[] = [first]
  let shiftMs = 0
  let collapsedMs = 0
  for (let i = 1; i < aus.length; i++) {
    const au = aus[i]
    if (au === undefined) return untouched(aus, read)
    const gap = gaps[i - 1] ?? 0
    if (gap > durMs) {
      const removed = gap - cadenceMs
      shiftMs += removed
      collapsedMs += removed
    }
    repaired.push(write(au, read(au) - shiftMs))
  }

  const lastIn = aus[aus.length - 1]
  const lastOut = repaired[repaired.length - 1]
  return {
    aus: repaired,
    repaired: true,
    discontinuities: faults,
    collapsedMs,
    spanBeforeMs: lastIn === undefined ? 0 : read(lastIn) - read(first),
    spanAfterMs: lastOut === undefined ? 0 : read(lastOut) - read(first),
  }
}
