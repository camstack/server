/**
 * gallery-media-row — the wire row `faceGallery.getFaceMedia` and
 * `plateGallery.getPlateMedia` answer with.
 *
 * The two methods were byte-for-byte identical `map` bodies over
 * `listByOwner`, against two hand-copied `MediaFileLiteSchema` literals in two
 * cap files. Both inlined the crop as base64 while the row's own `key` sat
 * beside it — and both are read by exactly one caller each (the admin UI's
 * face and plate detail modals), which already rendered their key FRAME from
 * the `event-media` plane in the same dialog.
 *
 * So unlike `MediaFile.base64`, there was no deployed reader to strand: the
 * field is deleted here rather than carried, and this is the shared shape that
 * makes "deleted in one place" true of both methods.
 */

import type { MediaFileBytes } from '@camstack/types'
import { mediaFileUrl } from './media-file-url.js'

/**
 * One gallery media row: what the crop is, how big, and WHERE — never the
 * pixels.
 *
 * `kind` is a plain string rather than `MediaFileKind` because the gallery
 * schemas declare it that way (a face/plate crop is stored as `crop`, and
 * these two methods publish the stored kind verbatim — there is no relabel
 * here, unlike a track's listing).
 */
export interface GalleryMediaRow {
  /** The row's own media id (D482). */
  readonly mediaId: number
  readonly kind: string
  /** `/addon/<addonId>/event-media/m/<mediaId>`. */
  readonly url: string
  readonly sizeBytes: number
  readonly timestamp: number
}

export function toGalleryMediaRow(row: MediaFileBytes, prefix: string): GalleryMediaRow {
  return {
    mediaId: row.mediaId,
    kind: row.kind,
    url: mediaFileUrl(prefix, row.mediaId),
    sizeBytes: row.sizeBytes,
    timestamp: row.timestamp,
  }
}
