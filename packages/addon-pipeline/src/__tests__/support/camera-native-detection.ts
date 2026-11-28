import type { CameraNativeDetection } from '@dominevo/types'

/** Minimal {@link CameraNativeDetection} with required timestamp. */
export function makeCameraNativeDetection(
  patch: Pick<CameraNativeDetection, 'class'> & Partial<Omit<CameraNativeDetection, 'class'>>,
): CameraNativeDetection {
  return {
    timestamp: patch.timestamp ?? 1_000,
    confidence: patch.confidence,
    bbox: patch.bbox,
    class: patch.class,
  }
}
