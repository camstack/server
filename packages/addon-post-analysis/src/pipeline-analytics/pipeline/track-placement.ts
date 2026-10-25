/**
 * WHERE a frame result was inferred — the runner node that emitted it, the
 * inference device its root ran on and the root model — as a track keeps it:
 * the frame that OPENED the track and the last sighting that CLOSED it.
 *
 * Pure. The node comes from the payload (`PipelineInferenceResultPayload.nodeId`,
 * the runner's own id); the device and the model are stamped on the frame by
 * `runPipeline` (`rootDeviceKey`, `rootModelId`). What a frame does not stamp
 * stays absent — an onboard detector names no device, a runner older than
 * `rootDeviceKey` names none either — and an unknown node yields no placement
 * at all rather than an invented one.
 */
import type { FrameResult, TrackPlacement } from '@camstack/types'

export type { TrackPlacement } from '@camstack/types'

export function trackPlacementOf(
  frame: Pick<FrameResult, 'rootModelId' | 'rootDeviceKey'>,
  nodeId: string,
): TrackPlacement | undefined {
  if (nodeId.length === 0) return undefined
  return {
    nodeId,
    ...(frame.rootDeviceKey !== undefined && frame.rootDeviceKey.length > 0
      ? { deviceKey: frame.rootDeviceKey }
      : {}),
    ...(frame.rootModelId !== undefined && frame.rootModelId.length > 0
      ? { modelId: frame.rootModelId }
      : {}),
  }
}
