/**
 * The frame-space error term: where the subject's centre sits relative to the
 * centre of the frame, normalized to ±0.5 on each axis.
 *
 * ## There is no letterbox to discount here, and that was checked
 *
 * The detector runs on a 640×640 `fit: 'contain'` view
 * (`SPLIT_DETECTION_VIEW`, `packages/addon-pipeline/src/pipeline-runner/
 * index.ts`), so the raster the model sees IS letterboxed. The coordinates that
 * reach this module are not: `ObjectDetection.bbox` is documented — and
 * produced — as "absolute pixel coordinates in the SOURCE frame"
 * (`packages/types/src/types/detection.ts`), and the same payload carries the
 * `frameWidth` / `frameHeight` those pixels are expressed in
 * (`PipelineAnalyticsFrameTrackedPayload`). The un-letterboxing has already
 * happened upstream; doing it again here would double-count the bars.
 *
 * ## A geometry we cannot read is `null`, never centred (D393)
 *
 * A frame that arrives with a zero or non-finite width has not told us the
 * subject is centred — it has told us nothing. Folding that into `{x:0, y:0}`
 * would read as "perfectly on target" and silence the loop exactly when it
 * should complain, the same shape as the unreadable `statfs` folded into "0
 * bytes of headroom". The return type says so, and every caller must branch.
 */

/** Signed offset of the subject's centre from the frame centre, in fractions
 *  of the frame: `-0.5` = hard left/top edge, `0` = centred, `+0.5` = hard
 *  right/bottom edge. `y` grows DOWNWARD, as image coordinates do. */
export interface NormalizedError {
  readonly x: number
  readonly y: number
}

/** The frame the bbox's pixels are expressed in. */
export interface FrameGeometry {
  readonly frameWidth: number
  readonly frameHeight: number
}

/** Absolute-pixel box in the source frame (`ObjectDetection.bbox`). */
export interface FrameBox {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

function isPositiveFinite(value: number): boolean {
  return Number.isFinite(value) && value > 0
}

function isFiniteBox(box: FrameBox): boolean {
  return (
    Number.isFinite(box.x) &&
    Number.isFinite(box.y) &&
    Number.isFinite(box.width) &&
    Number.isFinite(box.height)
  )
}

/**
 * Error of one subject box against the frame centre.
 *
 * `null` when the frame geometry or the box is unreadable — never a centred
 * zero (D393).
 */
export function computeNormalizedError(
  box: FrameBox,
  geometry: FrameGeometry,
): NormalizedError | null {
  if (!isPositiveFinite(geometry.frameWidth) || !isPositiveFinite(geometry.frameHeight)) return null
  if (!isFiniteBox(box)) return null
  const centreX = box.x + box.width / 2
  const centreY = box.y + box.height / 2
  return {
    x: centreX / geometry.frameWidth - 0.5,
    y: centreY / geometry.frameHeight - 0.5,
  }
}
