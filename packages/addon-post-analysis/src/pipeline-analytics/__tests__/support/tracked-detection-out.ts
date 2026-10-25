import type { TrackedDetectionOut } from '../../pipeline/frame-processor.js'

/** Minimal {@link TrackedDetectionOut} for post-analysis specs. */
export function makeTrackedDetectionOut(
  patch: Partial<TrackedDetectionOut> & Pick<TrackedDetectionOut, 'trackId'>,
): TrackedDetectionOut {
  return {
    className: 'person',
    confidence: 0.9,
    bbox: { x: 0, y: 0, w: 10, h: 10 },
    zones: [],
    state: 'moving',
    matchedThisFrame: true,
    settling: false,
    confirmed: true,
    ...patch,
  }
}
