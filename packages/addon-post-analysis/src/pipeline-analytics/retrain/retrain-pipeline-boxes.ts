/**
 * The boxes the PIPELINE drew on a copied frame — Step 1 of the training
 * screen.
 *
 * A correction has to start from the decision being corrected. Proposing with
 * a fresh model run answers a different question ("what would a model say
 * now"), and the frame the operator is fixing is precisely the one where the
 * live answer was wrong — a re-run that happens to be right hides the phantom
 * the operator came to remove. So the canvas opens with what the track store
 * says the pipeline had on that frame, and the operator accepts, corrects,
 * relabels or deletes it.
 *
 * ## Where a box comes from, best first
 *
 * 1. **The subject box recorded ON the source media row** (D510). Exact by
 *    construction: the box was measured on the frame the blob shows. Only the
 *    copy's own track can have one.
 * 2. **The track position nearest the capture time**, within
 *    {@link PIPELINE_BOX_TOLERANCE_MS}. Positions are frame-rate, so the
 *    nearest one is normally the same detection; the delta is reported so a
 *    reviewer can see how far it was.
 *
 * 0. **The subject a notification verdict froze** (a recording still landed by
 *    a verdict whose track was already gone). It is the one subject the
 *    operator answered about, so it comes FIRST and is the own box; the
 *    neighbours below stay secondary. Its box is normalised against the full
 *    frame already, so it is used as is — never re-scaled.
 *
 * Every OTHER track alive on the camera at that instant contributes its own
 * nearest position the same way — a frame with three people is three boxes,
 * and a recording still (no track of its own) gets everything the pipeline
 * was tracking at that moment, which is exactly what a missed-object review
 * needs to see is NOT there.
 *
 * Nothing here does I/O. The caller reads the tracks and the subject box.
 */

import {
  COCO_TO_MACRO,
  type RetrainMacroClass,
  type RetrainPipelineBox,
  type RetrainVerdict,
  type RetrainVerdictSubject,
  type Track,
} from '@camstack/types'
import { isRetrainMacroClass } from './retrain-taxonomy.js'

/** How far from the capture time a position may be and still be "this frame".
 *  Positions are recorded at the analysis rate (several per second), so half
 *  a second is a generous match and still not a different moment. */
export const PIPELINE_BOX_TOLERANCE_MS = 500

/**
 * How far back a track may have STARTED and still be alive at the frame. The
 * track store windows on `firstSeen`, so a track born before this is not
 * asked about — a vehicle parked for hours is the case it misses, and the
 * operator draws that box by hand.
 */
export const PIPELINE_TRACK_LOOKBACK_MS = 30 * 60_000

/** At most this many tracks of one camera are read around one frame. */
export const PIPELINE_TRACK_AROUND_LIMIT = 200

/** The least-wrong macro tier for a class the macro map does not know. The
 *  operator corrects it; what must not happen is the raw string being
 *  promoted into the macro tier. */
const FALLBACK_MACRO_CLASS: RetrainMacroClass = 'person'

/** The box recorded with a media row — detection-frame pixels (D510). */
export interface FrameSubjectBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly frameWidth: number
  readonly frameHeight: number
}

/** What a frame contributes to the pairing. */
export interface PipelineBoxFrame {
  readonly deviceId: number
  /** Absent on a recording still. */
  readonly trackId?: string
  /** When the camera captured it. Absent ⇒ only a recorded subject box can place anything. */
  readonly capturedAt?: number
}

export interface PipelineBoxInput {
  readonly frame: PipelineBoxFrame
  /** The copy's own track, when it has one and it still exists. */
  readonly ownTrack: Track | null
  /** The subject box on the copy's SOURCE media row, when one was recorded. */
  readonly ownSubjectBox: FrameSubjectBox | null
  /** The subject a notification verdict froze on this still (a still has no track of its own). */
  readonly verdictSubject?: RetrainVerdictSubject
  /** Tracks of the camera around the capture time. The own track may be among them. */
  readonly neighbours: readonly Track[]
  readonly toleranceMs?: number
}

