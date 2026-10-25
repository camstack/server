/**
 * Pure remote-restream helpers shared by the session-decode acquire path
 * (`resolveSessionDecodeOwnerNodeId` / `acquireSessionDecodeRestreamFrom`) and
 * the WebRTC remote-encoded-source broker.
 *
 * These were extracted from the former `remote-source-plane.ts` when the
 * shared shm frame-handle poller (and its `RemoteSourcePlane` satellite) were
 * removed with `@camstack/shm-ring` on 2026-07-16. The class is gone; only the
 * two pure decision functions survive because the KEPT cross-node
 * session-decode acquire still needs them.
 */
import type { CamProfile, ProfileSlot, RunnerFrameSource } from '@camstack/types'

/** The remote-restream variant of the attach payload's frame source. */
export type RemoteRestreamFrameSource = Extract<RunnerFrameSource, { kind: 'remote-restream' }>

/**
 * Runner-side mode selection (pure): whether an attach payload routes this
 * camera through the remote-source leg. Absent `frameSource` (a pre-P2c
 * payload) and `local-broker` both take the co-located broker path.
 */
export function isRemoteRestream(
  frameSource: RunnerFrameSource | undefined,
): frameSource is RemoteRestreamFrameSource {
  return frameSource !== undefined && frameSource.kind === 'remote-restream'
}

/**
 * Resolve WHICH broker profile a camStream id feeds for a device (pure).
 *
 * `getStreamWithCodec` targets a PROFILE (its assigned camStream), while the
 * runner is dispatched with camStream ids (`motionStreamId` /
 * `detectionStreamId`). The broker's profile slots carry the mapping
 * (`sourceCamStreamId`); a stream no slot feeds returns `null` — the acquire
 * fails fast and the caller's backoff retries (the assignment may still be
 * propagating).
 */
export function profileForStreamId(
  slots: readonly ProfileSlot[],
  deviceId: number,
  streamId: string,
): CamProfile | null {
  for (const slot of slots) {
    if (slot.deviceId === deviceId && slot.sourceCamStreamId === streamId) return slot.profile
  }
  return null
}
