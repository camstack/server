/**
 * The tracks a `scene-boxes` picture draws come from ONE instant — the frame's.
 *
 * Reconstructed from the 2026-10-22 "Animale su Aiuola o Uscio" push on camera
 * 101 (event 634451): the picture is the dog's key frame at 262103; the
 * tracker split the dog and a second piece (`xxrvnxav8q`, fused into the
 * subject only 10 s AFTER the delivery) was BORN at 262779. The old read let
 * the tolerance stretch the piece's life backwards, so it was drawn at its
 * first box — 676 ms later, 350 px to the left — as a second box on the dog.
 */
import { describe, expect, it } from 'vitest'
import {
  NC_TRACK_LIFE_SLACK_MS,
  NC_BOX_EXACT_MS,
  type NcTrackAtInstantSource,
  tracksAtInstant,
} from '../tracks-at-instant.js'

const T = 1_792_683_262_103
const DIMS = { w: 3840, h: 2160 }

interface Sighting {
  readonly at: number
  readonly x: number
  readonly y: number
}

function track(
  trackId: string,
  className: string,
  positions: readonly Sighting[],
): NcTrackAtInstantSource {
  const ts = positions.map((p) => p.at)
  return {
    trackId,
    className,
    firstSeen: Math.min(...ts),
    lastSeen: Math.max(...ts),
    frameWidth: DIMS.w,
    frameHeight: DIMS.h,
    positions: positions.map((p) => ({
      timestamp: p.at,
      bbox: { x: p.x, y: p.y, w: 380, h: 200 },
    })),
  }
}

describe('tracksAtInstant — one instant, never a box from a track that was not there', () => {
  it('leaves out a piece BORN after the frame, even within the box tolerance (prod 101)', () => {
    const dogPiece = track('xxrvnxav8q', 'animal', [
      { at: T + 676, x: 1199, y: 849 },
      { at: T + 898, x: 1080, y: 838 },
    ])
    const person = track('6ex1gj13k6', 'person', [
      { at: T - 138, x: 1729, y: 1 },
      { at: T, x: 1723, y: 2 },
      { at: T + 310, x: 1664, y: 2 },
    ])
    const out = tracksAtInstant([dogPiece, person], T, 750, undefined)
    expect(out.map((t) => t.trackId)).toEqual(['6ex1gj13k6'])
  })

  it('leaves out a track that ENDED before the frame', () => {
    const gone = track('gone', 'person', [
      { at: T - 2000, x: 100, y: 100 },
      { at: T - 600, x: 120, y: 100 },
    ])
    expect(tracksAtInstant([gone], T, 750, undefined)).toEqual([])
  })

  it('keeps a track within one detection tick of its birth or its end', () => {
    const justBorn = track('born', 'person', [{ at: T + NC_TRACK_LIFE_SLACK_MS, x: 10, y: 10 }])
    const justEnded = track('ended', 'person', [{ at: T - NC_TRACK_LIFE_SLACK_MS, x: 900, y: 10 }])
    const out = tracksAtInstant([justBorn, justEnded], T, 750, undefined)
    expect(out.map((t) => t.trackId).sort()).toEqual(['born', 'ended'])
  })

  it('does not draw a fragment alive at the instant whose nearest position is +676 ms and displaced (qp0a1xv2t5)', () => {
    // Alive across T (first position 1.5 s before, last 676 ms after) but no
    // position within a tick and no bracketing pair inside the window: the
    // old nearest-position read drew the +676 ms box, 350 px off the dog.
    const fragment = track('xxrvnxav8q', 'animal', [
      { at: T - 1500, x: 1900, y: 849 },
      { at: T + 676, x: 1199, y: 849 },
    ])
    const reasons: string[] = []
    const out = tracksAtInstant([fragment], T, 750, undefined, (d) => reasons.push(d.reason))
    expect(out).toEqual([])
    expect(reasons).toEqual(['no-position-near-instant'])
  })

  it('names the drop of a track with a later position only (no bracket in the window)', () => {
    const fragment = track('lone', 'animal', [
      { at: T - 100 - 900, x: 100, y: 100 },
      { at: T + 676, x: 1199, y: 849 },
    ])
    const reasons: string[] = []
    const out = tracksAtInstant([fragment], T, 750, undefined, (d) => reasons.push(d.reason))
    expect(out).toEqual([])
    expect(reasons).toEqual(['no-position-near-instant'])
  })

  it('interpolates between the two positions that bracket the instant', () => {
    const sparse = track('sparse', 'person', [
      { at: T - 500, x: 1000, y: 500 },
      { at: T + 500, x: 2000, y: 700 },
    ])
    const [one] = tracksAtInstant([sparse], T, 750, undefined)
    expect(one?.interpolated).toBe(true)
    expect(one?.bbox.x).toBeCloseTo(1500 / DIMS.w, 5)
    expect(one?.bbox.y).toBeCloseTo(600 / DIMS.h, 5)
  })

  it('uses a position within one tick as it is', () => {
    const t = track('exact', 'person', [
      { at: T + NC_BOX_EXACT_MS, x: 10, y: 20 },
      { at: T - 900, x: 0, y: 0 },
    ])
    const [one] = tracksAtInstant([t], T, 750, undefined)
    expect(one?.interpolated).toBe(false)
    expect(one?.dtMs).toBe(NC_BOX_EXACT_MS)
    expect(one?.bbox.x).toBeCloseTo(10 / DIMS.w, 6)
  })

  it('does not draw a track whose life starts after the instant', () => {
    const later = track('later', 'animal', [
      { at: T + 676, x: 1, y: 1 },
      { at: T + 900, x: 2, y: 2 },
    ])
    const reasons: string[] = []
    expect(tracksAtInstant([later], T, 750, undefined, (d) => reasons.push(d.reason))).toEqual([])
    expect(reasons).toEqual(['outside-life'])
  })
})
