/**
 * A deterministic synthetic scene (D681) for unit tests — built in memory,
 * never committed as a case (plan decision 19): two people walking across
 * each other, one of them lost for 1.5 s, and a car that arrives and parks —
 * strong-held by a scripted gate from its 20th still second, as the registry
 * would. The `live[]` bindings are produced the way the hub produces them: a
 * real `FrameProcessor`, observed. The ground truth is exact by construction
 * (each detection's subject is known), expressed as the marks an operator
 * would make.
 *
 * (Task 19 fix round 1, H2.) "Known" means known from `frame.detections` —
 * the ORIGINAL per-frame array, before `buildFrameRecord` renumbers every id
 * to a per-frame ordinal (`d0, d1, d2…`, `FrameIdMap` in
 * `recorder/frame-record.ts`). An ordinal is a POSITION, not an identity: it
 * is reused across subjects the moment one drops out of a frame (P2's
 * occlusion shifts the car from `d2` to `d1`), so resolving a subject from
 * `l.det` (the ordinal, read off the built `TapeFrame`) marks a subject that
 * never left the scene `mixed` at the shift. The subject map below is built
 * from `frame.detections`, index-for-index with `record.dets`, before that
 * information is gone.
 */
import type { FrameResult, ObjectDetection } from '@camstack/types'
import { DETECTION_SENSITIVITY_DEFAULTS } from '../detection-sensitivity-settings.js'
import type {
  StationaryFrameGate,
  StationaryGateInput,
  StationaryGateOutcome,
} from '../pipeline/frame-processor.js'
import { createFrameProcessor } from '../pipeline/frame-processor-config.js'
import { sequentialTrackIdMinter } from '../pipeline/track-id.js'
import { TRACKING_DEFAULTS } from '../tracking-settings.js'
import type { GroundTruthFile } from './ground-truth.js'
import { buildFrameRecord } from './recorder/frame-record.js'
import type { Tape } from './tape-codec.js'
import {
  TAPE_FORMAT,
  TAPE_RECORDER_ID,
  TAPE_VERSION,
  type TapeFrame,
  type TapeHeader,
  type TapeScene,
} from './tape-schema.js'
import { toRules, toZones } from './trackers/tape-frame-result.js'

export interface SyntheticScenario {
  readonly tape: Tape
  readonly gt: GroundTruthFile
}

const FRAME_MS = 143
const FRAMES = 315 // 45 s
const PARK_AT_FRAME = 70 // the car stops at ~10 s
const HOLD_FROM_FRAME = PARK_AT_FRAME + 140 // strong-held after 20 still seconds
const OCCLUDED = { from: 150, to: 160 } // P2 missing ~1.5 s

function det(
  id: string,
  cls: string,
  score: number,
  x: number,
  y: number,
  w: number,
  h: number,
): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: cls,
    score,
    labels: [],
    bbox: { x, y, width: w, height: h },
  }
}

function subjectsAt(i: number): readonly ObjectDetection[] {
  const p = i / (FRAMES - 1)
  const out: ObjectDetection[] = [
    det(`P1-${String(i)}`, 'person', 0.85, 80 + p * 1020, 300, 60, 160),
  ]
  if (i < OCCLUDED.from || i > OCCLUDED.to) {
    out.push(det(`P2-${String(i)}`, 'person', 0.8, 1100 - p * 1020, 330, 60, 160))
  }
  const carX = i < PARK_AT_FRAME ? 1180 - (i / PARK_AT_FRAME) * 480 : 700
  out.push(det(`C-${String(i)}`, 'vehicle', 0.9, carX, 450, 200, 110))
  return out
}

function subjectOf(detectionId: string): string {
  return detectionId.split('-')[0] ?? detectionId
}

/**
 * The scene's OWN stationary gate — never `RecordedStationaryGate` (the code
 * this scenario exists to exercise): strong-holds the parked car by its own
 * clock and class check, independent of the tape join it feeds. Sharing the
 * class under test here would let a broken `RecordedStationaryGate.load`
 * corrupt the fixture's ground truth in the SAME way it corrupts a replay,
 * which would make `replayTape` reproduce a bug rather than expose it.
 */
class ScriptedParkedCarGate implements StationaryFrameGate {
  filter(input: StationaryGateInput): StationaryGateOutcome {
    const suppressed = new Set<number>()
    // Driven by the frame's OWN observed time (L1, fix round 1) — the gate
    // already receives it, so no outside caller needs to mutate a field on
    // it in lockstep with the loop that builds the frame.
    if (input.timestamp >= HOLD_FROM_FRAME * FRAME_MS) {
      input.detections.forEach((d, i) => {
        if (d.class === 'vehicle') suppressed.add(i)
      })
    }
    return {
      suppressedIndices: suppressed,
      continuableIndices: new Set(),
      confirmed: [],
      woken: [],
    }
  }
}

