import type { FrameRef, FrameViewSpec } from '@camstack/types'
import type {
  FrameReleaseReason,
  FrameViewResolution,
  LocalFrameRegistry,
} from '../session-decode/local-frame-registry.js'

export const MOTION_FRAME_VIEW: FrameViewSpec = {
  content: { width: 320, height: 320 },
  fit: 'contain',
  format: 'gray',
}

/**
 * Materialize the motion gray view under a short-lived registry lease.
 * Release is idempotent and always runs, including miss/error.
 */
export async function resolveMotionFrameView(
  registry: LocalFrameRegistry,
  ref: FrameRef,
): Promise<FrameViewResolution> {
  const lease = registry.acquire(ref)
  if (!lease) {
    return {
      kind: 'miss',
      reason: ref.registryId === registry.registryId ? 'stale-ref' : 'foreign-registry',
    }
  }
  let reason: FrameReleaseReason = 'error'
  try {
    const view = await lease.resolve(MOTION_FRAME_VIEW)
    reason = view.kind === 'view' ? 'success' : 'drop'
    return view
  } finally {
    lease.release(reason)
  }
}
