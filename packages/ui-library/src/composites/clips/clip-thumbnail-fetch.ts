/**
 * Asking a `thumbnailMint` route for a still — and hearing what it says.
 *
 * The route answers **200** with a JPEG or **204** with a refusal. An
 * `<img src>` cannot read a 204's headers: it fires `onerror` with nothing to
 * say, turning a named refusal into an anonymous broken tile. So a mint goes
 * through `fetch`.
 *
 * **Nothing is appended to the URL.** Both data-plane routes are registered
 * `access: 'authenticated'` and the hub's `/addon/<id>/<prefix>` proxy takes
 * the session cookie the admin UI sets at login, so the URL is never a
 * credential (D549 decision 22) — it may sit in history or a `Referer` and
 * open nothing.
 *
 * ## Three headers, one of which decides everything (D563)
 *
 * `x-camstack-reason-code` is the token the tile keys its words on,
 * `x-camstack-reason` is the camera's own prose, and
 * `x-camstack-disposition` says whether to come back. This module reads them;
 * it does not classify them. A response with no disposition — every
 * provider-reolink build before D563 — is FINAL, which is precisely the
 * behaviour that shipped.
 *
 * A thrown fetch is DEFERRED: nothing refused anything, one request lost a
 * race, and a tile that goes permanently blank for that is the same defect
 * with a different cause.
 */
import {
  CLIP_STILL_DISPOSITION_HEADER,
  CLIP_STILL_REASON_CODE_HEADER,
  CLIP_STILL_REASON_HEADER,
} from '@camstack/types'
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text.js'
import { describeRefusal, type ClipTileMedia, type MintRefusalHeaders } from './clip-tile-media.js'

/** The `fetch` this module uses — injected so the contract is testable. */
export type ThumbnailFetcher = (url: string, init: RequestInit) => Promise<Response>

/** A minted still, or the reason there is none. */
export type MintedThumbnail = { readonly kind: 'image'; readonly blob: Blob } | ClipTileMedia

/**
 * Ask a mint route for one still.
 *
 * Never rejects: a thrown fetch is a refusal like any other, because a tile
 * that throws is a tile that renders nothing and says nothing — the exact
 * failure this module exists to prevent.
 */
export async function fetchMintedThumbnail(
  url: string,
  fetcher: ThumbnailFetcher,
  t: UiTextFn = defaultUiText,
): Promise<MintedThumbnail> {
  let response: Response
  try {
    response = await fetcher(url, { credentials: 'same-origin' })
  } catch (err: unknown) {
    return deferredNetworkFailure(err, t)
  }
  if (response.status === 204) return describeRefusal(refusalHeadersOf(response, t), t)
  if (!response.ok) {
    return describeRefusal(
      {
        code: undefined,
        reason: t('uiLibrary.clipThumbnail.httpStatus', 'HTTP {{status}}', {
          status: String(response.status),
        }),
        disposition: undefined,
      },
      t,
    )
  }
  try {
    return { kind: 'image', blob: await response.blob() }
  } catch (err: unknown) {
    return deferredNetworkFailure(err, t)
  }
}

function refusalHeadersOf(response: Response, t: UiTextFn): MintRefusalHeaders {
  const retryAfter = response.headers.get('retry-after')
  const seconds = retryAfter === null ? Number.NaN : Number(retryAfter)
  return {
    code: response.headers.get(CLIP_STILL_REASON_CODE_HEADER) ?? undefined,
    reason:
      response.headers.get(CLIP_STILL_REASON_HEADER) ??
      t('uiLibrary.clipThumbnail.noReason', 'no reason given'),
    disposition: response.headers.get(CLIP_STILL_DISPOSITION_HEADER) ?? undefined,
    retryAfterMs: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
  }
}

function deferredNetworkFailure(err: unknown, t: UiTextFn): ClipTileMedia {
  return describeRefusal(
    {
      code: undefined,
      reason: err instanceof Error ? err.message : String(err),
      disposition: 'deferred',
    },
    t,
  )
}
