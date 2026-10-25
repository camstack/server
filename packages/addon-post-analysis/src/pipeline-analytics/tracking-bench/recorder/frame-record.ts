/**
 * `FrameResult` → tape record, FIELD BY FIELD (spec §3.2, §3.5). Nothing here
 * spreads an input object: a field this file does not name cannot reach a
 * tape, which is the whole point for a tape committed to a public repo. The
 * two fate tables below make that a compile-time fact: a field added to
 * `ObjectDetection` or `FrameResult` stops this file compiling until someone
 * decides whether it is recorded.
 */
import { createHmac } from 'node:crypto'
import type { DiscardedDetection, FrameResult, ObjectDetection } from '@camstack/types'
import type {
  FrameGateObservation,
  FrameLiveBinding,
  FrameObservation,
} from '../../pipeline/frame-observation.js'
import { isInternalMarker } from '../../pipeline/label-utils.js'
import type {
  TapeBox,
  TapeDetection,
  TapeDiscard,
  TapeFrame,
  TapeGate,
  TapeIdentity,
  TapeLive,
  TapePlane,
  TapeSkip,
} from '../tape-schema.js'

/** Discarded boxes below this score are not worth a tape line (spec §3.2). */
const MIN_DISCARD_SCORE = 0.3

/** What happens to one source field: recorded (as which tape key), or stripped
 *  (and why). Read by no code — it exists to be exhaustive. */
type FieldFate = { readonly recorded: string } | { readonly stripped: string }

/** Every `ObjectDetection` field, decided. A new field fails to compile here. */
export const DETECTION_FIELD_FATE: Readonly<Record<keyof ObjectDetection, FieldFate>> = {
  id: { recorded: 'id, as a per-frame ordinal — a producer id can carry the wall clock' },
  kind: { recorded: 'k' },
  macroClass: { recorded: 'cls' },
  score: { recorded: 's' },
  labels: { recorded: 'fid/fs — a pseudonym of a declared instance-tier face label only' },
  track: { stripped: "the producer's track binding; the live tracker's answer is live[]" },
  debug: { recorded: 'ocls/ot only; timings and notes stripped' },
  nativeRecovery: { recorded: 'nr, and src = recovery' },
  birthEvidence: { stripped: 'pixels' },
  appearance: { recorded: 'app — the model-free descriptor, tape schema v2 (D683 §8.3)' },
  bbox: { recorded: 'b, numbers verbatim' },
  refinedBbox: { stripped: 'a mask-derived box the tracker does not read' },
  mask: { stripped: 'pixels' },
  maskWidth: { stripped: 'belongs to the mask' },
  maskHeight: { stripped: 'belongs to the mask' },
  parentId: { recorded: 'pid, through the same ordinal map' },
  rootSupplied: {
    stripped: 'which step a root child box stands in for — the tracker never reads a detail',
  },
  embedding: { stripped: 'a biometric vector' },
  embeddingModelId: { stripped: 'belongs to the vector' },
  embeddingMagnitude: { stripped: 'belongs to the vector' },
  faceAlignedCrop: { stripped: 'pixels' },
  nativeFaceShortSidePx: { stripped: 'a recognition-size input, not a tracker input' },
  landmarks: { stripped: 'facial geometry, biometric' },
}

/** Every `FrameResult` field, decided. A new field fails to compile here. */
export const FRAME_FIELD_FATE: Readonly<Record<keyof FrameResult, FieldFate>> = {
  kind: { recorded: "kind ('frame' | 'skip')" },
  frameId: { stripped: 'a producer id' },
  deviceId: { stripped: 'the header carries it once' },
  timestamp: { stripped: 'absolute time — t is relative to the file origin' },
  width: { recorded: 'w' },
  height: { recorded: 'h' },
  detections: { recorded: 'dets' },
  discarded: { recorded: 'disc, score ≥ MIN_DISCARD_SCORE, corners → [x, y, w, h]' },
  shed: { recorded: 'shed' },
  shedReason: { stripped: 'a free-text note' },
  rootModelId: { recorded: 'rootModelId' },
  rootStepId: { stripped: 'the confirmation gate re-detect identity, not a tracker input' },
  rootDeviceKey: { stripped: 'where the root ran — the tracker reads boxes, not placement' },
  packageLooked: { recorded: 'pl' },
  debug: { stripped: 'timings and engine notes' },
}

export interface FacePseudonymizer {
  readonly pseudonym: (label: string) => string
}

