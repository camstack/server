/**
 * Tripwire crossings for a tracked subject — the events nothing ever produced.
 *
 * ## What was missing
 *
 * `tripwireCrossing()` in `zones/geometry.ts` implements the detection,
 * direction included, by cross product. It had **zero callers — not one, not
 * even a test.** Everything else was in place: `ZoneKindEnum` carries
 * `'tripwire'`, `MaskLineShapeSchema` is in the shape union, the zone editor
 * offers **Add tripwire** and stores a 2-point line, `tripwire.cross` is in the
 * event taxonomy and the emitter maps it. So an operator could draw a tripwire,
 * see it rendered, and never receive a single notification from it.
 *
 * That is the same failure as the zone crossings ([D35]) one layer deeper, and
 * worse: the feature looks finished from the outside.
 *
 * ## Why a raw crossing is not enough
 *
 * A tripwire is drawn exactly where people linger — a doorway, a gate, a
 * driveway entrance. A bbox centroid wobbles by a few pixels between frames, so
 * a subject standing ON the line crosses it back and forth on consecutive
 * frames. Emitting per raw crossing would turn one person in a doorway into a
 * burst of notifications, which is the common case here rather than the corner
 * one.
 *
 * So a crossing must PERSIST to count: the subject has to still be on the far
 * side `confirmFrames` later. A wobble flips back and cancels itself.
 *
 * ## Why BOTH tests are needed
 *
 * Persistence alone would fire for someone walking AROUND the end of the wire —
 * the side of an infinite line changes without the segment ever being crossed.
 * Segment intersection alone fires on jitter. This requires both: the movement
 * must have intersected the segment, and the new side must hold.
 */
import { renameKey } from '../tracker-v2/rename.js'
import { tripwireCrossing, type LineSegment, type Point } from '../zones/geometry.js'

/**
 * Frames the subject must remain on the far side before a crossing is believed.
 *
 * Matches the zone tracker's entry bar (`DEFAULT_ENTER_FRAMES`): a crossing is
 * something the operator wants to hear about, so it is confirmed quickly — the
 * delay is what separates a passage from a wobble, not a safety margin.
 */
export const DEFAULT_TRIPWIRE_CONFIRM_FRAMES = 2

export interface TripwireConfig {
  readonly confirmFrames: number
}

/**
 * Which way the subject went over the wire.
 *
 * A tripwire is a DIRECTED line — its two points have an order, and that order
 * is what makes it different from a zone. `'in'` is a crossing towards the
 * right-hand side of the line as drawn (p1 → p2); `'out'` is the reverse. The
 * operator chooses which physical direction that means by drawing the line one
 * way round, which is exactly the control a tripwire is for: "someone came in
 * over the fence" is a different notification from "someone left".
 */
export type TripwireDirection = 'in' | 'out'

export interface TripwireCross {
  readonly wireId: string
  readonly direction: TripwireDirection
}

const NONE: readonly TripwireCross[] = []

interface WireState {
  /** Last centroid seen, for the movement segment. */
  last: Point
  /** Side of the line the subject is CONFIRMED to be on: -1, 0 or +1. */
  confirmedSide: number
  /** Side it has been seen on since, pending confirmation. */
  pendingSide: number
  /** Consecutive frames on `pendingSide`. */
  pendingFrames: number
  /** Whether the movement actually intersected the SEGMENT during the window. */
  sawIntersection: boolean
  /** Direction the pending crossing would report. */
  pendingDirection: TripwireDirection
}

/**
 * Which side of the directed line the point is on.
 *
 * Sign of the 2D cross product of the line's own vector with (point − p1):
 * positive is the right-hand side of p1 → p2. Exactly zero means ON the line,
 * which is deliberately its own value: it is neither side, so it can neither
 * confirm nor cancel a crossing.
 */
function sideOf(point: Point, wire: LineSegment): number {
  const cross =
    (wire.p2.x - wire.p1.x) * (point.y - wire.p1.y) -
    (wire.p2.y - wire.p1.y) * (point.x - wire.p1.x)
  if (cross > 0) return 1
  if (cross < 0) return -1
  return 0
}

export class TripwireTracker {
  private readonly config: TripwireConfig
  /** `trackId` → `wireId` → state. Keyed by track so `forget` is one delete. */
  private readonly tracks = new Map<string, Map<string, WireState>>()

  constructor(config: Partial<TripwireConfig> = {}) {
    this.config = { confirmFrames: DEFAULT_TRIPWIRE_CONFIRM_FRAMES, ...config }
  }

  /**
   * Feed one frame's centroid for one track against one wire.
   *
   * Returns the crossings CONFIRMED on this frame — usually none. Coordinates
   * are whatever space the caller uses consistently; the zone geometry is
   * normalised (0–1), so the frame processor passes normalised centroids.
   */
  observe(
    trackId: string,
    wireId: string,
    wire: LineSegment,
    centroid: Point,
  ): readonly TripwireCross[] {
    const wires = this.tracks.get(trackId) ?? new Map<string, WireState>()
    this.tracks.set(trackId, wires)

    const side = sideOf(centroid, wire)
    const state = wires.get(wireId)
    if (state === undefined) {
      // First sighting: a single point is a position, not a movement.
      wires.set(wireId, {
        last: centroid,
        confirmedSide: side,
        pendingSide: side,
        pendingFrames: 0,
        sawIntersection: false,
        pendingDirection: 'in',
      })
      return NONE
    }

    const crossedNow = tripwireCrossing(state.last, centroid, wire) !== null
    state.last = centroid

    // ON the line: neither confirms nor cancels. A subject standing exactly on
    // the boundary should not resolve the question either way.
    if (side === 0) return NONE

    if (side === state.confirmedSide) {
      // Back where it started — whatever was pending was a wobble.
      state.pendingSide = side
      state.pendingFrames = 0
      state.sawIntersection = false
      return NONE
    }

    if (side !== state.pendingSide) {
      state.pendingSide = side
      state.pendingFrames = 1
      state.sawIntersection = crossedNow
      // Right-hand side of p1 → p2 is 'in'; the reverse is 'out'.
      state.pendingDirection = side > 0 ? 'in' : 'out'
    } else {
      state.pendingFrames += 1
      // The intersection may have happened on any frame of the window — a fast
      // subject crosses in one step, a slow one drifts over several.
      state.sawIntersection = state.sawIntersection || crossedNow
    }

    if (state.pendingFrames < this.config.confirmFrames) return NONE
    if (!state.sawIntersection) {
      // The side changed without the SEGMENT being crossed: the subject walked
      // around the end of the wire. Accept the new side so this does not
      // re-evaluate forever, but report nothing.
      state.confirmedSide = side
      state.pendingFrames = 0
      return NONE
    }

    state.confirmedSide = side
    state.pendingFrames = 0
    state.sawIntersection = false
    return [{ wireId, direction: state.pendingDirection }]
  }

  /** Drop a track. Called when the subject leaves, so state cannot accumulate. */
  forget(trackId: string): void {
    this.tracks.delete(trackId)
  }

  /** D683: zone membership continues under the survivor id. */
  rename(from: string, to: string): void {
    renameKey(this.tracks, from, to)
  }

  /** Number of tracks held — a leak check for the caller's tests. */
  size(): number {
    return this.tracks.size
  }
}
