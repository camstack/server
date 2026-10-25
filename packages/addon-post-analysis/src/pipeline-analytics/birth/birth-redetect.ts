/**
 * The confirmation crop and its re-detection with the SESSION'S detector
 * (D925). Moved out of `pipeline-analytics/index.ts` verbatim (Plan B,
 * extraction 5): the re-detect became a function of the addon context.
 */
import { type AddonContext, nodePin } from '@camstack/types'
import type { RedetectAnswer } from '../confirmation-gate.js'
import {
  redetectWithSessionDetector,
  type SessionDetector,
} from '../confirmation-session-detector.js'

/** Padding applied to a birth box before re-detecting it — a little context
 *  around the subject improves the confirmation detector's recall. */
export const CONFIRMATION_CROP_PADDING = 0.15
/** Cap the confirmation crop width so a 4K native surface never floods the
 *  transport just to confirm one small box. EXPORTED so a test can recognise a
 *  confirmation round trip among the runner's requests by the real constant
 *  rather than by a copy of the number that would silently stop matching. */
export const CONFIRMATION_CROP_MAX_WIDTH = 320

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
