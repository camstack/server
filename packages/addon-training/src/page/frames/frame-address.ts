import type { RetrainFrame } from '@camstack/types'

/**
 * The address a frame-scoped retrain call takes: the frame's own camera, its
 * track when it has one (a recording still has none), and its id. The server
 * checks the track against the frame; the frame is the authority.
 */
export function frameAddress(frame: RetrainFrame): {
  deviceId: number
  trackId?: string
  frameId: string
} {
  return {
    deviceId: frame.deviceId,
    ...(frame.trackId !== undefined ? { trackId: frame.trackId } : {}),
    frameId: frame.frameId,
  }
}