/** `h:<12 hex>` — HMAC of an identity (a recognizer identity id, or a declared
 *  instance-tier face label) under a key held in RAM for the addon's life
 *  (§3.6). The key never leaves the process. */
export function hubFacePseudonymizer(key: Buffer): FacePseudonymizer {
  return {
    pseudonym: (label) => `h:${createHmac('sha256', key).update(label).digest('hex').slice(0, 12)}`,
  }
}

/** Hub pseudonyms → `p1`, `p2` … by first appearance, once per promoted tape. */
export class TapeFaceRemap {
  private readonly byHub = new Map<string, string>()

  remap(fid: string): string {
    const known = this.byHub.get(fid)
    if (known !== undefined) return known
    const next = `p${String(this.byHub.size + 1)}`
    this.byHub.set(fid, next)
    return next
  }
}

/**
 * Producer detection id → `d<n>`, for ONE frame. The frame's detections are
 * numbered first, in order; a reference to anything else (a gate or live id not
 * among them) takes the next number rather than travelling verbatim. A producer
 * id never reaches a tape: the onboard plane mints `onboard-<Date.now()>-<i>`.
 * Per frame is enough — the tracker reports the id of THIS frame's box.
 */
class FrameIdMap {
  private readonly byProducer = new Map<string, string>()

  constructor(detections: readonly ObjectDetection[]) {
    for (const d of detections) this.ordinal(d.id)
  }

  ordinal(id: string): string {
    const known = this.byProducer.get(id)
    if (known !== undefined) return known
    const next = `d${String(this.byProducer.size)}`
    this.byProducer.set(id, next)
    return next
  }
}

export function tapeBox(x: number, y: number, w: number, h: number): TapeBox {
  return [x, y, w, h]
}

/** The inverse of the discard conversion: a tape box → the executor's corner
 *  tuple `[x1, y1, x2, y2]`, exactly (the replay's side of §3.2). */
export function tapeDiscardCorners(b: TapeBox): DiscardedDetection['bbox'] {
  return [b[0], b[1], b[0] + b[2], b[1] + b[3]]
}

/** `[score, cropSidePx, viewPx]` — the schema's own tuple type. */
type NativeRecoveryTuple = NonNullable<TapeDetection['nr']>

function nativeRecovery(score: number, side: number, view: number): NativeRecoveryTuple {
  return [score, side, view]
}

/**
 * The identity a face detail DECLARES, if any: a label its step declared
 * instance-tier (2). The runner's arcface marker (`embedding:512d`, no tier) is
 * not one, and today no runner step declares one — identity is decided per
 * track by the post-analysis recognizer and reaches a tape as an `identity`
 * record instead.
 */
function declaredFaceIdentity(d: ObjectDetection): ObjectDetection['labels'][number] | undefined {
  if (d.kind !== 'detail' || d.macroClass !== 'face') return undefined
  return d.labels.find((l) => l.tier === 2 && l.label.length > 0 && !isInternalMarker(l.label))
}

function tapeDetection(
  d: ObjectDetection,
  plane: TapePlane,
  faces: FacePseudonymizer,
  ids: FrameIdMap,
): TapeDetection {
  const face = declaredFaceIdentity(d)
  const src: TapeDetection['src'] =
    plane === 'onboard' ? 'onboard' : d.nativeRecovery !== undefined ? 'recovery' : 'frame'
  return {
    id: ids.ordinal(d.id),
    k: d.kind,
    cls: d.macroClass,
    ...(d.debug?.originalClass !== undefined ? { ocls: d.debug.originalClass } : {}),
    ...(d.debug?.originalClassTier !== undefined ? { ot: d.debug.originalClassTier } : {}),
    s: d.score,
    b: tapeBox(d.bbox.x, d.bbox.y, d.bbox.width, d.bbox.height),
    src,
    ...(d.nativeRecovery !== undefined
      ? {
          nr: nativeRecovery(
            d.nativeRecovery.score,
            d.nativeRecovery.cropSidePx,
            d.nativeRecovery.viewPx,
          ),
        }
      : {}),
    ...(d.parentId !== undefined ? { pid: ids.ordinal(d.parentId) } : {}),
    ...(face !== undefined ? { fid: faces.pseudonym(face.label), fs: face.score } : {}),
    ...(d.appearance !== undefined
      ? { app: { v: d.appearance.version, b: [...d.appearance.bins], g: d.appearance.gray } }
      : {}),
  }
}

