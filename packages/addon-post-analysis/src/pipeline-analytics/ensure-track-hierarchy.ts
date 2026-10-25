/**
 * When a face or plate crop lands from a live handle, the owning track must
 * also get a body crop (person / vehicle) and a full frame from that same
 * handle. A tight face JPEG is not a person crop; a class icon is not a tile.
 */
import type { FrameHandle } from '@camstack/types'

export interface LiveHierarchyCapture {
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly bodyBbox: { x: number; y: number; w: number; h: number }
  readonly frameWidth: number
  readonly frameHeight: number
  readonly cropPadding: number
  readonly frameHandle: FrameHandle
}

export interface TrackHierarchyDeps {
  isThumbnailLanded(trackId: string): boolean
  isKeyFrameLanded(trackId: string): boolean
  captureBodyThumbnail(input: LiveHierarchyCapture): Promise<void>
  captureKeyFrame(input: LiveHierarchyCapture): Promise<void>
}

export async function ensureTrackHierarchyMedia(
  deps: TrackHierarchyDeps,
  input: LiveHierarchyCapture,
): Promise<void> {
  const tasks: Promise<void>[] = []
  if (!deps.isThumbnailLanded(input.trackId)) {
    tasks.push(deps.captureBodyThumbnail(input))
  }
  if (!deps.isKeyFrameLanded(input.trackId)) {
    tasks.push(deps.captureKeyFrame(input))
  }
  await Promise.all(tasks)
}
