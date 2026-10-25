/**
 * The `<img src>` for a plate crop — the plate twin of `faceCropSrc`.
 *
 * `cropUrl` wins: the browser caches and ETags each tile and the bytes never
 * ride the msgpack socket, where 500 inline crops are 879,403 B re-sent on
 * every 30 s poll (measured on the live hub, and 27.7 s to produce). `base64`
 * remains the fallback for a row served BEFORE `cropUrl` existed, or by a hub
 * whose addon predates it — so the switch to `includeCrops: false` can never
 * turn an old hub's gallery into a wall of placeholders.
 *
 * One resolver, because the gallery renders plates from two surfaces off one
 * query (card + detail panel). A per-component `src` expression is exactly how
 * the faces side nearly shipped a blank gallery.
 *
 * Returns `null` when the row has no crop at all — render the honest "No crop"
 * placeholder, never a broken image.
 */

/** Minimal shape needed to resolve a plate crop's image source. */
export interface CropResolvablePlate {
  readonly base64?: string
  readonly cropUrl?: string
}

export function plateCropSrc(plate: CropResolvablePlate | null | undefined): string | null {
  if (plate === null || plate === undefined) return null
  if (plate.cropUrl !== undefined && plate.cropUrl.length > 0) return plate.cropUrl
  if (plate.base64 !== undefined && plate.base64.length > 0) {
    return `data:image/jpeg;base64,${plate.base64}`
  }
  return null
}
