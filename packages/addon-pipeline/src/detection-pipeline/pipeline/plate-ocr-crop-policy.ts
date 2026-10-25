/**
 * How each plate reader wants its pixels — ONE table, keyed by the reader.
 *
 * The plate-OCR step hosts two recognizers with genuinely opposite appetites,
 * and every difference below is a measured one, not a preference:
 *
 * | | `vgg_english_g2` (`ctc`) | `cct-s-v2-global` (`plate-slots`) |
 * | --- | --- | --- |
 * | margin around the ROI | none | **+5%** |
 * | rectify (quad-warp / deskew) | **yes** | no |
 * | min crop long side | 85 px | 70 px |
 *
 * `vgg_english_g2` is a generic English text recognizer. It normalises the tile
 * to a fixed 64 px height preserving aspect, so a 25°-tilted plate inside an
 * axis-aligned box arrives at ~1.6:1 instead of 4.7:1 — ~96 px of width for
 * seven glyphs. Rectifying the plate's quadrilateral is what made it readable at
 * all (D198, 0/21 → 4/21), and every pixel of margin makes its strip worse.
 *
 * `cct-s-v2-global` is a plate recognizer. It stretches whatever it is given to
 * a fixed 128×64 regardless of aspect, which is exactly how it was trained: on
 * detector boxes around tilted plates. Feeding it the rectified strip gives back
 * the old numbers (4/21); feeding it the RAW box takes it to 15/21, and the raw
 * box plus a 15% margin to 19/21 with the Kia read on 7 of 7 crops.
 *
 * The margin is a property of the DETECTOR's box, not of the reader alone.
 * Under `yolov8n-plate` (deleted, D719) it was the whole Kia story: that
 * detector drew a box that clipped the left edge of DN-RO 309, every reader
 * read "…RO309", and 15% of the box width put the D back (per-margin at the
 * shipped floor: 0.10 → 4/7 Kia, 0.13-0.16 → 7/7 with zero false positives on
 * the 18 junk ROIs, 0.25 → exact reads start dropping, 12/21).
 *
 * `yolox-tiny-plate` (the detector since D719) draws BIGGER boxes that already
 * hold the plate's edges. On top of them 15% shrank the plate inside the
 * 128×64 tile and lost ~8 readings on the 2026-10-06 evaluation set; 5%
 * reaches parity with the old detector. Change this number only together with
 * the detector, and re-measure when either moves.
 *
 * The floors differ because their jobs differ. For the CTC reader 85 px is a
 * CORRECTNESS gate — under it that recognizer produced confident garbage and the
 * plausibility gate could not tell. The slot reader's correctness gate is its
 * per-character confidence floor (`plate_slots.py`), so 70 px here only avoids
 * spending an inference on a hopeless ROI: on the cam-102 set the smallest real
 * plate arrived as a 76 px padded crop and six junk ROIs landed under 70
 * (measured with `yolov8n-plate` boxes at +15%).
 */
import type { PostprocessorType } from '@camstack/types'

import type { AbsoluteBbox } from './crop-utils.js'

export interface PlateOcrCropPolicy {
  /**
   * Fraction of the ROI's own width/height added on EACH side before cutting.
   * 0 reproduces the historical tight crop byte for byte.
   */
  readonly marginFraction: number
  /** Run `warpPlateJpeg` → `rectifyPlateJpeg` on the crop before reading it. */
  readonly rectify: boolean
  /**
   * Minimum long side (px) of the crop actually fed to the reader — measured
   * AFTER the margin, because that is the tile the recognizer sees.
   */
  readonly minLongSidePx: number
}

/**
 * Keyed by POSTPROCESSOR, not by model id: the postprocessor is what identifies
 * the reader family, it is already what the executor branches on, and a new
 * model of an existing family inherits the right pixels without touching this
 * table. A new reader family with a new postprocessor has to add a row — which
 * is the point, since it cannot be given the wrong one by default.
 */
const PLATE_OCR_CROP_POLICIES: Partial<Record<PostprocessorType, PlateOcrCropPolicy>> = {
  ctc: { marginFraction: 0, rectify: true, minLongSidePx: 85 },
  'plate-slots': { marginFraction: 0.05, rectify: false, minLongSidePx: 70 },
}

/**
 * The margin around a plate box drawn by the ROOT model (D730) — a plus catalog
 * `license_plate` read in place of `plate-detection`'s own box.
 *
 * The margin is a property of the box's detector (see above), and this
 * detector's boxes have never been measured against the plate readers: 0.15 is
 * the value that served a TIGHT detector box (the deleted `yolov8n-plate`,
 * 7/7 Kia reads at 0.13–0.16), on the assumption that plus catalog boxes are
 * tight as well. It is uncalibrated and needs measuring on a ground-truth set
 * of root-supplied plates before it is trusted; until then it applies to every
 * reader alike, replacing the reader's own detector-specific margin.
 */
export const ROOT_SUPPLIED_PLATE_MARGIN_FRACTION = 0.15

/**
 * The margin a reader cuts around its plate box: the reader's own, unless the
 * box was drawn by the root model.
 */
export function plateOcrMarginFraction(policy: PlateOcrCropPolicy, boxFromRoot: boolean): number {
  return boxFromRoot ? ROOT_SUPPLIED_PLATE_MARGIN_FRACTION : policy.marginFraction
}

/**
 * The crop policy for a step child, or `null` when the child is not a plate
 * reader at all (a face embedder, a classifier — nothing here applies to them).
 */
export function resolvePlateOcrCropPolicy(
  postprocessor: PostprocessorType,
): PlateOcrCropPolicy | null {
  return PLATE_OCR_CROP_POLICIES[postprocessor] ?? null
}

/**
 * Grow a bbox by `marginFraction` of its own size on each side, clamped to the
 * frame. Returns the input unchanged at margin 0 or on a degenerate box, so the
 * un-margined readers keep the exact pixels they had.
 */
export function expandBbox(
  bbox: AbsoluteBbox,
  marginFraction: number,
  imageWidth: number,
  imageHeight: number,
): [number, number, number, number] {
  const [x1, y1, x2, y2] = bbox
  const width = x2 - x1
  const height = y2 - y1
  if (!(marginFraction > 0) || !(width > 0) || !(height > 0)) {
    return [x1, y1, x2, y2]
  }
  return [
    Math.max(0, x1 - width * marginFraction),
    Math.max(0, y1 - height * marginFraction),
    Math.min(imageWidth, x2 + width * marginFraction),
    Math.min(imageHeight, y2 + height * marginFraction),
  ]
}
