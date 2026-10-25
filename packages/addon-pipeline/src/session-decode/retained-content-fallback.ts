import type { DecodedFrame, FrameRef, FrameViewSpec } from '@camstack/types'
import type { FrameReleaseReason, LocalFrameRegistry } from './local-frame-registry.js'
import type { RetainedContentFallback } from './retained-frame-store.js'

/**
 * Honest ≤640 RAM fallback for `getNativeCrop` full-frame misses.
 * Content-sized contain (16:9 → 640×360, 4:3 → 640×480, square → 640×640),
 * never a detection default and never a cross-process ref. Task 3 owns
 * whether this rung stays after telemetry.
 */
export const RETAINED_FALLBACK_VIEW: FrameViewSpec = {
  content: { width: 640, height: 640 },
  fit: 'contain',
  format: 'rgb',
}

/** Resolve a content-sized RGB view from the process-local registry on demand. */
export function createRetainedContentFallback(
  registry: LocalFrameRegistry,
  ref: FrameRef,
): RetainedContentFallback {
  return {
    async materialize() {
      const lease = registry.acquire(ref)
      if (!lease) return null
      let reason: FrameReleaseReason = 'error'
      try {
        const view = await lease.resolve(RETAINED_FALLBACK_VIEW)
        if (view.kind !== 'view' || view.format !== 'rgb' || view.data.byteLength === 0) {
          reason = 'drop'
          return null
        }
        reason = 'success'
        return {
          data: Buffer.from(view.data.buffer, view.data.byteOffset, view.data.byteLength),
          width: view.width,
          height: view.height,
          format: 'rgb',
          timestamp: ref.timestamp,
          ...(ref.capturedAt !== undefined ? { capturedAt: ref.capturedAt } : {}),
        } satisfies DecodedFrame
      } catch {
        // The worker is gone or going (a named `SessionDecodeReadRefusedError`,
        // D656) or the read failed: a miss, which the caller counts and logs
        // (`noteMiss('fallback')`) — never a raw rejection.
        return null
      } finally {
        lease.release(reason)
      }
    },
  }
}
