import type { BoundingBox } from '@camstack/types'

/** Crop box for a late firstFrame retry: the BIRTH geometry, not the
 *  later frozen/coasted box (track 1b659d56). */
export function firstFrameRetryBbox(
  current: BoundingBox,
  birth: BoundingBox | undefined,
): BoundingBox {
  if (birth !== undefined && birth.w > 0 && birth.h > 0) return { ...birth }
  return { ...current }
}
