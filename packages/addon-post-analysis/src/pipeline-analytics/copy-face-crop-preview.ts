/**
 * Copy a persisted face crop onto the owning track when the track has no
 * subject thumbnail of its own.
 *
 * Face crops live under `ownerKind: 'face'`. Events gallery tiles request
 * `?kind=thumbnailSmall` on the TRACK. A person track can therefore close
 * with `hasEmbeddedFace` and still 404 on the tile (0e343f86, 9310d1ff).
 * The face crop is already a subject-centered JPEG — reuse it rather than
 * inventing a full-frame preview.
 */
import type { MediaProvenance } from './store/media-store.js'

export interface CopyFaceCropThumbnailPut {
  readonly deviceId: number
  readonly trackId: string
  readonly timestamp: number
  readonly data: Buffer
  /** Always `standin` (D276): the copy is a DETAIL crop standing in for the
   *  subject, acceptable only while nothing better exists — the provenance is
   *  what lets the close-time derive and the late keyFrame upgrade replace it
   *  without ever touching a genuinely-ranked `native` tile. */
  readonly provenance: MediaProvenance
}

export interface CopyFaceCropPreviewStore {
  listTrackMedia(trackId: string): Promise<readonly { readonly kind: string }[]>
  putTrackThumbnail(input: CopyFaceCropThumbnailPut): Promise<number>
}

export interface CopyFaceCropPreviewInput {
  readonly deviceId: number
  readonly trackId: string
  readonly crop: Buffer
  readonly timestamp: number
}

const TRACK_PREVIEW_KINDS = new Set(['thumbnail', 'thumbnailSmall'])

export async function copyFaceCropIfTrackHasNoThumbnail(
  store: CopyFaceCropPreviewStore,
  input: CopyFaceCropPreviewInput,
): Promise<boolean> {
  const existing = await store.listTrackMedia(input.trackId)
  if (existing.some((m) => TRACK_PREVIEW_KINDS.has(m.kind))) return false
  await store.putTrackThumbnail({
    deviceId: input.deviceId,
    trackId: input.trackId,
    timestamp: input.timestamp,
    data: input.crop,
    provenance: 'standin',
  })
  return true
}