export function buildSyntheticScenario(): SyntheticScenario {
  const inputs = {
    sensitivity: { ...DETECTION_SENSITIVITY_DEFAULTS },
    tracking: { ...TRACKING_DEFAULTS },
  }
  const scene: TapeScene = {
    zones: [],
    rules: [],
    zoneMembershipMinOverlap: 0,
    lowScoreFloor: TRACKING_DEFAULTS.lowScoreContinuationFloor,
  }
  const header: TapeHeader = {
    kind: 'header',
    format: TAPE_FORMAT,
    version: TAPE_VERSION,
    tapeId: 'synthetic-crossing',
    deviceId: 1,
    lighting: 'day',
    recorder: TAPE_RECORDER_ID,
    planes: { pipeline: inputs },
    scene,
    stationaryEntries: [],
  }
  const gate = new ScriptedParkedCarGate()
  const processor = createFrameProcessor(1, 'pipeline', inputs, {
    mintTrackId: sequentialTrackIdMinter('live'),
  })
  processor.setStationaryGate(gate)
  processor.setZones(toZones(scene))
  processor.setDetectionRules(toRules(scene))
  processor.setZoneMembershipMinOverlap(0)
  processor.setLowScoreContinuationFloor(scene.lowScoreFloor)
  const body: TapeFrame[] = []
  // Per frame, ordinal → subject — resolved from `frame.detections` the
  // SAME frame it describes, before `buildFrameRecord` erases that order
  // into ordinals (H2, fix round 1). Parallel to `body`, index for index.
  const subjectByOrdinal: ReadonlyMap<string, string>[] = []
  for (let i = 0; i < FRAMES; i += 1) {
    const t = i * FRAME_MS
    const frame: FrameResult = {
      kind: 'frame',
      frameId: `syn-${String(i)}`,
      deviceId: 1,
      timestamp: t,
      width: 1280,
      height: 720,
      detections: subjectsAt(i),
    }
    const result = processor.process({ timestamp: t, frame, observe: true })
    if (result.observation === undefined)
      throw new Error('synthetic: processor returned no observation')
    const record = buildFrameRecord({
      t,
      plane: 'pipeline',
      frame,
      injectedIds: new Set(),
      observation: result.observation,
      faces: { pseudonym: (label) => label },
    })
    body.push(record)
    // `record.dets` and `frame.detections` are the SAME frame's detections,
    // in the SAME order (`buildFrameRecord` maps one to the other 1:1) — so
    // pairing by index, not by id, recovers the subject an ordinal alone
    // cannot say.
    subjectByOrdinal.push(
      new Map(record.dets.map((d, k) => [d.id, subjectOf(frame.detections[k]?.id ?? d.id)])),
    )
  }
  const tape: Tape = {
    header,
    body,
    end: {
      kind: 'end',
      durationMs: (FRAMES - 1) * FRAME_MS,
      frames: FRAMES,
      skips: 0,
      gaps: 0,
      reason: 'window-end',
    },
  }
  return { tape, gt: syntheticTruth(body, subjectByOrdinal) }
}

/** The marks an operator would make: chain each subject's tracks; a track that
 *  bound two subjects is `mixed` at the first change. `subjectByOrdinal[k]`
 *  resolves `frames[k]`'s own ordinals to subjects (H2, fix round 1) — never
 *  `subjectOf(l.det)` directly, which reads a per-frame POSITION as if it
 *  were an identity. */
function syntheticTruth(
  frames: readonly TapeFrame[],
  subjectByOrdinal: readonly ReadonlyMap<string, string>[],
): GroundTruthFile {
  const subjectsByTrack = new Map<string, { subject: string; t: number }[]>()
  frames.forEach((f, k) => {
    const subjects = subjectByOrdinal[k]
    for (const l of f.live) {
      if (l.det === undefined) continue
      const subject = subjects?.get(l.det) ?? l.det
      const list = subjectsByTrack.get(l.trk) ?? []
      list.push({ subject, t: f.t })
      subjectsByTrack.set(l.trk, list)
    }
  })
  const purities: GroundTruthFile['purities'] = []
  const tracksBySubject = new Map<string, string[]>()
  for (const [trk, seen] of subjectsByTrack) {
    const first = seen[0]
    if (first === undefined) continue
    const change = seen.find((s) => s.subject !== first.subject)
    if (change !== undefined) purities.push({ trk, purity: 'mixed', switchT: change.t })
    tracksBySubject.set(first.subject, [...(tracksBySubject.get(first.subject) ?? []), trk])
  }
  const relations: GroundTruthFile['relations'] = []
  for (const tracks of tracksBySubject.values()) {
    for (let k = 1; k < tracks.length; k += 1) {
      const a = tracks[k - 1]
      const b = tracks[k]
      if (a !== undefined && b !== undefined) relations.push({ a, b, relation: 'same-subject' })
    }
  }
  return { version: 1, reviewed: true, relations, purities, external: [] }
}
