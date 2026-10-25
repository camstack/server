/**
 * semantic-promotion — offer a RECOGNITION-bearing frame to the best-frame
 * ranking with the SEMANTIC tier bit, and re-fire the best-shot captures when
 * it wins (D-semantic-bestshot, 2026-08-21).
 *
 * Why it exists: the per-frame best-shot decision (`buildSnapshotTargets`)
 * runs BEFORE any recognition result exists for that frame — face / plate /
 * classification all arrive over the async detail plane. So the frame that
 * PROVED something about the subject (a face auto-matched, a plate read
 * attributed, a fine classification accepted) was ranked on confidence alone
 * and routinely lost to a bigger-but-anonymous view: track 3892b82b…
 * (2026-08-21) held its ONE face-bearing frame while the best shot showed the
 * subject from the back. This module is the attribution-time RE-SCORE: the
 * same ranking, the same geometry helpers, plus the semantic tier — and, when
 * the recognition frame becomes the new best and its pixels are still
 * reachable (the detail plane's `frameHandle`), the boxed `thumbnail` +
 * native `keyFrame` captures re-fire from that frame.
 *
 * Tier position is deliberate: SEMANTIC sits BELOW square-containment (a
 * semantic frame whose delivered square shows background must not win — track
 * ec0eb76d…) and ABOVE the edge tier. Both orderings live in `edge-clear.ts`;
 * this module only composes the observation.
 *
 * No second derivation: the geometry terms come from the SAME pure helpers
 * the per-frame path uses, over the SAME subject bbox the detail plane
 * already carries (`TrackDetailFrame.bbox` / the recognizer's candidate bbox).
 */

import type { FrameHandle, IScopedLogger } from '@camstack/types'
import {
  canvasFillFraction,
  centralSquareContainmentFraction,
} from '../../shared/frame/wide-central-square-crop.js'
import { isPlausibleThumbnailBox } from '../best-thumbnail-guard.js'
import {
  bboxCenterScore,
  bboxContainment,
  bboxSizeScore,
  isEdgeClear,
  type PixelBox,
} from './edge-clear.js'

/**
 * What the frame proved.
 *
 * `face` is an IDENTIFIED face (the gallery auto-match); `face-visible` is a
 * face resolved well enough to identify but belonging to nobody in the gallery
 * (D406). Both carry the semantic tier — the operator's ask is that the best
 * shot SHOW the face.
 */
export type SemanticRecognitionKind = 'face' | 'face-visible' | 'plate' | 'classification'

/** A frame on which a recognition SUCCEEDED, as the attribution path saw it. */
export interface SemanticRecognitionFrame {
  readonly deviceId: number
  readonly trackId: string
  /** The recognition frame's own timestamp (the detail plane's frame clock). */
  readonly timestamp: number
  /** SUBJECT (person / vehicle) bbox in frame-space px — the same box the
   *  per-frame best-shot ranking scores. */
  readonly bbox: PixelBox
  readonly frameWidth: number
  readonly frameHeight: number
  readonly kind: SemanticRecognitionKind
  /** The recognition's own score (match cosine / OCR score / classifier). */
  readonly score: number
  /** Subject detection confidence — the ranking's within-tier term. */
  readonly confidence: number
  /** Live shm handle of the recognition frame, when the detail plane still
   *  carries it. Absent ⇒ the pixels are gone: the ranking is still promoted
   *  (a later worse frame can no longer displace this peak) but no capture
   *  can re-fire — logged, never silent. */
  readonly frameHandle?: FrameHandle
}

/** The detail-plane result fields the attribution-path promotion reads. */
export interface DetailAttributionResult {
  readonly className: string
  /** The recognition's own score (OCR score / classifier confidence). */
  readonly score: number
  /**
   * The DETAIL box (the plate / face / classified region itself). Carried so
   * the contract is visible at the seam — and used for NOTHING. The promotion
   * ranks and crops the SUBJECT box only: feeding this box into the ranking is
   * what stored a plate-only `thumbnail` for tracks c5c628f4, 98fc38ce and
   * bac368e2 on 2026-08-28 (the operator's "best shot la targa, manca l'auto" [best shot the plate, the car is missing])
   * — the best-seen bbox was poisoned at `recordBestSeenBbox` and the
   * close-time keyFrame derive cut the plate out of a keyFrame that held the
   * whole car (D276).
   */
  readonly bbox?: PixelBox
}

/** The detail-plane frame the attribution rode in on (subject-side fields). */
export interface DetailAttributionFrame {
  /** SUBJECT (person / vehicle) bbox in frame-space px. */
  readonly bbox: PixelBox
  readonly timestamp: number
  readonly frameWidth: number
  readonly frameHeight: number
  /** Subject detection confidence (the ranking's within-tier term). */
  readonly confidence: number
  readonly frameHandle?: FrameHandle
}

/**
 * Compose the {@link SemanticRecognitionFrame} for a plate read / accepted
 * fine classification. ONE rule, enforced here rather than at the call site:
 * the promoted `bbox` is ALWAYS the SUBJECT box (`frame.bbox`), never the
 * detail box — see {@link DetailAttributionResult.bbox} for what feeding the
 * detail box cost. The face path (`face-recognizer.ts` `onSemanticMatch`)
 * already passes its body box; this keeps the plate/classification path on the
 * same discipline.
 */
