/**
 * Live tracks of a promoted tape, as lanes (admin review view) and as facts
 * the marks body accepts for a track the store no longer holds (spec §4.4).
 * Extent = frames where the track BOUND a detection; coasting emissions draw
 * the lane but are not observations.
 */
import type { TrackFacts } from '../pipeline/track-relations.js'
import type { Tape } from './tape-codec.js'
import type { TapePlane } from './tape-schema.js'

export interface TapeLane {
  readonly trackId: string
  readonly plane: TapePlane
  readonly firstT: number
  readonly lastT: number
  readonly boundFrames: number
  readonly cls: string
}

interface LaneAcc {
  plane: TapePlane
  firstT: number
  lastT: number
  bound: number
  readonly classes: Map<string, number>
}

export function tapeLanes(tape: Tape): readonly TapeLane[] {
  const lanes = new Map<string, LaneAcc>()
  for (const r of tape.body) {
    if (r.kind !== 'frame') continue
    const clsById = new Map(r.dets.map((d) => [d.id, d.cls]))
    for (const l of r.live) {
      const acc = lanes.get(l.trk) ?? {
        plane: r.plane,
        firstT: r.t,
        lastT: r.t,
        bound: 0,
        classes: new Map<string, number>(),
      }
      acc.lastT = r.t
      const cls = l.det === undefined ? undefined : clsById.get(l.det)
      if (cls !== undefined) {
        acc.bound += 1
        acc.classes.set(cls, (acc.classes.get(cls) ?? 0) + 1)
      }
      lanes.set(l.trk, acc)
    }
  }
  return [...lanes].map(([trackId, acc]) => {
    const top = [...acc.classes].toSorted((a, b) => b[1] - a[1])[0]
    return {
      trackId,
      plane: acc.plane,
      firstT: acc.firstT,
      lastT: acc.lastT,
      boundFrames: acc.bound,
      cls: top?.[0] ?? 'unknown',
    }
  })
}

export function tapeTrackFacts(
  tape: Tape,
  fromMs: number,
  deviceId: number,
  trackId: string,
): TrackFacts | null {
  const lane = tapeLanes(tape).find((l) => l.trackId === trackId)
  return lane === undefined
    ? null
    : { trackId, deviceId, firstSeen: fromMs + lane.firstT, lastSeen: fromMs + lane.lastT }
}