/** The macro / label tiers for a class the pipeline (or a detector) produced. */
export interface RetrainClassTiers {
  readonly macroClass: RetrainMacroClass
  readonly label?: string
}

/**
 * Split a detector's class into the two tiers.
 *
 * A macro class stays in the macro tier; anything else maps through the COCO
 * macro map, and the class itself becomes the LABEL. A macro word is never a
 * label, in any casing — the tier rule the annotation write enforces.
 */
export function toRetrainClassTiers(
  className: string,
  label: string | undefined,
): RetrainClassTiers {
  const cls = className.trim().toLowerCase()
  const usableLabel = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim()
    if (trimmed === undefined || trimmed === '') return undefined
    return isRetrainMacroClass(trimmed.toLowerCase()) ? undefined : trimmed
  }
  if (isRetrainMacroClass(cls)) {
    const kept = usableLabel(label)
    return kept !== undefined ? { macroClass: cls, label: kept } : { macroClass: cls }
  }
  const mapped = COCO_TO_MACRO.mapping[cls]
  const macroClass =
    mapped !== undefined && isRetrainMacroClass(mapped) ? mapped : FALLBACK_MACRO_CLASS
  const kept = usableLabel(className)
  return kept !== undefined ? { macroClass, label: kept } : { macroClass }
}

/** A verdict on the wire: the operator's class split into tiers once, here. */
export function toRetrainVerdict(input: {
  readonly verdict: RetrainVerdict['verdict']
  readonly trackId: string
  readonly suggestedClass?: string | undefined
  readonly at?: number | undefined
}): RetrainVerdict {
  const tiers =
    input.suggestedClass !== undefined ? toRetrainClassTiers(input.suggestedClass, undefined) : null
  return {
    verdict: input.verdict,
    trackId: input.trackId,
    ...(input.suggestedClass !== undefined ? { suggestedClass: input.suggestedClass } : {}),
    ...(tiers !== null ? { suggestedMacroClass: tiers.macroClass } : {}),
    ...(tiers?.label !== undefined ? { suggestedLabel: tiers.label } : {}),
    ...(input.at !== undefined ? { at: input.at } : {}),
  }
}

