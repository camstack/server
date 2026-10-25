/**
 * What a clip tile SHOWS — and why, when it shows nothing.
 *
 * Three mutually exclusive shapes arrive on a `Clip` (D549 decision 5):
 *
 *  - `thumbnail` — VOUCHED. A JPEG is already on disk. Stamping this from a
 *    URL template once pointed 35 % of one camera's tiles at a 404, which is
 *    why it now means "confirmed", not "probably".
 *  - `thumbnailMint` — an OFFER. A route that MAY produce a still, asked only
 *    for rows actually on screen. It answers 200 with the image, or **204**
 *    with a refusal.
 *  - `thumbnailUnavailable.reason` — the provider already knows no mint can
 *    succeed now, so the tile draws the reason instead of firing a request.
 *
 * A clip that carries NONE of the three is its own case and says so. Falling
 * through to an empty grey box is the "we did not look" ambiguity the whole
 * vouching rule exists to remove, and a box is indistinguishable from a
 * loading one.
 *
 * ## "Not yet" and "never" are two answers (D563)
 *
 * The 204 carries a CODE (`x-camstack-reason-code`), the camera's own PROSE
 * (`x-camstack-reason`) and a DISPOSITION (`x-camstack-disposition`). Only the
 * disposition decides whether the tile comes back — this file does not
 * classify codes, because a client that pattern-matches a server's words
 * drifts the first time a word changes, and it already had: the route sends
 * `queue-full: 16 thumbnail mints already waiting for host …` while the table
 * below was keyed by the bare token, so on the live hub EVERY refusal rendered
 * as `Refused: <prose>` — measured on 592, 43 of the 60 tiles of one page.
 *
 * A missing or unrecognised disposition is FINAL. That is not a guess, it is
 * the old behaviour: an addon built before D563 sends no such header and its
 * tiles latch exactly as they used to, instead of gaining a retry loop nobody
 * tested against that build.
 */
import type { Clip } from '@camstack/types'
import { defaultUiText, type UiTextFn } from '../../contexts/ui-text.js'

/** The five things a tile can be. */
export type ClipTileMedia =
  | { readonly kind: 'vouched'; readonly url: string }
  | { readonly kind: 'mint'; readonly url: string }
  /** The still is QUEUED. The tile shows loading and comes back, under a
   *  bound — `text` is what it says if the bound runs out. */
  | {
      readonly kind: 'deferred'
      readonly reason: string
      readonly text: string
      readonly retryAfterMs: number | null
    }
  | { readonly kind: 'unavailable'; readonly reason: string; readonly text: string }
  | { readonly kind: 'none'; readonly text: string }

/** A 204, as its three headers arrived. `undefined` where a header was absent
 *  — which is a real case, not a defect: an addon older than D563 sends only
 *  the prose. */
export interface MintRefusalHeaders {
  readonly code: string | undefined
  readonly reason: string
  readonly disposition: string | undefined
  readonly retryAfterMs?: number | null
}

/**
 * Why no still exists, in words, keyed by the refusal CODE.
 *
 * A code this table does not know falls back to the provider's own prose, so a
 * firmware inventing a refusal reaches the operator rather than becoming a
 * blank tile.
 */
const REFUSAL_TEXT: Readonly<Record<string, (reason: string, t: UiTextFn) => string>> = {
  sleeping: (_reason, t) =>
    t('uiLibrary.clipTile.refusal.sleeping', 'The camera is asleep — a still would cost a wake'),
  // The ONE code whose meaning is not in the code: a 400 from a Baichuan
  // CoverPreview is explained by the camera's sentence and by nothing else,
  // so the prose is carried through instead of being summarised away.
  'camera-refused': (reason, t) =>
    t('uiLibrary.clipTile.refusal.camera_refused', 'The camera refused — {{reason}}', { reason }),
  'no-keyframe': (_reason, t) =>
    t('uiLibrary.clipTile.refusal.no_keyframe', 'No decodable frame inside this window'),
  unsupported: (_reason, t) =>
    t('uiLibrary.clipTile.refusal.unsupported', 'This source cannot produce stills'),
  'queue-full': (_reason, t) =>
    t('uiLibrary.clipTile.refusal.queue_full', 'Waiting for the camera — its still queue is full'),
  'camera-backoff': (_reason, t) =>
    t(
      'uiLibrary.clipTile.refusal.camera_backoff',
      'The camera is resting after refusing — trying again shortly',
    ),
  'no-catalog-row': (_reason, t) =>
    t('uiLibrary.clipTile.refusal.no_catalog_row', 'This clip is no longer in the catalog'),
  'unknown-device': (_reason, t) =>
    t('uiLibrary.clipTile.refusal.unknown_device', 'This camera is not served here'),
  'uid-missing': (_reason, t) =>
    t('uiLibrary.clipTile.refusal.uid_missing', 'The camera’s id is not known yet'),
}

function wordsFor(code: string | undefined, reason: string, t: UiTextFn): string {
  const known = code === undefined ? undefined : REFUSAL_TEXT[code]
  return known === undefined ? reason : known(reason, t)
}

function refusal(reason: string, t: UiTextFn, code?: string): ClipTileMedia {
  return { kind: 'unavailable', reason, text: wordsFor(code, reason, t) }
}

/** What to draw for one clip's tile. */
export function resolveTileMedia(clip: Clip, t: UiTextFn = defaultUiText): ClipTileMedia {
  if (clip.thumbnail !== undefined) return { kind: 'vouched', url: clip.thumbnail }
  if (clip.thumbnailUnavailable !== undefined)
    return refusal(clip.thumbnailUnavailable.reason, t, clip.thumbnailUnavailable.reason)
  if (clip.thumbnailMint !== undefined) return { kind: 'mint', url: clip.thumbnailMint }
  return {
    kind: 'none',
    text: t('uiLibrary.clipTile.noStill', 'This clip carries no still and offered none'),
  }
}

/**
 * A 204, as something the tile can draw.
 *
 * `deferred` is the ONLY answer that comes back, and only because the server
 * said so. Everything else — an unknown disposition, an absent one, a code
 * this build has never heard of — is final, so the failure mode of a
 * vocabulary that moves is a tile that stops early, never one that asks for
 * ever.
 */
export function describeRefusal(
  headers: MintRefusalHeaders,
  t: UiTextFn = defaultUiText,
): ClipTileMedia {
  if (headers.disposition === 'deferred') {
    return {
      kind: 'deferred',
      reason: headers.reason,
      text: wordsFor(headers.code, headers.reason, t),
      retryAfterMs: headers.retryAfterMs ?? null,
    }
  }
  return refusal(headers.reason, t, headers.code)
}
