import type { DecodedFrame, FrameRef, FrameViewSpec } from '@camstack/types'
import type { FrameReleaseReason, LocalFrameRegistry } from './local-frame-registry.js'
import type { RetainedContentFallback } from './retained-frame-store.js'

/** Single content-sized JPEG requested after a detection, never a continuous raw. */
export const ON_DEMAND_JPEG_VIEW: FrameViewSpec = {
  content: { width: 640, height: 640 },
  fit: 'contain',
  format: 'jpeg',
}

export function createOnDemandJpegFallback(
  registry: LocalFrameRegistry,
  ref: FrameRef,
): RetainedContentFallback {
  // PARKED for a crop that arrives 2.2-9.9 s later, if at all: it keeps the
  // frame while the worker lives and never keeps the worker (D656). The read
  // itself, once `materialize` runs, is an ordinary pending read.
  const lease = registry.acquire(ref, 'retention')
  let cached: DecodedFrame | null | undefined
  let released = false
  const releaseLease = (reason: FrameReleaseReason): void => {
    if (released) return
    released = true
    lease?.release(reason)
  }
  return {
    async materialize() {
      if (cached !== undefined) return cached
      if (!lease) {
        cached = null
        return null
      }
      try {
        const view = await lease.resolve(ON_DEMAND_JPEG_VIEW)
        if (view.kind !== 'view' || view.format !== 'jpeg' || view.data.byteLength === 0) {
          cached = null
          releaseLease('drop')
          return null
        }
        cached = {
          data: Buffer.from(view.data.buffer, view.data.byteOffset, view.data.byteLength),
          width: view.width,
          height: view.height,
          format: 'jpeg',
          timestamp: ref.timestamp,
          ...(ref.capturedAt !== undefined ? { capturedAt: ref.capturedAt } : {}),
        }
        releaseLease('success')
        return cached
      } catch {
        cached = null
        releaseLease('error')
        return null
      }
    },
    release() {
      releaseLease('eviction')
    },
    holdReader() {
      if (released || cached !== undefined) return null
      const reader = registry.acquire(ref)
      return reader ? () => reader.release('success') : null
    },
  }
}