interface Normalised {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A pixel box as a clamped normalised one, or `null` when nothing is left. */
function normalise(
  box: { readonly x: number; readonly y: number; readonly w: number; readonly h: number },
  frameWidth: number | undefined,
  frameHeight: number | undefined,
): Normalised | null {
  if (frameWidth === undefined || frameHeight === undefined) return null
  if (!(frameWidth > 0) || !(frameHeight > 0)) return null
  const x = clampSpan(box.x, box.w, frameWidth)
  const y = clampSpan(box.y, box.h, frameHeight)
  if (x === null || y === null) return null
  return { x: x.start, y: y.start, w: x.size, h: y.size }
}

/** One axis of a pixel box, normalised and clamped into `[0,1]`. The size is
 *  divided directly when nothing was clamped, so an exact box stays exact. */
function clampSpan(
  start: number,
  size: number,
  extent: number,
): { readonly start: number; readonly size: number } | null {
  const lo = start / extent
  const hi = (start + size) / extent
  const s = Math.max(0, lo)
  const n = lo >= 0 && hi <= 1 ? size / extent : Math.min(1, hi) - s
  return n > 0 ? { start: s, size: n } : null
}

type TrackPosition = Track['positions'][number]

function nearestPosition(
  track: Track,
  at: number,
  tolerance: number,
): { readonly position: TrackPosition; readonly deltaMs: number } | null {
  let best: TrackPosition | null = null
  let bestDelta = Number.POSITIVE_INFINITY
  for (const p of track.positions) {
    const delta = Math.abs(p.timestamp - at)
    if (delta < bestDelta) {
      best = p
      bestDelta = delta
    }
  }
  if (best === null || bestDelta > tolerance) return null
  return { position: best, deltaMs: bestDelta }
}

function boxFor(
  track: Track,
  bbox: Normalised,
  basis: RetrainPipelineBox['basis'],
  deltaMs: number,
  score: number | undefined,
): RetrainPipelineBox {
  const tiers = toRetrainClassTiers(track.className, track.label)
  const subLabel = track.subLabel?.trim()
  return {
    bbox,
    macroClass: tiers.macroClass,
    ...(tiers.label !== undefined ? { label: tiers.label } : {}),
    ...(subLabel !== undefined && subLabel !== '' && !isRetrainMacroClass(subLabel.toLowerCase())
      ? { subLabel }
      : {}),
    ...(score !== undefined ? { score } : {}),
    ...(track.modelId !== undefined ? { modelId: track.modelId } : {}),
    trackId: track.trackId,
    basis,
    deltaMs,
  }
}

/** The box a notification verdict froze, or `null` when the event carried none. */
function boxOfVerdict(subject: RetrainVerdictSubject): RetrainPipelineBox | null {
  const box = subject.bbox
  if (box === undefined) return null
  const clamped = normalise(box, 1, 1)
  if (clamped === null) return null
  const tiers = toRetrainClassTiers(subject.className, subject.label)
  return {
    bbox: clamped,
    macroClass: tiers.macroClass,
    ...(tiers.label !== undefined ? { label: tiers.label } : {}),
    trackId: subject.trackId,
    basis: 'verdict',
    deltaMs: 0,
  }
}

/** The own track's box: the recorded subject box first, the nearest position second. */
function ownBox(input: PipelineBoxInput, tolerance: number): RetrainPipelineBox | null {
  const track = input.ownTrack
  if (track === null) return null
  const at = input.frame.capturedAt
  const nearest = at !== undefined ? nearestPosition(track, at, tolerance) : null
  if (input.ownSubjectBox !== null) {
    const recorded = normalise(
      input.ownSubjectBox,
      input.ownSubjectBox.frameWidth,
      input.ownSubjectBox.frameHeight,
    )
    if (recorded !== null) return boxFor(track, recorded, 'subject-box', 0, nearest?.position.score)
  }
  if (nearest === null) return null
  const placed = normalise(nearest.position.bbox, track.frameWidth, track.frameHeight)
  return placed === null
    ? null
    : boxFor(track, placed, 'position', nearest.deltaMs, nearest.position.score)
}

/**
 * Every box the pipeline had on this frame, own track first. Pure.
 */
export function pipelineBoxesForFrame(input: PipelineBoxInput): readonly RetrainPipelineBox[] {
  const tolerance = input.toleranceMs ?? PIPELINE_BOX_TOLERANCE_MS
  const out: RetrainPipelineBox[] = []
  const own = ownBox(input, tolerance)
  if (own !== null) out.push(own)
  const verdictBox = input.verdictSubject !== undefined ? boxOfVerdict(input.verdictSubject) : null
  if (verdictBox !== null) out.push(verdictBox)
  const at = input.frame.capturedAt
  if (at === undefined) return out
  const ownId = input.frame.trackId
  const seen = new Set<string>(ownId !== undefined ? [ownId] : [])
  // The notified track is already drawn, from the frozen box: a neighbour read
  // of the same track (it may still be alive) must not draw it twice.
  if (input.verdictSubject !== undefined) seen.add(input.verdictSubject.trackId)
  for (const track of input.neighbours) {
    if (seen.has(track.trackId) || track.deviceId !== input.frame.deviceId) continue
    seen.add(track.trackId)
    const nearest = nearestPosition(track, at, tolerance)
    if (nearest === null) continue
    const placed = normalise(nearest.position.bbox, track.frameWidth, track.frameHeight)
    if (placed === null) continue
    out.push(boxFor(track, placed, 'position', nearest.deltaMs, nearest.position.score))
  }
  return out
}
