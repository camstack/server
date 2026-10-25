/**
 * Tripwire crossings — the events an operator could draw and never receive.
 *
 * `tripwireCrossing()` has existed, correct and direction-aware, with ZERO
 * callers: not one, not even a test. Everything around it was in place — the
 * zone kind, the line shape, the editor's "Add tripwire" button, the
 * `tripwire.cross` taxonomy entry, the emitter's mapping — so the feature
 * looked finished from the outside and could never fire. Same shape as the zone
 * crossings (D35), one layer deeper.
 *
 * Two properties have to hold, and they pull against each other:
 *   - a subject that walks over the line produces exactly ONE event, with the
 *     right direction;
 *   - a box that jitters ON the line produces NONE. A tripwire is drawn exactly
 *     where people linger — a doorway, a gate — so this is the common case, not
 *     the corner one, and every spurious event is a notification.
 */
import { describe, it, expect } from 'vitest'
import { TripwireTracker, DEFAULT_TRIPWIRE_CONFIRM_FRAMES } from '../tripwire-tracker.js'
import type { LineSegment } from '../../zones/geometry.js'

/** A horizontal wire across the middle of the frame, directed left→right. */
const WIRE: LineSegment = { p1: { x: 0, y: 0.5 }, p2: { x: 1, y: 0.5 } }

const ABOVE = { x: 0.5, y: 0.2 }
const BELOW = { x: 0.5, y: 0.8 }

function walk(
  tracker: TripwireTracker,
  points: ReadonlyArray<{ x: number; y: number }>,
  wireId = 'w1',
  trackId = 't1',
): string[] {
  const seen: string[] = []
  for (const p of points) {
    for (const c of tracker.observe(trackId, wireId, WIRE, p)) seen.push(c.direction)
  }
  return seen
}

describe('TripwireTracker', () => {
  it('emits nothing on the first sighting — one point is not a movement', () => {
    const t = new TripwireTracker()
    expect(walk(t, [ABOVE])).toEqual([])
  })

  it('emits ONE crossing when a subject walks over the wire', () => {
    const t = new TripwireTracker()
    // above → below, then hold below long enough to confirm.
    const seen = walk(t, [ABOVE, BELOW, BELOW, BELOW, BELOW])
    expect(seen).toHaveLength(1)
  })

  it('reports OPPOSITE directions for the two ways over the same wire', () => {
    const down = walk(new TripwireTracker(), [ABOVE, BELOW, BELOW, BELOW, BELOW])
    const up = walk(new TripwireTracker(), [BELOW, ABOVE, ABOVE, ABOVE, ABOVE])
    expect(down).toHaveLength(1)
    expect(up).toHaveLength(1)
    expect(down[0]).not.toBe(up[0])
  })

  it('does NOT emit while the crossing is still unconfirmed', () => {
    const t = new TripwireTracker({ confirmFrames: 3 })
    // Crossed, but has not held the far side long enough yet.
    expect(walk(t, [ABOVE, BELOW, BELOW])).toEqual([])
  })

  it('emits NOTHING for a box jittering on the line — the case a doorway produces', () => {
    const t = new TripwireTracker()
    const jitter = [ABOVE, BELOW, ABOVE, BELOW, ABOVE, BELOW, ABOVE, BELOW, ABOVE]
    expect(walk(t, jitter)).toEqual([])
  })

  it('emits once — not once per frame — while the subject stays across', () => {
    const t = new TripwireTracker()
    const seen = walk(t, [ABOVE, BELOW, BELOW, BELOW, BELOW, BELOW, BELOW, BELOW, BELOW])
    expect(seen).toHaveLength(1)
  })

  it('emits again when the subject comes BACK over the wire', () => {
    const t = new TripwireTracker()
    const seen = walk(t, [
      ABOVE,
      BELOW,
      BELOW,
      BELOW,
      BELOW, // over
      ABOVE,
      ABOVE,
      ABOVE,
      ABOVE, // and back
    ])
    expect(seen).toHaveLength(2)
    expect(seen[0]).not.toBe(seen[1])
  })

  it('ignores a subject that walks AROUND the end of the wire', () => {
    const t = new TripwireTracker()
    // The wire spans x∈[0,1] at y=0.5 — but a SHORT wire does not.
    const short: LineSegment = { p1: { x: 0.0, y: 0.5 }, p2: { x: 0.2, y: 0.5 } }
    const seen: string[] = []
    // Crosses the infinite line at x=0.8, far past the segment's end.
    for (const p of [
      { x: 0.8, y: 0.2 },
      { x: 0.8, y: 0.8 },
      { x: 0.8, y: 0.8 },
      { x: 0.8, y: 0.8 },
      { x: 0.8, y: 0.8 },
    ]) {
      for (const c of t.observe('t1', 'short', short, p)) seen.push(c.direction)
    }
    // Side changed, segment never crossed: not a crossing.
    expect(seen).toEqual([])
  })

  it('keeps tracks and wires independent', () => {
    const t = new TripwireTracker()
    const a = walk(t, [ABOVE, BELOW, BELOW, BELOW, BELOW], 'w1', 'trackA')
    const b = walk(t, [ABOVE], 'w1', 'trackB')
    expect(a).toHaveLength(1)
    expect(b).toEqual([])
  })

  it('forgets a track, so a finished subject cannot leak or re-fire', () => {
    const t = new TripwireTracker()
    walk(t, [ABOVE, BELOW, BELOW, BELOW, BELOW])
    expect(t.size()).toBeGreaterThan(0)
    t.forget('t1')
    expect(t.size()).toBe(0)
    // A fresh sighting after forgetting starts over: no event from one point.
    expect(walk(t, [BELOW])).toEqual([])
  })

  it('defaults to a confirmation window rather than firing instantly', () => {
    expect(DEFAULT_TRIPWIRE_CONFIRM_FRAMES).toBeGreaterThan(1)
  })
})
