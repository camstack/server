/**
 * What a frame result says about the tracks BORN on it (D646): the root model
 * that produced its boxes and the size of the frame they are measured in.
 *
 * Pure. The frame is the only witness — `rootModelId` is stamped by
 * `pipelineExecutor.runPipeline` after model resolution, and absent on a frame
 * no pipeline root produced (a camera's onboard detector), in which case the
 * track keeps NO model id rather than an invented one.
 */
import type { FrameResult } from '@camstack/types'

export interface TrackProvenance {
  readonly modelId?: string
  readonly frameWidth: number
  readonly frameHeight: number
}

export function trackProvenanceOf(
  frame: Pick<FrameResult, 'width' | 'height' | 'rootModelId'>,
): TrackProvenance | undefined {
  if (!(frame.width > 0 && frame.height > 0)) return undefined
  return {
    ...(frame.rootModelId !== undefined && frame.rootModelId.length > 0
      ? { modelId: frame.rootModelId }
      : {}),
    frameWidth: frame.width,
    frameHeight: frame.height,
  }
}
