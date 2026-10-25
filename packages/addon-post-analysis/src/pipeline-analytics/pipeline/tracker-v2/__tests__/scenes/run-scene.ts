/**
 * Replays a reconstructed scene through a fresh `TrackerV2` and says which
 * final ids each TRUE subject received (spec §10.A). Truth comes from the
 * analyses' manual reading of the stored positions, not from the old tracker.
 *
 * Faces and names travel the way the processor will hand them over (Task 11):
 * a box marked `face` is in the frame's `faceBearing` set, and a frame's
 * `names` are the recognizer's settled verdicts, delivered through
 * `noteIdentity` on the id that subject was emitted under on that frame.
 */
import type { AppearanceDescriptor, BoundingBox, SpatialDetection } from '@camstack/types'
import { sequentialTrackIdMinter } from '../../../track-id.js'
import { TrackerV2 } from '../../tracker-v2.js'
import {
  DEFAULT_TRACKER_V2_CONFIG,
  type LinkDecisionFacts,
  type TrackerV2Config,
  type TrackFusion,
} from '../../types.js'

export type SceneBox = readonly [number, number, number, number]

export interface SceneDetection {
  readonly truth: string
  readonly cls: string
  readonly score: number
  readonly box: SceneBox
  readonly appearance?: AppearanceDescriptor
  /** A face detail sits inside this box (spec §4.4: any size). */
  readonly face?: boolean
}

/** The recognizer settled `truth`'s current track as `identity`. */
export interface SceneVerdict {
  readonly truth: string
  readonly identity: string
}

export interface SceneFrame {
  readonly t: number
  readonly dets: readonly SceneDetection[]
  readonly low?: readonly SceneDetection[]
  readonly names?: readonly SceneVerdict[]
}

export interface SceneOptions {
  readonly config?: Partial<TrackerV2Config>
  readonly frameWidth?: number
  readonly frameHeight?: number
}

/** A frame on which a truth was emitted as a sighting, under its FINAL id. */
export interface SceneSighting {
  readonly t: number
  readonly finalId: string
}

export interface SceneOutcome {
  readonly finalIdsByTruth: ReadonlyMap<string, ReadonlySet<string>>
  readonly truthsByFinalId: ReadonlyMap<string, ReadonlySet<string>>
  /** Each truth's last emitted sighting: a piece that never confirmed is never emitted. */
  readonly lastSightingByTruth: ReadonlyMap<string, SceneSighting>
  readonly fusions: readonly TrackFusion[]
  readonly links: readonly LinkDecisionFacts[]
}

type Sighting = readonly [truth: string, trackId: string, t: number]

function toBox(b: SceneBox): BoundingBox {
  return { x: b[0], y: b[1], w: b[2], h: b[3] }
}

function toDetection(d: SceneDetection, bbox: BoundingBox): SpatialDetection {
  return {
    class: d.cls,
    originalClass: d.cls,
    score: d.score,
    bbox,
    ...(d.appearance !== undefined ? { appearance: d.appearance } : {}),
  }
}

/** One frame through the tracker: what each truth was emitted as on a sighting. */
function playFrame(tracker: TrackerV2, frame: SceneFrame, options: SceneOptions): Sighting[] {
  const truthByBox = new Map<BoundingBox, string>()
  const faces = new Set<BoundingBox>()
  const dets = frame.dets.map((d) => {
    const bbox = toBox(d.box)
    truthByBox.set(bbox, d.truth)
    if (d.face === true) faces.add(bbox)
    return toDetection(d, bbox)
  })
  const low = (frame.low ?? []).map((d) => toDetection(d, toBox(d.box)))
  const out = tracker.update(dets, frame.t, {
    frameWidth: options.frameWidth ?? 3840,
    frameHeight: options.frameHeight ?? 2160,
    lowScore: low,
    faceBearing: faces,
  })
  const seen: Sighting[] = []
  for (const e of out) {
    const truth = e.matchedThisFrame ? truthByBox.get(e.bbox) : undefined
    if (truth !== undefined) seen.push([truth, e.trackId, frame.t])
  }
  for (const v of frame.names ?? []) {
    const id = seen.find(([truth]) => truth === v.truth)?.[1]
    if (id !== undefined) tracker.noteIdentity(id, v.identity)
  }
  return seen
}

function tally(seen: readonly Sighting[], resolve: (id: string) => string): SceneOutcome {
  const finalIdsByTruth = new Map<string, Set<string>>()
  const truthsByFinalId = new Map<string, Set<string>>()
  const lastSightingByTruth = new Map<string, SceneSighting>()
  for (const [truth, id, t] of seen) {
    const f = resolve(id)
    finalIdsByTruth.set(truth, (finalIdsByTruth.get(truth) ?? new Set()).add(f))
    truthsByFinalId.set(f, (truthsByFinalId.get(f) ?? new Set()).add(truth))
    lastSightingByTruth.set(truth, { t, finalId: f })
  }
  return { finalIdsByTruth, truthsByFinalId, lastSightingByTruth, fusions: [], links: [] }
}

export function runScene(frames: readonly SceneFrame[], options: SceneOptions = {}): SceneOutcome {
  const links: LinkDecisionFacts[] = []
  const tracker = new TrackerV2(
    { ...DEFAULT_TRACKER_V2_CONFIG, ...options.config },
    { mintTrackId: sequentialTrackIdMinter(), observers: { link: (f) => links.push(f) } },
  )
  const final = new Map<string, string>()
  const fusions: TrackFusion[] = []
  const seen: Sighting[] = []
  const absorb = (fs: readonly TrackFusion[]): void => {
    for (const f of fs) {
      fusions.push(f)
      for (const [m, s] of final) if (s === f.absorbedId) final.set(m, f.survivorId)
      for (const m of f.members) final.set(m, f.survivorId)
    }
  }
  let lastT = 0
  for (const frame of frames) {
    seen.push(...playFrame(tracker, frame, options))
    absorb(tracker.drainFusions())
    lastT = frame.t
  }
  // The sweep on a silent camera: end what is left, and let L2 decide it.
  tracker.advance(lastT + 30_000)
  absorb(tracker.drainFusions())
  const outcome = tally(seen, (id) => final.get(id) ?? id)
  return { ...outcome, fusions, links }
}
