/**
 * Event media data-plane handler — serves event thumbnail JPEGs over the
 * addon HTTP data-plane with ETag/immutable caching semantics.
 *
 * The handler is a pure factory: it has no references to the addon class and
 * is fully unit-testable with lightweight IncomingMessage/ServerResponse stubs.
 *
 * Public URL (via hub reverse-proxy), two forms (D482), plus an optional
 * generation on event owners (D694):
 *   /addon/<addonId>/event-media/m/<mediaId>              — one media row
 *   /addon/<addonId>/event-media/o/<ownerType>/<ownerId>  — best media OF an owner
 *   …/o/<eventType>/<ownerId>/g/<deviceId>/<recordAt>    — same question, scoped
 *     to one generation of a reusable event rowid. Bare owner form = current holder.
 *
 * The BARE id the plane used to accept is gone. It had to be, and this is the
 * whole point of the record: a bare number could name a media row or an event,
 * and after D474 an event id names one of three tables that each number from 1
 * — so the resolver probed motion, then object, then audio, and stopped at the
 * first hit. On the live hub 299 883 of 300 559 event-owned media rows are
 * motion-owned, so every object event resolved to its motion namesake and was
 * served that camera's night snapshot.
 *
 * Cache strategy:
 *   - ETag = {@link eventMediaEtag} — the row's id plus the variant, if one
 *     was rendered. See that function for why the variant is in it.
 *   - Cache-Control: public, max-age=31536000, immutable — thumbnails are
 *     write-once; they never change after creation.
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { DataPlaneHandler, MediaFileKind, MediaOwnerType } from '@camstack/types'
import { isEventOwnerType, isMediaOwnerType } from '@camstack/types'
import {
  MEDIA_GENERATION_SEGMENT,
  MEDIA_ID_SEGMENT,
  MEDIA_OWNER_SEGMENT,
  type EventMediaGeneration,
} from './media-file-url.js'

// ── Internal constants ────────────────────────────────────────────────

const CACHE_CONTROL = 'public, max-age=31536000, immutable'

/** Default / clamp bounds for the `thumb` variant edge (px). Mirrors
 *  `shared/frame/square-thumb.ts`; kept here so query parsing stays pure. */
const THUMB_DEFAULT_SIZE = 160
const THUMB_MIN_SIZE = 64
const THUMB_MAX_SIZE = 320

// ── Public types ─────────────────────────────────────────────────────

/**
 * A requested rendering of an event media blob. Absent = the stored blob
 * verbatim; `thumb` = a small center-cropped square (reel / list tiles).
 */
export interface EventMediaVariant {
  readonly kind: 'thumb'
  readonly size: number
}

export interface EventMedia {
  readonly bytes: Uint8Array
  /** The media row these bytes came from. */
  readonly mediaId: number
  /**
   * The row's stored kind.
   *
   * Its own field, and that is deliberate: the variant path needs to know a
   * `thumbnailSmall` is already a ready-to-serve square so it does not pay a
   * Sharp encode per request, and it used to learn that by looking for
   * `':thumbnailSmall'` INSIDE the composite key. A surrogate id spells
   * nothing (D482), and the fix is to carry the fact, not to smuggle it into
   * another string — one field meaning two things is the shape this record
   * exists to remove.
   */
  readonly kind: MediaFileKind
  /**
   * The variant rendered from those bytes, when one was — `null` for the
   * stored blob.
   *
   * The ETag is derived from `(mediaId, variant)` and must be: a
   * `?variant=thumb` rendering and the stored blob are different bytes at the
   * same address, and one ETag for both serves a 160px square to a client that
   * asked for the full frame.
   */
  readonly variant?: EventMediaVariant | null
  /** The owning camera, when the media row names one; `null` when it cannot. */
  readonly deviceId?: number | null
}

/**
 * The cache identity of one served body: the row it came from, plus the
 * variant rendered from it.
 *
 * One place, because the 200 and the 304 must agree character for character —
 * a conditional GET whose `If-None-Match` is built one way and compared
 * against an ETag built another way never matches, and the only symptom is
 * that every tile is re-downloaded for ever.
 */
export function eventMediaEtag(media: EventMedia): string {
  const variant = media.variant
  return variant === undefined || variant === null
    ? `"${media.mediaId}"`
    : `"${media.mediaId}|${variant.kind}${variant.size}"`
}

