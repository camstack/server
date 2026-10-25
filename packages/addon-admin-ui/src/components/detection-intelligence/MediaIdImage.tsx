/**
 * MediaIdImage — render a media row by its OWN id (D482), off the event-media
 * data plane, with the inline base64 kept only as a fallback.
 *
 * ## Why this exists
 *
 * The gallery list endpoints (`faceGallery.listIdentities`,
 * `plateGallery.listVehicles`) resolve their cover crop server-side and inline
 * it as `coverBase64`. Measured on the live hub 2026-08-25, `listIdentities`
 * for FOUR people was 40,979 B — ~10 KB of base64 per row — and the same query
 * is mounted four times in this UI (PeopleList, UnassignedFaces,
 * PhotoEnrollDialog, the notification-rule picker) plus once in the viewer at
 * `staleTime: 30_000`. It is small per row and constant in time, which is
 * exactly the shape that costs the most: bytes × frequency.
 *
 * The row ALREADY carries `coverMediaId`, and the event-media plane's
 * `/m/<mediaId>` form resolves a row by its own id, answering
 * `Cache-Control: public, max-age=31536000, immutable` with an ETag. So the
 * URL needs no new endpoint and no new access decision.
 *
 * ## Fallback direction
 *
 * The id is preferred, `base64` is the fallback, and the fallback is only
 * REACHED when there is no id. That is the direction that cannot empty the
 * surface: a hub that stops sending `coverBase64` still sends the id, and a
 * hub too old to send an id still sends the bytes.
 */
import { type JSX } from 'react'
import { mediaIdPath, useAuthedImage } from '../../lib/authed-media.js'

export interface MediaIdImageProps {
  /** Media row id — preferred source. */
  readonly mediaId: number | undefined
  /** Inline JPEG base64 — used ONLY when `mediaId` is absent. */
  readonly base64?: string | undefined
  readonly alt: string
  readonly className?: string
  /** Rendered while loading, and when every source is exhausted. */
  readonly placeholder: JSX.Element
}

export function MediaIdImage({
  mediaId,
  base64,
  alt,
  className,
  placeholder,
}: MediaIdImageProps): JSX.Element {
  // Hooks run unconditionally; `undefined` makes this a no-op fetch.
  const { src, failed } = useAuthedImage(mediaId !== undefined ? mediaIdPath(mediaId) : undefined)

  // The plane answered — render it.
  if (src !== null) return <img src={src} alt={alt} className={className} />

  // No id, or the plane 404'd on it: fall back to whatever bytes came inline.
  const noId = mediaId === undefined
  if ((noId || failed) && base64 !== undefined && base64 !== '') {
    return <img src={`data:image/jpeg;base64,${base64}`} alt={alt} className={className} />
  }

  return placeholder
}
