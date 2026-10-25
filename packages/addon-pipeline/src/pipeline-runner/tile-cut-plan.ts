/**
 * WHICH subjects of a finished frame are worth a native tile, and in what
 * order — the runner's half of the tile tier.
 *
 * ## Why this is a decision and not a `map`
 *
 * The cut runs on the decode worker between two pulls, so it is bounded: a
 * frame that detected twenty subjects must not turn one late crop into twenty
 * native cuts and twenty JPEG encodes. When the bound bites, WHICH subjects
 * survive it decides which tracks can later be enriched at native resolution —
 * so the order is highest confidence first, because that is the box most likely
 * to become a confirmed track and to be asked for.
 *
 * ## Why the boxes are normalised here
 *
 * `ObjectDetection.bbox` is absolute pixels of the ANALYSIS frame (≤640 wide);
 * the worker holds the NATIVE frame (up to 4K). The only thing both sides agree
 * on is the fraction of the scene, so the runner divides by the analysis frame's
 * own dimensions and the worker multiplies by the native ones. Sending pixels
 * would be sending a number that means something different at each end — the
 * shape of mistake that put two feature spaces in one vector index once already.
 *
 * ## What this is NOT
 *
 * Not a crop derivation. The rectangle a model is fed is still derived once, by
 * `deriveDetailCropRect` through `detail-subtree.ts`
 * ([D52](../../../../docs/decisions/adr-0052.md)); these boxes only say WHERE a
 * container should be kept. The worker pads them into containers and the model
 * rectangle is cut out of one later.
 *
 * Pure: no runner state, no IPC, no pixels.
 */
import type { NormalizedBbox } from '../session-decode/video-frame-generator.js'

/** The minimal shape of a detection this planner reads. */
export interface TileCandidate {
  /** Absolute pixels of the analysis frame (`DetectionBoundingBox`). */
  readonly bbox: {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
  }
  /** The macro class's own score, as the detector emitted it. */
  readonly score: number
}

/** The frame the candidates were measured against. */
export interface TileFrameDims {
  readonly width: number
  readonly height: number
}

/**
 * Most tiles requested for ONE frame. Mirrors the worker's own cap so the
 * runner does not ship boxes the worker will discard; the worker keeps its cap
 * because it must survive a runner that predates this one.
 */
export const MAX_TILE_SUBJECTS_PER_FRAME = 4

/**
 * Normalised boxes for the subjects worth a tile, highest confidence first,
 * capped.
 *
 * Returns an empty array for a frame with no usable detections — and the caller
 * still sends it: an empty `cutTiles` is how a frame that detected nothing ends
 * its hold, which is the majority of frames and the whole reason this design
 * costs less than the one it replaces.
 *
 * A degenerate or non-finite box is DROPPED rather than clamped: a zero-area
 * container serves nothing, and a NaN one would poison the worker's geometry.
 */
export function planTileCuts(
  detections: readonly TileCandidate[],
  frame: TileFrameDims,
  maxSubjects: number = MAX_TILE_SUBJECTS_PER_FRAME,
): readonly NormalizedBbox[] {
  if (frame.width <= 0 || frame.height <= 0) return []
  const usable = detections.filter((d) => isUsable(d.bbox))
  const ordered = [...usable].sort((a, b) => b.score - a.score)
  const out: NormalizedBbox[] = []
  for (const detection of ordered.slice(0, Math.max(0, maxSubjects))) {
    const { x, y, width, height } = detection.bbox
    out.push({
      x: x / frame.width,
      y: y / frame.height,
      w: width / frame.width,
      h: height / frame.height,
    })
  }
  return out
}

function isUsable(bbox: TileCandidate['bbox']): boolean {
  const values = [bbox.x, bbox.y, bbox.width, bbox.height]
  if (!values.every((v) => Number.isFinite(v))) return false
  return bbox.width > 0 && bbox.height > 0
}
