/**
 * The confirmation crop and its re-detection with the SESSION'S detector
 * (D925). Moved out of `pipeline-analytics/index.ts` verbatim (Plan B,
 * extraction 5): the re-detect became a function of the addon context.
 */
import { type AddonContext, nodePin } from '@camstack/types'
import type { CaptureCropBbox } from '../pipeline/capture-crop.js'
import type { RedetectAnswer } from '../confirmation-gate.js'
import {
  redetectWithSessionDetector,
  type SessionDetector,
} from '../confirmation-session-detector.js'

/**
 * Padding of the CARRIED birth evidence (D379): the runner cuts it from the
 * analysis raster as the box padded 15% per side (`BIRTH_EVIDENCE_PADDING` in
 * the pipeline runner). The gate only needs it to put a secondary subject found
 * on a carried crop back into the frame, so it must equal the runner's value.
 */
export const CARRIED_EVIDENCE_PADDING = 0.15

/**
 * The native confirmation crop is a SQUARE window this many times the
 * subject's longer side, centred on it — the subject is at most a quarter of
 * the detector's input, never the 77% a 15% padding gave it.
 *
 * Measured on camera 1441 (4256×1888, `yolov9m-640-int8`), 2026-11-17, nine
 * person frames of one passage replayed through the session model, each crop
 * capped at {@link CONFIRMATION_CROP_MAX_WIDTH} and letterboxed to 640 exactly
 * as the gate does. Frames clearing the 0.4 bar, by window:
 *   box + 15% per side (the old crop) ......... 3 / 9  (track 9meh6be4xk: 0.00)
 *   square 2× long side ......................... 5 / 9
 *   square 3× long side ......................... 6 / 9
 *   square 4× long side ......................... 8 / 9  (9meh6be4xk: 0.71)
 *   square 5× / 6× long side .................... 7 / 9 , 8 / 9
 * The full frame scored the same subject 0.70 with the person ~15×45 px in the
 * input: the detector judges a subject at THAT scale, and a tight crop
 * magnified soft native pixels 1.6–2× into a view it never scores. 4 is the
 * smallest factor that recovered the passage; larger only trades the subject's
 * pixels for background.
 */
export const CONFIRMATION_CONTEXT_FACTOR = 4
/** Cap the confirmation crop width so a 4K native surface never floods the
 *  transport just to confirm one small box. EXPORTED so a test can recognise a
 *  confirmation round trip among the runner's requests by the real constant
 *  rather than by a copy of the number that would silently stop matching. */
export const CONFIRMATION_CROP_MAX_WIDTH = 320

/**
 * The FRAME-pixel window the gate's native (and fallback) crop is cut from:
 * a square of {@link CONFIRMATION_CONTEXT_FACTOR} × the box's longer side,
 * centred on the box, each side capped at the frame and slid back inside it
 * (never truncated, so the subject keeps its context on the far side). Square
 * in analysis pixels is square on the native surface: the downscale preserves
 * aspect. ONE derivation, used for the crop request AND for putting a crop-
 * relative box back into the frame (`cropRectFor`).
 */
export function confirmationCropWindow(
  bbox: CaptureCropBbox,
  frameWidth: number,
  frameHeight: number,
): CaptureCropBbox {
  const side = Math.max(bbox.w, bbox.h) * CONFIRMATION_CONTEXT_FACTOR
  const w = Math.min(side, frameWidth)
  const h = Math.min(side, frameHeight)
  const x = Math.min(Math.max(0, bbox.x + bbox.w / 2 - w / 2), frameWidth - w)
  const y = Math.min(Math.max(0, bbox.y + bbox.h / 2 - h / 2), frameHeight - h)
  return { x, y, w, h }
}

/**
 * Re-run object detection on a confirmation crop JPEG with the SESSION'S
 * detector (D925): the root model the birth's frame ran, on the device pool
 * it ran on, pinned to that frame's node — the node the crop is cut on, so
 * no new bytes cross anywhere. A session detector that cannot answer is
 * `session-device-unavailable` (no measurement, the birth defers); another
 * model is never asked. An inference failure is `null` (`redetect-error`).
 */
export async function redetectCropForConfirmation(
  ctx: AddonContext,
  detector: SessionDetector | null,
  deviceId: number,
  cropJpeg: Buffer,
): Promise<RedetectAnswer> {
  const outcome = await redetectWithSessionDetector(
    detector,
    cropJpeg,
    deviceId,
    (request, nodeId) =>
      ctx.api.pipelineExecutor.runPipeline.mutate(
        { ...request, steps: [...request.steps] },
        nodePin(nodeId),
      ),
  )
  if (outcome.error !== undefined) {
    ctx.logger.warn('confirmation gate: re-detection failed — birth deferred', {
      tags: { deviceId },
      meta: {
        error: outcome.error,
        ...(detector !== null
          ? { modelId: detector.modelId, deviceKey: detector.deviceKey, node: detector.nodeId }
          : {}),
      },
    })
  }
  return outcome.answer
}
