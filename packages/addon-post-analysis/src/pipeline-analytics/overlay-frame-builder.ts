/**
 * buildOverlayDetections — per-frame synthesis of the enriched overlay
 * detections for `pipeline-analytics.frame-tracked` (two-plane re-injection).
 *
 * Roots pass through from the inference frame unchanged; matched ones gain
 * `track` info + the track's enrichment label (identity name / plate text)
 * appended to `labels` — mirroring the pre-two-plane per-parentId label
 * inheritance. For each matched track with overlay detail state, a
 * `kind:'detail'` entry (face/plate) is synthesized from the STORED FRAME-SPACE
 * bbox of the true detection — never a re-projection onto the track's current
 * bbox — and ONLY while that detail is fresh (`nowMs - capturedAt <=
 * OVERLAY_DETAIL_FRESHNESS_MS`). A stale detail is dropped rather than shown at
 * a wrong position; a periodic detail cadence keeps it fresh. `parentId` = this
 * frame's root id, stable id `detail-<trackId>-<kind>`.
 *
 * Pure + transport-free: state access is injected (overlayFor / labelFor) and
 * the current time (`nowMs`) is passed by the caller — never read inside here.
 */
import type { ObjectDetection, ScoredLabel, TrackState } from '@camstack/types'
import type { TrackedDetectionOut } from './pipeline/frame-processor.js'
import type { OverlayDetailState, PixelBbox } from './overlay-state.js'

/**
 * Max age of a stored detail before the overlay stops synthesizing it. Sized to
 * comfortably span the periodic detail cadence (face-detection re-runs ~1 s) so
 * a live track always has a fresh box, while a track that stopped producing
 * details drops its box within a couple of frames instead of pinning a ghost.
 */
export const OVERLAY_DETAIL_FRESHNESS_MS = 2500

/** Tracker row as consumed by the overlay — `state` may be absent before the first verdict. */
export type OverlayTrackedBinding = Omit<TrackedDetectionOut, 'state'> & {
  readonly state?: TrackState
}

export interface OverlayFrameInput {
  readonly frameDetections: readonly ObjectDetection[]
  readonly tracked: readonly OverlayTrackedBinding[]
  readonly overlayFor: (trackId: string) => OverlayDetailState | undefined
  readonly labelFor: (trackId: string) => string | undefined
  readonly nowMs: number
}

interface DetectionBboxWh {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function toDetectionBbox(bbox: PixelBbox): DetectionBboxWh {
  return { x: bbox.x, y: bbox.y, width: bbox.w, height: bbox.h }
}

export function buildOverlayDetections(input: OverlayFrameInput): ObjectDetection[] {
  const trackedBySourceId = new Map<string, OverlayTrackedBinding>()
  for (const t of input.tracked) {
    if (t.sourceDetectionId !== undefined) trackedBySourceId.set(t.sourceDetectionId, t)
  }

  // Kinds of REAL details already present per parent — never synthesize a dup.
  const realDetailKindsByParent = new Map<string, Set<string>>()
  for (const d of input.frameDetections) {
    if (d.kind !== 'detail' || d.parentId === undefined) continue
    const set = realDetailKindsByParent.get(d.parentId) ?? new Set<string>()
    set.add(d.macroClass)
    realDetailKindsByParent.set(d.parentId, set)
  }

  const out: ObjectDetection[] = []
  const synthesized: ObjectDetection[] = []

  for (const det of input.frameDetections) {
    const t = det.kind === 'first-level' ? trackedBySourceId.get(det.id) : undefined
    if (t === undefined) {
      out.push(det)
      continue
    }

    const name = input.labelFor(t.trackId) ?? ''
    const hasName = name.length > 0
    const alreadyLabeled = hasName && det.labels.some((l: ScoredLabel) => l.label === name)
    out.push({
      ...det,
      // The movement state travels with the box. It was computed for this
      // track on this frame and then dropped right here, which is why a parked
      // car and a walking person are drawn identically in the live overlay.
      track: {
        trackId: t.trackId,
        zones: t.zones,
        ...(t.state !== undefined ? { movementState: t.state } : {}),
      },
      labels: hasName && !alreadyLabeled ? [...det.labels, { label: name, score: 1 }] : det.labels,
    })

    const overlay = input.overlayFor(t.trackId)
    if (overlay === undefined) continue
    const realKinds = realDetailKindsByParent.get(det.id)

    const faceFresh =
      overlay.face !== undefined &&
      input.nowMs - overlay.face.capturedAt <= OVERLAY_DETAIL_FRESHNESS_MS
    if (faceFresh && overlay.face !== undefined && realKinds?.has('face') !== true) {
      synthesized.push({
        id: `detail-${t.trackId}-face`,
        kind: 'detail',
        macroClass: 'face',
        score: overlay.face.score,
        bbox: toDetectionBbox(overlay.face.bbox),
        parentId: det.id,
        labels: hasName ? [{ label: name, score: overlay.face.score }] : [],
      })
    }
    const plateFresh =
      overlay.plate !== undefined &&
      input.nowMs - overlay.plate.capturedAt <= OVERLAY_DETAIL_FRESHNESS_MS
    if (plateFresh && overlay.plate !== undefined && realKinds?.has('plate') !== true) {
      synthesized.push({
        id: `detail-${t.trackId}-plate`,
        kind: 'detail',
        macroClass: 'plate',
        score: overlay.plate.score,
        bbox: toDetectionBbox(overlay.plate.bbox),
        parentId: det.id,
        labels: [{ label: overlay.plate.text, score: overlay.plate.score }],
      })
    }
  }

  return [...out, ...synthesized]
}