/**
 * `DiscardedDetection.bbox` is the executor's CORNER tuple `[x1, y1, x2, y2]`
 * (`types/detection.ts`); every tape box is `[x, y, w, h]`. Converted here,
 * once, so an ignore region is the same geometry as the detections around it.
 * A degenerate or inverted tuple is recorded VERBATIM (zero or negative size):
 * the live tracker reads these boxes and refuses such a one itself
 * (`selectLowScoreContinuations`), so the replay must be given the same box to
 * refuse — normalising would hand it a box production never accepted.
 */
function tapeDiscards(discarded: readonly DiscardedDetection[] | undefined): TapeDiscard[] {
  return (discarded ?? [])
    .filter((d) => d.score >= MIN_DISCARD_SCORE)
    .map((d) => ({
      b: tapeBox(d.bbox[0], d.bbox[1], d.bbox[2] - d.bbox[0], d.bbox[3] - d.bbox[1]),
      cls: d.macroClass,
      s: d.score,
      r: d.reason,
    }))
}

function tapeGate(g: FrameGateObservation, ids: FrameIdMap): TapeGate | null {
  if (g.strong.length + g.weak.length + g.confirmed.length + g.woken.length === 0) return null
  return {
    strong: g.strong.map((s) =>
      s.entryId === undefined
        ? { det: ids.ordinal(s.detectionId) }
        : { det: ids.ordinal(s.detectionId), entry: s.entryId },
    ),
    weak: g.weak.map((w) => ids.ordinal(w)),
    confirmed: [...g.confirmed],
    woken: [...g.woken],
  }
}

function tapeLive(l: FrameLiveBinding, ids: FrameIdMap): TapeLive {
  return {
    trk: l.trackId,
    ...(l.detectionId !== undefined ? { det: ids.ordinal(l.detectionId) } : {}),
    m: l.matched,
    st: l.state,
    ...(l.heldByLowScore === true ? { lsh: true as const } : {}),
  }
}

export interface FrameRecordInput {
  readonly t: number
  readonly plane: TapePlane
  readonly frame: FrameResult
  readonly injectedIds: ReadonlySet<string>
  readonly observation: FrameObservation
  readonly faces: FacePseudonymizer
}

export function buildFrameRecord(input: FrameRecordInput): TapeFrame {
  const ids = new FrameIdMap(input.frame.detections)
  const dets = input.frame.detections.map((d) => tapeDetection(d, input.plane, input.faces, ids))
  const inj = input.frame.detections
    .filter((d) => input.injectedIds.has(d.id))
    .map((d) => ids.ordinal(d.id))
  const gate = tapeGate(input.observation.gate, ids)
  return {
    kind: 'frame',
    t: input.t,
    plane: input.plane,
    w: input.frame.width,
    h: input.frame.height,
    ...(input.frame.rootModelId !== undefined ? { rootModelId: input.frame.rootModelId } : {}),
    ...(input.frame.shed === true ? { shed: true as const } : {}),
    ...(input.frame.packageLooked === true ? { pl: true as const } : {}),
    dets,
    disc: tapeDiscards(input.frame.discarded),
    inj,
    ...(gate !== null ? { gate } : {}),
    live: input.observation.live.map((l) => tapeLive(l, ids)),
  }
}

export interface SkipRecordInput {
  readonly t: number
  readonly plane: TapePlane
  readonly frame: FrameResult
  readonly faces: FacePseudonymizer
}

export function buildSkipRecord(input: SkipRecordInput): TapeSkip {
  const ids = new FrameIdMap(input.frame.detections)
  return {
    kind: 'skip',
    t: input.t,
    plane: input.plane,
    w: input.frame.width,
    h: input.frame.height,
    dets: input.frame.detections.map((d) => tapeDetection(d, input.plane, input.faces, ids)),
    disc: tapeDiscards(input.frame.discarded),
    reason: 'dropout',
  }
}

export interface IdentityRecordInput {
  readonly t: number
  /** The live track id — the same string `live[].trk` carries. */
  readonly trackId: string
  /** The recognizer's identity id; `null` when it took the identity back. */
  readonly identityId: string | null
  readonly faces: FacePseudonymizer
}

/** A recognizer verdict → `identity` record. The identity id is pseudonymised
 *  here and never written; the name is never seen at all. */
export function buildIdentityRecord(input: IdentityRecordInput): TapeIdentity {
  return {
    kind: 'identity',
    t: input.t,
    trk: input.trackId,
    fid: input.identityId === null ? null : input.faces.pseudonym(input.identityId),
  }
}