export function semanticFrameForDetailAttribution(
  deviceId: number,
  trackId: string,
  detail: DetailAttributionResult,
  frame: DetailAttributionFrame,
): SemanticRecognitionFrame {
  return {
    deviceId,
    trackId,
    timestamp: frame.timestamp,
    bbox: { x: frame.bbox.x, y: frame.bbox.y, w: frame.bbox.w, h: frame.bbox.h },
    frameWidth: frame.frameWidth,
    frameHeight: frame.frameHeight,
    kind: detail.className === 'plate' ? 'plate' : 'classification',
    score: detail.score,
    confidence: frame.confidence,
    ...(frame.frameHandle !== undefined ? { frameHandle: frame.frameHandle } : {}),
  }
}

/** One semantic observation, fully composed for the resident-state ranking. */
export interface SemanticBestFrameObservation {
  readonly deviceId: number
  readonly trackId: string
  readonly confidence: number
  readonly timestamp: number
  readonly edgeClear: boolean
  readonly centerScore: number
  readonly containment: number
  readonly sizeScore: number
  readonly squareFraction: number
  readonly semantic: true
  /** D400 delivered-canvas fill of this frame — a bounded within-tier factor,
   *  supplied on every ranked path so a semantic frame is compared on the same
   *  terms as a per-frame one. */
  readonly canvasFill: number
}

/** The best-seen bbox record the ranking keeps for retry/close crops. */
export interface SemanticBestSeenBbox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
  readonly frameWidth: number
  readonly frameHeight: number
  readonly timestamp: number
}

/** Capture request for the winning semantic frame (thumbnail + keyFrame). */
export interface SemanticCaptureRequest {
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly bbox: PixelBox
  readonly frameWidth: number
  readonly frameHeight: number
  readonly frameHandle: FrameHandle
}

/** Structural deps — `index.ts` wires the resident state + capture paths. */
export interface SemanticPromotionDeps {
  /** `TrackResidentState.observeBestFrame` with the semantic bit. Returns true
   *  when the frame becomes the track's new best. */
  observeBestFrame(observation: SemanticBestFrameObservation): boolean
  /** `TrackResidentState.recordBestSeenBbox` (retry gate + close-time crop). */
  recordBestSeenBbox(deviceId: number, trackId: string, bbox: SemanticBestSeenBbox): void
  /** Re-fire the boxed `thumbnail` + native `keyFrame` captures from the
   *  recognition frame. Only invoked when the frame won the ranking, its box
   *  is plausible, and a live handle exists. */
  captureBestShot(request: SemanticCaptureRequest): void
  readonly logger: IScopedLogger
}

/** What the promotion did — for the caller's logging/telemetry. */
export interface SemanticPromotionOutcome {
  /** The frame became the track's new best (ranking updated). */
  readonly promoted: boolean
  /** The best-shot captures were re-fired from the recognition frame. */
  readonly captured: boolean
}

/**
 * Offer the recognition frame to the best-frame ranking with the semantic
 * tier. On a win: record the best-seen bbox (plausible boxes only — an
 * envelope-exploded box must not poison the retry reference, mirroring
 * `buildSnapshotTargets`) and re-fire the captures when the pixels are still
 * reachable.
 */
export function promoteSemanticBestFrame(
  deps: SemanticPromotionDeps,
  input: SemanticRecognitionFrame,
): SemanticPromotionOutcome {
  const { deviceId, trackId, bbox, frameWidth, frameHeight, timestamp } = input
  const promoted = deps.observeBestFrame({
    deviceId,
    trackId,
    confidence: input.confidence,
    timestamp,
    edgeClear: isEdgeClear({ bbox, frameWidth, frameHeight }),
    centerScore: bboxCenterScore(bbox, frameWidth, frameHeight),
    containment: bboxContainment(bbox, frameWidth, frameHeight),
    sizeScore: bboxSizeScore(bbox, frameWidth, frameHeight),
    squareFraction: centralSquareContainmentFraction(bbox, {
      W: frameWidth,
      H: frameHeight,
    }),
    semantic: true,
    canvasFill: canvasFillFraction(bbox, { W: frameWidth, H: frameHeight }),
  })
  if (!promoted) {
    // Held best already semantic-and-better, or this frame is square-evicted
    // against a contained peak — the ranking refused, nothing to capture.
    deps.logger.debug('best-shot: semantic frame did not beat the held peak', {
      tags: { deviceId },
      meta: { trackId, kind: input.kind, score: input.score, timestamp },
    })
    return { promoted: false, captured: false }
  }
  const plausible = isPlausibleThumbnailBox(bbox, frameWidth, frameHeight, input.confidence)
  if (plausible) {
    deps.recordBestSeenBbox(deviceId, trackId, {
      x: bbox.x,
      y: bbox.y,
      w: bbox.w,
      h: bbox.h,
      frameWidth,
      frameHeight,
      timestamp,
    })
  }
  if (!plausible || input.frameHandle === undefined) {
    // A branch that DROPS work (the capture) says so: the ranking now holds
    // the semantic peak, but the stored best shot could not be re-captured —
    // either the box is implausible (envelope-exploded) or the recognition
    // arrived after the frame's pixels were gone.
    deps.logger.info('best-shot: semantic promotion without capture', {
      tags: { deviceId },
      meta: {
        trackId,
        kind: input.kind,
        score: input.score,
        timestamp,
        reason: plausible ? 'no frame handle' : 'implausible box',
      },
    })
    return { promoted: true, captured: false }
  }
  deps.captureBestShot({
    deviceId,
    trackId,
    timestamp,
    bbox,
    frameWidth,
    frameHeight,
    frameHandle: input.frameHandle,
  })
  deps.logger.info('best-shot: semantic promotion', {
    tags: { deviceId },
    meta: { trackId, kind: input.kind, score: input.score, timestamp },
  })
  return { promoted: true, captured: true }
}
