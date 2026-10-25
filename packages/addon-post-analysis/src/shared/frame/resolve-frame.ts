/**
 * `resolveFrame` — turn a serialisable `FrameHandle` back into pixels.
 *
 * Post-shm (2026-07-16): the frame is ALWAYS fetched over tRPC from the runner
 * that owns it, routed by `handle.nodeId` — same-node the call resolves
 * in-process / over UDS, cross-node over Moleculer. There is no co-located
 * `/dev/shm` read anymore (that dependency on `@camstack/shm-ring`, the last
 * native host-external in the data plane, is gone). The fetch is injected as a
 * callback so this helper stays free of any cap-client coupling and trivially
 * testable; the caller wires it to
 * `pipelineRunner.getNativeCrop({ handle, bbox:{0,0,1,1}, maxWidth }, nodePin(handle.nodeId))`.
 *
 * See `docs/design/2026-07-16-shm-removal-one-process-design.md`.
 */
import type { DecodedFrame, FrameHandle } from '@camstack/types'

export interface ResolveFrameDeps {
  /**
   * Full-frame fetch by handle, routed to the owning node. Wired by the caller
   * to the runner's full-frame `getNativeCrop`. Returns `null` when the frame
   * is no longer retained (latest-wins eviction) or the owner reports no frame.
   */
  readonly getRemoteFrame: (handle: FrameHandle) => Promise<DecodedFrame | null>
}

/**
 * Resolve the pixels a `FrameHandle` refers to via the node-routed fetch.
 * Returns `null` when the frame is no longer available.
 */
export async function resolveFrame(
  handle: FrameHandle,
  deps: ResolveFrameDeps,
): Promise<DecodedFrame | null> {
  return deps.getRemoteFrame(handle)
}
