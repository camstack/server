/**
 * Pure selection helpers for the face gallery.
 *
 * A "crop-less" face is one whose crop the server could NOT resolve — NEITHER
 * as a data-plane `cropUrl` NOR inline as `base64`.
 * (missing media blob on disk, or a pre-fix orphan buffered before the tight
 * face-crop write path existed). These render as a placeholder in the gallery
 * and are the ones an operator wants to purge in bulk.
 */

/** Minimal shape needed to decide whether a face has a resolvable crop. */
export interface CropResolvableFace {
  readonly faceId: string
  readonly base64?: string
  readonly cropUrl?: string
}

/**
 * True when the face has NO resolvable crop by either route.
 *
 * `cropUrl` must be checked first and independently: once a caller passes
 * `includeCrops: false` every row loses `base64`, and a predicate that only
 * looked there would report the entire gallery as crop-less and offer to bulk
 * DELETE it.
 */
export function isCropless(face: CropResolvableFace): boolean {
  const hasUrl = face.cropUrl !== undefined && face.cropUrl.length > 0
  const hasInline = face.base64 !== undefined && face.base64.length > 0
  return !hasUrl && !hasInline
}

/** Face ids that have no resolvable crop, preserving input order. */
export function selectCroplessFaceIds(faces: readonly CropResolvableFace[]): string[] {
  return faces.filter(isCropless).map((f) => f.faceId)
}

/** Count of faces that have no resolvable crop. */
export function countCroplessFaces(faces: readonly CropResolvableFace[]): number {
  let n = 0
  for (const f of faces) if (isCropless(f)) n += 1
  return n
}

/**
 * The `<img src>` for a face crop, or `null` when the row has no crop at all
 * (render the honest "No crop" placeholder — never a broken image).
 *
 * `cropUrl` wins: the browser caches and ETags each tile and the bytes never
 * ride the msgpack socket, where 500 inline crops are ~2.9 MiB re-sent on every
 * refetch. `base64` remains the fallback for a row served BEFORE `cropUrl`
 * existed, or by a hub whose addon predates it.
 *
 * The single resolver exists because the gallery renders faces from FOUR
 * surfaces off ONE query (card, detail panel, similar-groups rail and grid).
 * Three of them read `base64` only, so the moment the gallery asks for
 * `includeCrops: false` a per-component `src` expression turns them into a wall
 * of "No crop" placeholders. One function, one rule.
 *
 * Accepts `null`/`undefined` so a caller holding an optional face needs no
 * separate guard.
 */
export function faceCropSrc(face: CropResolvableFace | null | undefined): string | null {
  if (face === null || face === undefined) return null
  if (face.cropUrl !== undefined && face.cropUrl.length > 0) return face.cropUrl
  if (face.base64 !== undefined && face.base64.length > 0) {
    return `data:image/jpeg;base64,${face.base64}`
  }
  return null
}
