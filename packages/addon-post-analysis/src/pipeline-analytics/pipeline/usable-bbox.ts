/** A box that can legally drive a crop. The leaving-event fallback
 *  `{0,0,0,0}` must never become a face/plate JPEG. */
export function isUsableBbox(bbox: { readonly w: number; readonly h: number }): boolean {
  return bbox.w > 0 && bbox.h > 0
}