/**
 * What a plane path names (D482). Two things, and they are different questions:
 *
 *  - `row` — ONE media row, by its own id (`/m/<mediaId>`). The address every
 *    wire row carries.
 *  - `owner` — "the best media of this owner" (`/o/<ownerType>/<ownerId>`), for
 *    the list and reel surfaces that hold a track or event id and no media row
 *    at all. `ownerType` is required: an event is a row in one of three tables
 *    that each number from 1 since D474, and the first-hit probe that used to
 *    guess between them served a motion event's night snapshot on an
 *    afternoon object event. An event owner MAY carry
 *    `/g/<deviceId>/<recordAt>` (D694); absence means the current live holder.
 */
export type MediaAddress =
  | { readonly kind: 'row'; readonly mediaId: number }
  | {
      readonly kind: 'owner'
      readonly ownerType: MediaOwnerType
      readonly ownerId: string
      /** Present only when the path named a generation (event owners, D694). */
      readonly generation?: EventMediaGeneration
    }

/** Digits only — `Number('')` is 0 and `Number(' ')` is 0, so neither is used. */
const DIGITS = /^\d+$/
/** One run of digits, for composing the event-owner remainder pattern. */
const DIGIT_RUN = '\\d+'

/**
 * Event-owner remainder with an optional generation suffix (D694):
 * `<ownerId>` or `<ownerId>/g/<deviceId>/<recordAt>`. Owner ids for event
 * tables are decimal rowids; the generation segment is the literal `g`.
 */
const EVENT_OWNER_REMAINDER = new RegExp(
  `^(${DIGIT_RUN})(?:/${MEDIA_GENERATION_SEGMENT}/(${DIGIT_RUN})/(${DIGIT_RUN}))?$`,
)

/**
 * Read a plane path. `null` for anything that is not one of the two forms —
 * including the BARE id the plane used to accept, which is gone: a bare number
 * could be a media id or an event id, and after D474 an event id could be one
 * of three rows. Ambiguity at the door is what this record removes.
 *
 * For non-event owners the id is the whole remainder rather than one segment:
 * the hub's wildcard param is percent-decoded by find-my-way before the
 * sub-path is proxied, so a `%2F` an owner id carried would arrive here as a
 * real slash, and re-cutting on it would silently address a different owner.
 * Event owners (decimal rowids) may end with `/g/<deviceId>/<recordAt>` —
 * that suffix is the generation, not part of the id (D694).
 */
export function parseMediaAddress(rawPath: string): MediaAddress | null {
  const path = rawPath.replace(/^\/+/, '')
  const slash = path.indexOf('/')
  if (slash <= 0) return null
  const segment = path.slice(0, slash)
  const rest = path.slice(slash + 1)
  if (rest.length === 0) return null

  if (segment === MEDIA_ID_SEGMENT) {
    if (!DIGITS.test(rest)) return null
    return { kind: 'row', mediaId: Number(rest) }
  }
  if (segment !== MEDIA_OWNER_SEGMENT) return null

  const typeSlash = rest.indexOf('/')
  if (typeSlash <= 0) return null
  const ownerType = rest.slice(0, typeSlash)
  const remainder = rest.slice(typeSlash + 1)
  if (remainder.length === 0) return null
  if (!isMediaOwnerType(ownerType)) return null

  if (isEventOwnerType(ownerType)) {
    const match = EVENT_OWNER_REMAINDER.exec(remainder)
    if (match === null) return null
    const ownerId = match[1]
    const deviceIdRaw = match[2]
    const recordAtRaw = match[3]
    if (ownerId === undefined) return null
    if (deviceIdRaw !== undefined && recordAtRaw !== undefined) {
      return {
        kind: 'owner',
        ownerType,
        ownerId,
        generation: { deviceId: Number(deviceIdRaw), recordAt: Number(recordAtRaw) },
      }
    }
    return { kind: 'owner', ownerType, ownerId }
  }

  return { kind: 'owner', ownerType, ownerId: remainder }
}

/** Set by the HUB for a share-link token admitted on this plane; never by a client. */
export const SHARE_DEVICES_HEADER = 'x-camstack-share-devices'

/** The device ids a share scope allows, or `null` when the request carries no scope. */
function shareScopeDevices(headers: IncomingMessage['headers']): ReadonlySet<number> | null {
  const raw = headers[SHARE_DEVICES_HEADER]
  const value = Array.isArray(raw) ? raw.join(',') : raw
  if (value === undefined) return null
  return new Set(
    value
      .split(',')
      .map((part) => Number.parseInt(part.trim(), 10))
      .filter((id) => Number.isInteger(id) && id >= 0),
  )
}

