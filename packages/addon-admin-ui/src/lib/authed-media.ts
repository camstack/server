/**
 * Shared authed-media helpers for the admin UI.
 *
 * The event-media / backup-download data planes are Bearer-token gated, but an
 * `<img>` element (or a download anchor) cannot carry an `Authorization`
 * header. These helpers fetch the bytes through the authenticated `fetch`
 * path and expose them as a blob / revocable object URL that the browser can
 * render or save. Extracted so `FaceDetailPanel`, `ArchiveList`, and the
 * upcoming event-detail views share one implementation.
 *
 * ## Two addresses (D482)
 *
 * The event-media plane takes two path forms — see `mediaFileUrl` /
 * `mediaOwnerUrl` in `addon-post-analysis/.../media-file-url.ts`, this
 * module's server-side counterpart:
 *
 *   - `<prefix>/m/<mediaId>` — one media row, by its OWN id. Use
 *     {@link mediaIdPath} whenever a row already carries a `mediaId` (or a
 *     server-minted `url` — prefer THAT over building a path at all).
 *   - `<prefix>/o/<ownerType>/<ownerId>` — "the best media of this owner",
 *     for a surface that holds only a track/event id and no media row. Use
 *     {@link mediaOwnerPath}. Event owners may also carry
 *     `/g/<deviceId>/<recordAt>` (D694); pass `generation` when the surface
 *     knows the event's camera and timestamp.
 *
 * A bare `<prefix>/<id-or-key>` (no `m/`/`o/` segment) is GONE — nothing in
 * this module builds one any more.
 */
import type { MediaOwnerType } from '@camstack/types'
import { isEventOwnerType } from '@camstack/types'
import { useEffect, useState } from 'react'
import { hubPath } from './mount'

/** The hub-ROOT route, for composing on an explicit origin (a public tunnel). */
export const EVENT_MEDIA_ROUTE = '/addon/pipeline-analytics/event-media' // hub-path-ok: composed on an explicit origin by buildMediaUrl
/** The same-origin path under this page's mount, for fetch and <img>. */
export const EVENT_MEDIA_BASE = hubPath(EVENT_MEDIA_ROUTE)
const ADMIN_TOKEN_STORAGE_KEY = 'camstack_admin_token'

/** Generation a reused event rowid needs on the plane URL (D694). */
export interface MediaOwnerGeneration {
  readonly deviceId: number
  readonly recordAt: number
}

/**
 * The plane path for one media row, by its own id.
 *
 * No `encodeURIComponent`: a decimal integer has nothing to encode — mirrors
 * `mediaFileUrl` server-side. Prefer a row's own server-minted `url` over
 * calling this at all; reach for it only when a caller has a bare `mediaId`
 * (a numeric `RetrainFrameCandidate.mediaId`, a `StationaryObject
 * .keyFrameMediaId`, …) and no ready-made URL.
 */
export function mediaIdPath(mediaId: number): string {
  return `${EVENT_MEDIA_BASE}/m/${mediaId}`
}

/**
 * The plane path for "whatever media best represents this owner" — the
 * ladder endpoint, for a surface that holds a track/event id and no media
 * row (a list tile, a search hit with no `mediaId` of its own).
 *
 * The owner id IS encoded (an arbitrary row key, e.g. a notification
 * summary's `summary-<ruleId>-<windowEndMs>`); the owner TYPE is a closed
 * enum and needs none.
 *
 * When `generation` is set and `ownerType` is an event table, appends
 * `/g/<deviceId>/<recordAt>` so a reused rowid cannot resolve another
 * record's crop (D694). Bare event paths still mean "current holder".
 */
export function mediaOwnerPath(
  ownerType: MediaOwnerType,
  ownerId: string,
  generation?: MediaOwnerGeneration,
): string {
  const base = `${EVENT_MEDIA_BASE}/o/${ownerType}/${encodeURIComponent(ownerId)}`
  if (generation === undefined || !isEventOwnerType(ownerType)) return base
  return `${base}/g/${generation.deviceId}/${generation.recordAt}`
}

/** Fetch a blob with the admin bearer token attached; throws on non-2xx. */
export async function authedFetchBlob(url: string): Promise<Blob> {
  const token = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`media fetch failed: ${String(res.status)}`)
  return res.blob()
}

/**
 * The name the server put on the download, or `null`.
 *
 * Prefers RFC 5987 `filename*=UTF-8''…` when present, because that is the form
 * that can carry a non-ASCII name; falls back to the plain `filename=`. Pure, so
 * the parsing is testable without a network.
 */
export function filenameFromDisposition(header: string | null): string | null {
  if (header === null) return null
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header)
  if (extended?.[1] !== undefined) {
    try {
      return decodeURIComponent(extended[1].trim())
    } catch {
      // A malformed encoding is not a reason to fail the download — fall through
      // to the plain form, and to the caller's fallback name after that.
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header)
  return plain?.[1]?.trim() ?? null
}

/** Give the browser a moment to start the save before the blob is released. */
const OBJECT_URL_TTL_MS = 60_000

/**
 * Download an authed data-plane URL as a file.
 *
 * Same problem as `useAuthedImage`, other half: a download anchor cannot carry
 * an `Authorization` header either, so the bytes come through `fetch` and are
 * handed to the browser as a blob. The filename comes from the server's
 * `content-disposition` when it sent one — the archive endpoints stamp a
 * timestamp into it, and re-deriving that name here would let the two drift.
 */
export async function authedDownload(url: string, fallbackName: string): Promise<void> {
  const token = localStorage.getItem(ADMIN_TOKEN_STORAGE_KEY)
  const headers: Record<string, string> = {}
  if (token) headers['Authorization'] = `Bearer ${token}`
  const res = await fetch(url, { headers })
  if (!res.ok) throw new Error(`download failed: ${String(res.status)}`)
  const blob = await res.blob()
  const name = filenameFromDisposition(res.headers.get('content-disposition')) ?? fallbackName
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = name
  anchor.click()
  // Revoked on a timer, never synchronously: releasing the blob in the same tick
  // as the click cancels the save in some browsers.
  setTimeout(() => {
    URL.revokeObjectURL(objectUrl)
  }, OBJECT_URL_TTL_MS)
}

/** Load an authed image into a revocable object URL. `{ src, failed }`, src null while loading/absent. */
export function useAuthedImage(url: string | undefined): {
  readonly src: string | null
  readonly failed: boolean
} {
  const [src, setSrc] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    setSrc(null)
    setFailed(false)
    if (!url) return
    let cancelled = false
    let objectUrl: string | null = null
    void (async () => {
      try {
        const blob = await authedFetchBlob(url)
        if (cancelled) return
        objectUrl = URL.createObjectURL(blob)
        setSrc(objectUrl)
      } catch {
        if (!cancelled) setFailed(true)
      }
    })()
    return () => {
      cancelled = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [url])
  return { src, failed }
}
