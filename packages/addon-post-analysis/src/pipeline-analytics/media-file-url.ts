/**
 * media-file-url — the ONE place a media row becomes a fetchable URL, and the
 * ONE place a stored row becomes a wire row.
 *
 * ## Why this is a module and not a template literal at three call sites
 *
 * There were already four hand-rolled copies of `/addon/pipeline-analytics/
 * event-media` — one in the addon (`withMediaUrl`), one in the search-hit
 * resolver, one in the admin UI (`authed-media.ts`) and one in the viewer
 * (`event-media-url.ts`), plus a fifth in the embed. Two of them encoded the
 * id and two did not.
 *
 * ## Two addresses, and why there are two (D482)
 *
 * A media row is addressed by its OWN id:
 *
 *     /addon/<addonId>/event-media/m/<mediaId>
 *
 * That is what {@link mediaFileUrl} mints, and it is the only form a wire row
 * ever carries. It replaced the row's composite key
 * (`<ownerType>:<ownerId>:<fileKind>[:<ts>]`), which embedded a FOREIGN id:
 * after D474 every object event has a motion namesake numbered the same, so a
 * bare `101314` named two rows and the plane served whichever it probed first.
 *
 * The second form is not an address but a QUESTION — "the best media of this
 * owner":
 *
 *     /addon/<addonId>/event-media/o/<ownerType>/<ownerId>
 *     /addon/<addonId>/event-media/o/<eventType>/<ownerId>/g/<deviceId>/<recordAt>
 *
 * It exists because the list, reel and timeline surfaces hold no media rows at
 * all: they have a track id or an event id and an `<img>` to fill, and no
 * manifest to take an id from. (Verified on the viewer, 2026-09-12 — the
 * batch-load argument for the surrogate id holds for the track DETAIL view,
 * which fetches `listTrackMedia` once and renders every tile from the rows it
 * already holds, and does NOT hold for `EventThumb` and its siblings.)
 * `ownerType` is REQUIRED on it, which is the same correction
 * `getEventMedia` / `listEventMedia` took: an owner is `(table, id)` and half
 * of it is not a question.
 *
 * The `/g/<deviceId>/<recordAt>` suffix (D694) is the event row's GENERATION.
 * An event id is a reusable SQLite rowid; a reference that outlives the row
 * must name the camera and the event's own timestamp, or a reused id can
 * serve another record's crop. Bare `/o/<eventType>/<id>` still means "the
 * current holder of this id" (live-row lookup) — keep that spelling for
 * already-minted clients; new emitters pass {@link EventMediaGeneration}.
 *
 * Pure: no store, no I/O, no addon state. The prefix is injected.
 */

import type {
  MediaFile,
  MediaFileBytes,
  MediaFileInfo,
  MediaFileRef,
  MediaOwnerType,
} from '@camstack/types'
import { isEventOwnerType } from '@camstack/types'

/** Path segment that introduces a media-row ADDRESS. */
export const MEDIA_ID_SEGMENT = 'm'

/** Path segment that introduces an OWNER question ("best media of"). */
export const MEDIA_OWNER_SEGMENT = 'o'

/**
 * Path segment that introduces an event-owner GENERATION (D694) —
 * `/g/<deviceId>/<recordAt>` after the owner id.
 */
export const MEDIA_GENERATION_SEGMENT = 'g'

/**
 * The camera and the event's own timestamp — the generation a reused event
 * rowid cannot carry alone (D694). Structurally the same facts as
 * `NcEventMediaScope`; kept here so the plane URL mint has no dependency on
 * the notification centre.
 */
export interface EventMediaGeneration {
  readonly deviceId: number
  readonly recordAt: number
}

/**
 * The plane path for one media row.
 *
 * `prefix` is `/addon/<addonId>/event-media` — a pure function of the addon
 * id, so it exists whether or not `dataPlane.serve` succeeded. A row that
 * named no address at all would be the silent drop this repo keeps paying for:
 * a client cannot tell "no bytes" from "no plane", and renders neither.
 *
 * No `encodeURIComponent`: a decimal integer has nothing to encode. That is
 * not a convenience — the old key needed encoding (its `:` separators), the
 * viewer's own copy of this route deliberately did NOT encode, and the two
 * disagreed for as long as both existed.
 */
export function mediaFileUrl(prefix: string, mediaId: number): string {
  return `${prefix}/${MEDIA_ID_SEGMENT}/${mediaId}`
}

/**
 * The plane path for "whatever media best represents this owner".
 *
 * The owner id IS encoded: a trackId is a UUID today but an owner id is an
 * arbitrary row key (the summary mosaic's is `summary-<ruleId>-<windowEndMs>`),
 * and one slash in it would silently re-cut the path.
 *
 * When `generation` is set and `ownerType` is an event table, the path carries
 * `/g/<deviceId>/<recordAt>` so a reused rowid cannot resolve another record's
 * crop. Generation is ignored (and not minted) for non-event owners — a track
 * id is random and needs none.
 */
export function mediaOwnerUrl(
  prefix: string,
  ownerType: MediaOwnerType,
  ownerId: string,
  generation?: EventMediaGeneration,
): string {
  const base = `${prefix}/${MEDIA_OWNER_SEGMENT}/${ownerType}/${encodeURIComponent(ownerId)}`
  if (generation === undefined || !isEventOwnerType(ownerType)) return base
  return `${base}/${MEDIA_GENERATION_SEGMENT}/${generation.deviceId}/${generation.recordAt}`
}

/**
 * A stored row as the wire sees it: the ref, the address, and — transitionally
 * — the bytes.
 *
 * `base64` is copied through ONLY because the deployed viewer's track-detail
 * hero still requires the field to parse a row at all. See the `MediaFile`
 * docblock in `pipeline-analytics.cap.ts`; deleting the field is a one-line
 * change here and one in the schema.
 *
 * `provenance` is deliberately NOT spread: it is store-internal, and the
 * previous `{ ...row, kind }` shape published it by accident.
 */
export function toWireMediaFile(row: MediaFileBytes, prefix: string): MediaFile {
  return {
    mediaId: row.mediaId,
    kind: row.kind,
    sizeBytes: row.sizeBytes,
    timestamp: row.timestamp,
    url: mediaFileUrl(prefix, row.mediaId),
    base64: row.base64,
  }
}

/** The same row without its bytes — the manifest shape. Carries the SAME
 *  `url` as the byte read, so a client never builds the plane path itself. */
export function toWireMediaFileInfo(row: MediaFileRef, prefix: string): MediaFileInfo {
  return {
    mediaId: row.mediaId,
    kind: row.kind,
    sizeBytes: row.sizeBytes,
    timestamp: row.timestamp,
    url: mediaFileUrl(prefix, row.mediaId),
  }
}