export interface EventMediaHandlerDeps {
  /**
   * Resolve a plane {@link MediaAddress} to its bytes. When `variant` is set
   * the implementation returns the transformed bytes and ECHOES the variant on
   * the result, so {@link eventMediaEtag} can never give a square thumb the
   * same cache identity as the stored frame.
   *
   * `preferKind` (from `?kind=…`) forces a specific stored media kind — the reel
   * requests `'crop'` so a tile is always the detection crop. The implementation
   * serves that kind and, when absent, a CLEAN fallback frame — never a boxed one.
   */
  readonly getMedia: (
    address: MediaAddress,
    variant?: EventMediaVariant,
    preferKind?: string,
  ) => Promise<EventMedia | null>
}

/**
 * Parse the `?kind=…` query into a preferred stored media kind. Returns null
 * when unset. The value is a free-form kind token (e.g. `crop`); the resolver
 * validates it against the known kinds.
 */
export function parseEventMediaKind(query: string): string | null {
  const kind = new URLSearchParams(query).get('kind')
  return kind !== null && kind.length > 0 ? kind : null
}

/**
 * Parse the `?variant=…` query into an {@link EventMediaVariant}. Returns null
 * when no small-square rendering was requested (the caller then serves the
 * stored blob). Accepts `variant=thumb` or `square=1`; the edge comes from
 * `size` / `w` / `h` (clamped to [64, 320], default 160).
 */
export function parseEventMediaVariant(query: string): EventMediaVariant | null {
  const params = new URLSearchParams(query)
  const wantThumb = params.get('variant') === 'thumb' || params.get('square') === '1'
  if (!wantThumb) return null
  const sizeRaw = params.get('size') ?? params.get('w') ?? params.get('h')
  let size = THUMB_DEFAULT_SIZE
  if (sizeRaw !== null) {
    const n = Number.parseInt(sizeRaw, 10)
    if (Number.isFinite(n)) size = Math.max(THUMB_MIN_SIZE, Math.min(THUMB_MAX_SIZE, n))
  }
  return { kind: 'thumb', size }
}

// ── Factory ──────────────────────────────────────────────────────────

/**
 * Create a data-plane handler that serves event thumbnails as JPEG images.
 *
 * `deps.getMedia(address)` is called once per request. Returning `null`
 * produces a 404. On a match, the response is 200 with full ETag headers;
 * a conditional GET with a matching `If-None-Match` produces 304.
 */
export function createEventMediaHandler(deps: EventMediaHandlerDeps): DataPlaneHandler {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD' }).end()
      return
    }

    const url = req.url ?? '/'
    const qIdx = url.indexOf('?')
    const rawPath = qIdx === -1 ? url : url.slice(0, qIdx)
    const query = qIdx === -1 ? '' : url.slice(qIdx + 1)
    const address = parseMediaAddress(rawPath)
    if (address === null) {
      res.writeHead(404).end()
      return
    }

    const variant = parseEventMediaVariant(query)
    const preferKind = parseEventMediaKind(query)
    const resolveStartedAt = performance.now()

    let media: EventMedia | null = null
    try {
      media = await deps.getMedia(address, variant ?? undefined, preferKind ?? undefined)
    } catch {
      // getMedia threw — caller is responsible for logging; return an opaque 500
      const body = 'Internal server error'
      res.writeHead(500, {
        'content-type': 'text/plain',
        'content-length': String(Buffer.byteLength(body)),
        'server-timing': `resolve;dur=${(performance.now() - resolveStartedAt).toFixed(1)}`,
      })
      if (req.method !== 'HEAD') res.end(body)
      else res.end()
      return
    }

    if (media === null) {
      res
        .writeHead(404, {
          'server-timing': `resolve;dur=${(performance.now() - resolveStartedAt).toFixed(1)}`,
        })
        .end()
      return
    }

    // A share link sees its own devices only. An owner the row cannot name is
    // refused too: unknown is not "allowed" (the same rule the tRPC share
    // gate applies, fail closed).
    const scope = shareScopeDevices(req.headers)
    if (scope !== null) {
      const owner = media.deviceId ?? null
      if (owner === null || !scope.has(owner)) {
        res.writeHead(403).end()
        return
      }
    }

    const etag = eventMediaEtag(media)
    const serverTiming = `resolve;dur=${(performance.now() - resolveStartedAt).toFixed(1)}`

    if (req.headers['if-none-match'] === etag) {
      res
        .writeHead(304, {
          etag,
          'cache-control': CACHE_CONTROL,
          'server-timing': serverTiming,
        })
        .end()
      return
    }

    res.writeHead(200, {
      'content-type': 'image/jpeg',
      'cache-control': CACHE_CONTROL,
      etag,
      'content-length': String(media.bytes.byteLength),
      'server-timing': serverTiming,
    })

    if (req.method === 'HEAD') {
      res.end()
    } else {
      res.end(Buffer.from(media.bytes))
    }
  }
}
